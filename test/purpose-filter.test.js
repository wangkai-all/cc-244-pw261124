import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('客户关怀撤掉电话后，支持备注仍可正常查询与导出', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'care');
  assert.ok((await env.indexer.build({ purpose: 'care' })).ok);
  env.api.setFields('care', ['customer_id', 'full_name', 'email', 'support_notes']);
  const rebuilt = await env.indexer.build({ purpose: 'care' });
  assert.ok(rebuilt.ok, '块已清除 phone，但其余字段仍覆盖当前授权');
  const q = env.indexer.query({ purpose: 'care' });
  assert.equal(q.rows.length, 24);
  assert.ok(q.rows.every((r) => !('phone' in r.cells)));
  const out = env.api.exporter.export({ purpose: 'care', format: 'json' });
  assert.ok(!out.body.includes('138-0000'));
  assert.ok(out.body.includes('虚构支持备注'), '仍在授权内的备注值可导出');
});

test('只撤回部分高敏列时，其余高敏列的原值保留', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'care');
  env.api.setFields('care', ['customer_id', 'full_name', 'email', 'phone']);
  const dump = JSON.stringify(env.store.db.prepare('SELECT rows_json FROM chunks').all());
  assert.ok(dump.includes('138-0000'), '电话仍在授权内');
  assert.ok(!dump.includes('虚构支持备注'), '支持备注已撤出');
});

test('健康备注不在任何用途内，任何用途都无法申请；字段标签齐全', () => {
  const env = makeApp();
  const meta = env.api.meta();
  const covered = new Set(meta.purposes.flatMap((p) => p.allowed));
  assert.ok(!covered.has('health_note'), '健康备注对全部用途锁定');
  assert.equal(covered.size, meta.fields.length - 1);
  for (const purpose of meta.purposes) {
    assert.throws(() => env.source.requestScope(purpose.key, ['health_note']), /之外|不允许/);
  }
  for (const f of meta.fields) {
    assert.ok(f.label && f.sensitivity && f.kind, `字段 ${f.key} 元数据完整`);
  }
});
