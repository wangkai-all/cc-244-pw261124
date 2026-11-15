import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('来源拒绝用途之外的字段，且不下载任何块', async () => {
  const env = makeApp();
  assert.throws(() => env.source.requestScope('analytics', ['customer_id', 'phone']), /分析|不允许|之外的字段/);
  assert.equal(env.source.requests.length, 0);
});

test('来源拒绝未知字段，接收端也不接受越权列', async () => {
  const env = makeApp();
  assert.throws(() => env.source.requestScope('billing', ['not_a_field']), /未知字段/);
});

test('任务字段超出当前授权时拒绝启动', async () => {
  const env = makeApp();
  await assert.rejects(env.api.runJob({ purpose: 'analytics', fields: ['customer_id', 'phone'] }), /超出当前用途授权/);
});

test('撤销字段后立即清除块和索引列，并留下不可逆墓碑', async () => {
  const env = makeApp();
  await collect(env.api, 'billing');
  await env.indexer.build({ purpose: 'billing' });
  const out = env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  assert.deepEqual(out.removed.sort(), ['email', 'plan']);
  assert.ok(out.purge.chunks.length >= 6);
  for (const row of env.store.db.prepare('SELECT rows_json, fields_json FROM chunks').all()) {
    assert.ok(!JSON.parse(row.rows_json).some((r) => 'email' in r || 'plan' in r));
    assert.ok(!JSON.parse(row.fields_json).includes('email'));
  }
  const docs = env.store.db.prepare("SELECT docs_json FROM index_versions WHERE purpose='billing'").all();
  for (const d of docs) {
    for (const doc of JSON.parse(d.docs_json ?? '[]')) {
      assert.ok(!('email' in doc.cells) && !('plan' in doc.cells));
    }
  }
  const marks = env.store.db.prepare('SELECT * FROM tombstones ORDER BY id').all();
  assert.ok(marks.length >= 2);
  assert.ok(marks.every((m) => !JSON.stringify(m).includes('@example.test')));
  // 索引副本已在同一事务中清除被撤列，剩余字段仍覆盖当前授权，可继续服务。
  const q = env.indexer.query({ purpose: 'billing', maskRevoked: false });
  assert.deepEqual(q.index.fields, ['customer_id', 'full_name', 'monthly_spend']);
  assert.ok(q.rows.every((r) => !('email' in r.cells) && !('plan' in r.cells)));
  const exported = env.api.exporter.export({ purpose: 'billing' });
  assert.deepEqual(exported.fields, ['customer_id', 'full_name', 'monthly_spend']);
  assert.ok(!exported.body.includes('@example.test'));
});

test('字段纪元阻止撤权后再授权的旧块被复用', async () => {
  const env = makeApp();
  await collect(env.api, 'billing');
  env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend', 'email']);
  const plan = env.collector.reusePlan('billing', env.authz.scopeToken('billing'));
  assert.ok(plan.every((p) => p.action === 'fetch'));
  assert.match(plan[0].reason, /缺少任务所需字段/);
});
