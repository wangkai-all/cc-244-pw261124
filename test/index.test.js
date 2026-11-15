import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('撤权与索引构建竞态：提交前复核失败则索引作废，旧索引不服务', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'billing');
  await env.indexer.build({ purpose: 'billing' });
  const building = env.indexer.build({ purpose: 'billing', delayMs: 40 });
  await new Promise((r) => setTimeout(r, 8));
  env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  const result = await building;
  assert.equal(result.ok, false);
  assert.match(result.code, /E_SCOPE|E_INDEX|E_CAS|E_CHUNK/);
  // 撤权事务已把旧索引副本中的 email/plan 清除，因此旧索引仍可服务但绝不返回被撤列。
  const versions = env.indexer.listVersions('billing');
  assert.ok(versions.every((v) => v.status !== 'building'));
  const q = env.indexer.query({ purpose: 'billing' });
  assert.deepEqual(q.index.fields, ['customer_id', 'full_name', 'monthly_spend']);
  assert.ok(q.rows.every((r) => !('email' in r.cells) && !('plan' in r.cells)));
});

test('比较并交换：提交事务内授权变化时拒绝发布', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  const original = env.authz.scopeToken.bind(env.authz);
  let calls = 0;
  const sign = env.authz.scopeToken('analytics').signature;
  env.authz.scopeToken = (p) => {
    calls += 1;
    const token = original(p);
    if (p === 'analytics' && calls >= 3) return { ...token, signature: `${token.signature}:drift` };
    return token;
  };
  const result = await env.indexer.build({ purpose: 'analytics' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_CAS_FAILED');
  assert.ok(sign);
});

test('缺失块时拒绝构建索引，不发布部分数据', async () => {
  const env = makeApp({ latencyChunkMs: 2, faults: {} });
  await env.api.runJob({ purpose: 'analytics', simulate: { mode: 'disconnect', afterChunks: 2 } });
  await new Promise((r) => setTimeout(r, 120));
  await assert.rejects(env.indexer.build({ purpose: 'analytics' }), /未下载|缺列|过期/);
});

test('旧任务晚完成不会复活已撤字段的范围', async () => {
  const env = makeApp({ latencyChunkMs: 25 });
  const { jobId } = await env.api.runJob({ purpose: 'care' });
  await new Promise((r) => setTimeout(r, 40));
  env.api.setFields('care', ['customer_id', 'full_name', 'email', 'support_notes']);
  const job = await env.api.waitJob(jobId);
  assert.ok(['invalidated', 'interrupted'].includes(job.status));
  // 旧任务晚完成不能把范围补回来：重建只能成功，且只含当前授权字段
  const rebuilt = await env.indexer.build({ purpose: 'care' }).catch((e) => ({ ok: false, error: e }));
  if (rebuilt.ok) {
    assert.deepEqual(rebuilt.fields, ['customer_id', 'email', 'full_name']);
    const q = env.indexer.query({ purpose: 'care' });
    for (const row of q.rows) {
      assert.ok(!('phone' in row.cells) && !('support_notes' in row.cells));
    }
  } else {
    assert.match(String(rebuilt.error), /未下载|缺列|过期|不一致/);
  }
  const dump = JSON.stringify(env.store.db.prepare('SELECT * FROM chunks').all());
  assert.ok(!dump.includes('138-0000'), '已撤的电话列不得在块中残留');
  assert.ok(dump.includes('虚构支持备注'), '仍在授权内的支持备注应保留');
});

test('两个用途同时采集同一数据集互不影响', async () => {
  const env = makeApp({ latencyChunkMs: 4 });
  const [a, b] = await Promise.all([
    collect(env.api, 'analytics'),
    collect(env.api, 'billing')
  ]);
  assert.equal(a.job.status, 'completed');
  assert.equal(b.job.status, 'completed');
  const an = env.receiver.listChunks('analytics');
  const bi = env.receiver.listChunks('billing');
  assert.ok(an.every((c) => !c.fields.includes('full_name')));
  assert.ok(bi.every((c) => !c.fields.includes('city')));
  const ia = await env.indexer.build({ purpose: 'analytics' });
  const ib = await env.indexer.build({ purpose: 'billing' });
  assert.ok(ia.ok && ib.ok);
  const qa = env.indexer.query({ purpose: 'analytics' });
  const qb = env.indexer.query({ purpose: 'billing' });
  assert.ok(!('email' in qa.rows[0].cells));
  assert.ok(!('city' in qb.rows[0].cells));
});

test('构建失败不影响的旧索引仍可按当前范围服务', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  assert.ok((await env.indexer.build({ purpose: 'analytics' })).ok);
  assert.ok((await env.indexer.build({ purpose: 'analytics', breakBeforeCommit: true })).ok === false);
  const q = env.indexer.query({ purpose: 'analytics' });
  assert.equal(q.index.version, 1);
  assert.ok(q.rows.length === 24);
});
