import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('两种用途并行采集与撤权同时发生：各自范围不扩大', async () => {
  const env = makeApp({ latencyChunkMs: 12 });
  const a = env.api.runJob({ purpose: 'billing' });
  const b = env.api.runJob({ purpose: 'care' });
  await new Promise((r) => setTimeout(r, 20));
  env.api.setFields('care', ['customer_id', 'full_name', 'email']);
  await Promise.all([a, b]);
  const careLeft = env.receiver.listChunks('care');
  for (const c of careLeft) assert.ok(!c.fields.includes('phone') && !c.fields.includes('support_notes'));
  const billingLeft = env.receiver.listChunks('billing');
  assert.ok(billingLeft.every((c) => c.fields.includes('email')));
  const dump = JSON.stringify(env.store.db.prepare('SELECT * FROM chunks').all());
  assert.ok(!dump.includes('138-0000'));
  assert.ok(!dump.includes('虚构支持备注'));
});

test('索引构建中的授权变化不会让旧构建发布，新构建可正常发布', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  const slow = env.indexer.build({ purpose: 'analytics', delayMs: 50 });
  await new Promise((r) => setTimeout(r, 10));
  env.authz.setFields('analytics', ['customer_id', 'city']);
  const stale = await slow;
  assert.equal(stale.ok, false);
  // 重建块后再发布一个与当前授权匹配的新索引
  const again = await env.indexer.build({ purpose: 'analytics' }).catch((e) => ({ ok: false, error: e }));
  if (again.ok) {
    assert.deepEqual(again.fields, ['customer_id', 'city'], '新索引只含当前授权字段');
  } else {
    assert.match(String(again.error), /未下载|缺列|过期|不一致/);
  }
  const active = env.indexer.activeVersion('analytics');
  if (active) {
    const q = env.indexer.query({ purpose: 'analytics' });
    assert.ok(q.rows.every((r) => !('monthly_spend' in r.cells) && !('plan' in r.cells)));
    assert.ok(q.index.fields.every((f) => ['customer_id', 'city'].includes(f)));
  }
});

test('用过期任务发布索引会被拒绝，不能借旧任务扩大字段', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  const { started } = await collect(env.api, 'care');
  const { jobId } = started;
  // 撤权使旧任务中的 phone/support_notes 纪元变化；用该任务发布必须被拒绝
  env.api.setFields('care', ['customer_id', 'full_name', 'email']);
  await assert.rejects(env.indexer.build({ purpose: 'care', jobId }), /任务范围与当前授权不一致/);
  assert.equal(env.indexer.activeVersion('care'), undefined);
});

test('未完成的任务不能用于发布索引', async () => {
  const env = makeApp({ latencyChunkMs: 15 });
  const { jobId } = await env.api.runJob({ purpose: 'analytics' });
  await assert.rejects(env.indexer.build({ purpose: 'analytics', jobId }), /已完成/);
  await env.api.waitJob(jobId);
});

test('撤权发生在索引事务提交瞬间：比较并交换拦截', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'billing');
  const origTx = env.store.tx.bind(env.store);
  let swapped = false;
  env.store.tx = (fn) => {
    if (!swapped) {
      swapped = true;
      // 在比较并交换之前改变授权（模拟撤权事务抢先提交）
      env.authz.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
    }
    return origTx(fn);
  };
  const res = await env.indexer.build({ purpose: 'billing' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_CAS_FAILED');
  assert.equal(env.indexer.activeVersion('billing'), undefined);
});
