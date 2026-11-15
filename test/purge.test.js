import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

test('撤权清理是原子的：块、索引、墓碑与审计同时生效', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'billing');
  await env.indexer.build({ purpose: 'billing' });
  const out = env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  assert.equal(out.purge.chunks.length, 6);
  assert.deepEqual(Object.keys(out.purge.indexColumns).sort(), ['email', 'plan']);
  const marks = env.store.db.prepare("SELECT * FROM tombstones ORDER BY id").all();
  assert.deepEqual(marks.map((m) => m.field), ['email', 'plan']);
  assert.ok(marks.every((m) => m.cleared_chunks === 6), '墓碑记录受影响的全部 6 个块');
  assert.ok(marks.every((m) => m.cleared_index_versions === 1), '墓碑记录受影响的索引版本数');
  assert.ok(marks.every((m) => m.note.includes('不可逆')));
  const audit = env.store.db.prepare("SELECT * FROM audit WHERE action='authz.fields'").all();
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes('@example.test'));
});

test('撤权对未采集用途不产生虚假墓碑', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  const out = env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  assert.equal(out.purge.chunks.length, 0);
  const marks = env.store.db.prepare('SELECT * FROM tombstones').all();
  assert.equal(marks.length, 2);
  assert.ok(marks.every((m) => m.cleared_chunks === 0));
});

test('恢复被撤字段后新采集的块带新纪元，旧块不会被静默混用', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'billing');
  env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend']);
  env.api.setFields('billing', ['customer_id', 'full_name', 'monthly_spend', 'email']);
  const preview = env.api.planPreview('billing');
  assert.equal(preview.summary.reuse, 0);
  assert.equal(preview.summary.fetch, 6);
  const { job } = await collect(env.api, 'billing');
  assert.equal(job.status, 'completed');
  const rows = env.store.db.prepare("SELECT fields_json, scope_json FROM chunks WHERE purpose='billing'").all();
  for (const r of rows) {
    const scope = JSON.parse(r.scope_json);
    assert.equal(scope.fieldEpochs.email, 1, '重新授权后的块记录新纪元');
  }
  const res = await env.indexer.build({ purpose: 'billing' });
  assert.ok(res.ok);
});
