import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect, wait } from './helpers.js';

test('断线后仅补取缺失块，已完整块复用', async () => {
  const env = makeApp({ latencyChunkMs: 3 });
  const first = await env.api.runJob({ purpose: 'billing', simulate: { mode: 'disconnect', afterChunks: 3 } });
  const interrupted = await wait(env.api, first.jobId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(env.receiver.listChunks('billing').length, 3);
  const before = env.source.requests.length;
  const second = await collect(env.api, 'billing');
  const plan = second.started.plan;
  assert.deepEqual(plan.map((p) => p.action), ['reuse', 'reuse', 'reuse', 'fetch', 'fetch', 'fetch']);
  assert.equal(env.source.requests.length - before, 3);
  assert.equal(second.job.status, 'completed');
});

test('截断的块被丢弃，不参与拼接', async () => {
  const env = makeApp({ latencyChunkMs: 2, faults: { 'truncate:2': 0.4 } });
  const { started, job } = await collect(env.api, 'analytics');
  assert.equal(job.status, 'failed');
  const failure = job.detail;
  assert.equal(failure.code, 'E_CHUNK_TRUNCATED');
  const chunks = env.receiver.listChunks('analytics');
  assert.equal(chunks.length, 2);
  assert.ok(!chunks.some((c) => c.chunkIndex === 2));
  const dumped = JSON.stringify(job);
  assert.ok(!dumped.includes('@example.test'));
  assert.ok(!dumped.includes('138-0000'));
});

test('哈希不一致时拒绝块，错误详情不含原值', async () => {
  const env = makeApp({ latencyChunkMs: 2, faults: { 'corrupt:0': true } });
  const { job } = await collect(env.api, 'care');
  assert.equal(job.status, 'failed');
  assert.equal(job.detail.code, 'E_HASH_MISMATCH');
  assert.equal(env.receiver.listChunks('care').length, 0);
  const text = JSON.stringify(job);
  assert.ok(!text.includes('138-0000'), '失败详情不得包含电话原值');
  assert.ok(!text.includes('@example.test'), '失败详情不得包含邮箱原值');
  assert.ok(!text.includes('虚构健康标记'), '失败详情不得包含备注原值');
});

test('来源侧故障只暴露错误码与块号', async () => {
  const env = makeApp({ latencyChunkMs: 2, faults: { 'fail:3': { code: 'E_SOURCE_BUSY', message: '来源临时限流' } } });
  const { job } = await collect(env.api, 'care');
  assert.equal(job.status, 'failed');
  assert.equal(job.detail.code, 'E_SOURCE_BUSY');
  assert.equal(job.detail.detail.chunkIndex, 3);
  assert.equal(env.receiver.listChunks('care').length, 3);
});

test('范围令牌不可跨用途使用，也不能重放同一块', async () => {
  const env = makeApp({ latencyChunkMs: 1 });
  const { tokenId } = await env.api.runJob({ purpose: 'analytics' });
  await assert.rejects(env.source.fetchChunk(tokenId, 'care', 0), /不匹配/);
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(env.source.fetchChunk(tokenId, 'analytics', 5), /重放/);
});

test('撤权发生在下载中途时，下载块整块作废并清除已撤列', async () => {
  const env = makeApp({ latencyChunkMs: 30 });
  const { jobId } = await env.api.runJob({ purpose: 'care' });
  await new Promise((r) => setTimeout(r, 55));
  env.authz.setFields('care', ['customer_id', 'full_name', 'email', 'support_notes']);
  const job = await wait(env.api, jobId);
  assert.equal(job.status, 'invalidated');
  assert.equal(job.detail.code, 'E_SCOPE_REVOKED');
  assert.ok(job.detail.revokedFields.includes('phone'));
  for (const row of env.store.db.prepare("SELECT rows_json, fields_json FROM chunks WHERE purpose='care'").all()) {
    assert.ok(!JSON.parse(row.fields_json).includes('phone'));
    assert.ok(!JSON.parse(row.rows_json).some((r) => 'phone' in r));
  }
  const phoneInDb = env.store.db.prepare("SELECT rows_json FROM chunks WHERE rows_json LIKE '%138-%'").all();
  assert.equal(phoneInDb.length, 0);
});
