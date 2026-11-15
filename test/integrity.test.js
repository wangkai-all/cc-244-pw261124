import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('落盘块被篡改后不得复用，改为重新下载', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  env.store.db.prepare(
    "UPDATE chunks SET rows_json = replace(rows_json, 'C-3002', 'C-9999') WHERE purpose = 'analytics' AND chunk_index = 0"
  ).run();
  const before = env.source.requests.length;
  const { started, job } = await collect(env.api, 'analytics');
  assert.equal(job.status, 'completed');
  const plan = started.plan;
  assert.equal(plan[0].action, 'fetch', '预判阶段即识别损坏块');
  assert.equal(plan[0].code, 'E_CHUNK_CORRUPT');
  assert.ok(plan.slice(1).every((p) => p.action === 'reuse'), '其余块仍可复用');
  assert.equal(env.source.requests.length - before, 1, '只有被篡改的块被重下');
   const chunk = env.store.db.prepare("SELECT rows_json FROM chunks WHERE purpose='analytics' AND chunk_index=0").get();
  assert.ok(!chunk.rows_json.includes('C-9999'));
});

test('行宽异常视为损坏', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  env.store.db.prepare(
    "UPDATE chunks SET rows_json = replace(rows_json, '\"city\":', '\"city_note\":') WHERE purpose='analytics' AND chunk_index=2"
  ).run();
  const res = env.collector.verifyStoredChunk('analytics', 2, ['customer_id', 'city', 'plan', 'monthly_spend']);
  assert.equal(res.ok, false);
  assert.match(res.reason, /行宽|字段/);
});

test('块缺失时索引构建拒绝，提示需重新下载', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  env.store.db.prepare("DELETE FROM chunks WHERE purpose='analytics' AND chunk_index = 0").run();
  await assert.rejects(env.indexer.build({ purpose: 'analytics' }), /未下载/);
  const preview = env.api.planPreview('analytics');
  assert.equal(preview.plan[0].action, 'fetch');
  assert.equal(preview.summary.reuse, 5);
});
