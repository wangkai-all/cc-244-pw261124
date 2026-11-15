import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, collect } from './helpers.js';

const SENSITIVE = {
  phone: '138-0000',
  health_note: '虚构健康标记',
  support_notes: '虚构支持备注',
  email: '@example.test'
};

function storageDump(env) {
  return [
    ...env.store.db.prepare('SELECT * FROM chunks').all().map((r) => r.rows_json + r.scope_json),
    ...env.store.db.prepare('SELECT * FROM index_versions').all().map((r) => r.docs_json ?? ''),
    ...env.store.db.prepare('SELECT * FROM jobs').all().map((r) => r.scope_json + (r.detail ?? '')),
    ...env.store.db.prepare('SELECT * FROM tombstones').all().map((r) => JSON.stringify(r)),
    ...env.store.db.prepare('SELECT * FROM invalidations').all().map((r) => JSON.stringify(r)),
    ...env.store.db.prepare('SELECT * FROM audit').all().map((r) => JSON.stringify(r))
  ].join('\n');
}

test('导出只包含当前授权字段，校验和与行数可复核', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'billing');
  await env.indexer.build({ purpose: 'billing' });
  const out = env.api.exporter.export({ purpose: 'billing', format: 'csv' });
  assert.deepEqual(out.fields, ['customer_id', 'full_name', 'email', 'plan', 'monthly_spend']);
  assert.equal(out.rowCount, 24);
  for (const v of Object.values(SENSITIVE)) {
    if (v === '@example.test') continue;
    assert.ok(!out.body.includes(v));
  }
  assert.equal(out.checksum.length, 64);
  const again = env.api.exporter.export({ purpose: 'billing', format: 'csv' });
  assert.equal(again.checksum, out.checksum);
});

test('撤权后旧字段不能查询或导出，且库内不残留原值', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'care');
  await env.indexer.build({ purpose: 'care' });
  env.api.setFields('care', ['customer_id', 'full_name', 'email']);
  assert.throws(() => env.api.exporter.export({ purpose: 'care', fields: ['customer_id', 'phone'] }), /授权/);
  const dump = storageDump(env);
  assert.ok(!dump.includes(SENSITIVE.phone), '撤权后电话原值不得残留');
  assert.ok(!dump.includes(SENSITIVE.support_notes), '撤权后备注原值不得残留');
  const tombstones = env.store.db.prepare("SELECT * FROM tombstones WHERE field IN ('phone','support_notes')").all();
  assert.ok(tombstones.length > 0);
  assert.ok(tombstones.every((t) => !JSON.stringify(t).includes('138-')));
});

test('索引缺少当前授权字段时拒绝导出而不是放宽字段', async () => {
  const env = makeApp({ latencyChunkMs: 2 });
  await collect(env.api, 'analytics');
  await env.indexer.build({ purpose: 'analytics' });
  // 撤权（索引副本立即清除 plan），随后重新授权 plan：索引与块都缺这一列
  env.authz.setFields('analytics', ['customer_id', 'city']);
  env.authz.setFields('analytics', ['customer_id', 'city', 'plan']);
  assert.throws(() => env.api.exporter.export({ purpose: 'analytics' }), /索引/);
  const q = env.indexer.query({ purpose: 'analytics' });
  assert.ok(q.stale);
  assert.deepEqual(q.missingFromIndex.sort(), ['plan']);
  assert.ok(q.rows.every((r) => !('plan' in r.cells) || String(r.cells.plan).startsWith('⟨')));
  const stored = env.store.db.prepare("SELECT docs_json FROM index_versions WHERE purpose='analytics' AND docs_json IS NOT NULL").all();
  for (const row of stored) {
    const docs = JSON.parse(row.docs_json);
    assert.ok(docs.every((d) => !('monthly_spend' in d.cells)));
  }
});

test('用途字段全集与默认范围一致，页面可切换用途', async () => {
  const env = makeApp();
  const meta = env.api.meta();
  assert.equal(meta.purposes.length, 3);
  for (const p of env.authz.snapshot().purposes) {
    assert.deepEqual([...p.fields].sort(), [...p.allowed].sort());
  }
  const snap = env.api.state('billing');
  assert.ok(snap.authz.purposes.some((p) => p.key === 'analytics'));
});

test('失败任务的详情不泄露任何原值', async () => {
  const env = makeApp({ latencyChunkMs: 2, faults: { 'corrupt:4': true } });
  const { job } = await collect(env.api, 'care');
  assert.equal(job.status, 'failed');
  const text = JSON.stringify(job);
  for (const v of Object.values(SENSITIVE)) assert.ok(!text.includes(v), `泄露：${v}`);
  const detail = JSON.stringify(job.detail);
  assert.match(detail, /E_HASH_MISMATCH/);
  assert.ok(!detail.includes('C-30'), '失败详情不应回显行数据');
});
