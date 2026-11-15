// 直接启动真实 HTTP 服务的最小接口契约测试（不依赖浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const port = 4215 + Math.floor(Math.random() * 200);
const db = `/tmp/fieldscope-http-${process.pid}.sqlite`;

function startServer() {
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  const proc = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), FIELDSCOPE_DB: db, CHUNK_LATENCY_MS: '3' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    proc.stdout.on('data', (d) => {
      if (String(d).includes('运行于')) { clearTimeout(timer); resolve(proc); }
    });
  });
}

const base = `http://127.0.0.1:${port}`;
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('HTTP 契约：采集、发布、查询、导出与越权拒绝', async () => {
  const proc = await startServer();
  try {
    assert.equal((await call('/api/meta')).status, 200);
    assert.equal((await call('/')).status, 200);
    assert.equal((await call('/app.js')).status, 200);
    assert.equal((await call('/../package.json')).status, 404, '路径穿越被拒绝');

    const bad = await call('/api/jobs', { method: 'POST', body: { purpose: 'analytics', fields: ['customer_id', 'phone'] } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'E_FIELD_OUT_OF_PURPOSE');

    const started = await call('/api/jobs', { method: 'POST', body: { purpose: 'analytics' } });
    assert.equal(started.status, 200);
    for (let i = 0; i < 100; i += 1) {
      const job = await call(`/api/jobs/${started.body.jobId}`);
      if (job.body.status !== 'running') { assert.equal(job.body.status, 'completed'); break; }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal((await call('/api/index/analytics', { method: 'POST', body: {} })).body.ok, true);

    const q = await call('/api/query/analytics', { method: 'POST', body: { search: '杭州' } });
    assert.equal(q.status, 200);
    assert.ok(q.body.rows.length > 0);
    assert.ok(q.body.rows.every((r) => !('email' in r.cells) && !('full_name' in r.cells)));

    const forbidden = await call('/api/query/analytics', { method: 'POST', body: { fields: ['email'] } });
    assert.equal(forbidden.status, 403);
    assert.ok(!JSON.stringify(forbidden.body).includes('@example.test'));

    const exp = await call('/api/exports', { method: 'POST', body: { purpose: 'analytics', format: 'csv' } });
    assert.equal(exp.status, 200);
    assert.equal(exp.body.rowCount, 24);
    assert.ok(!exp.body.body.includes('@example.test'));

    const invalid = await call('/api/exports', { method: 'POST', body: { purpose: 'analytics', format: 'xml' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'E_FORMAT');

    const badJson = await fetch(base + '/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops'
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, 'E_BODY_INVALID');

    const patched = await call('/api/purposes/analytics', { method: 'PATCH', body: { fields: ['customer_id', 'city'] } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.removed.sort(), ['monthly_spend', 'plan']);
    const afterRevoke = await call('/api/query/analytics', { method: 'POST', body: {} });
    assert.equal(afterRevoke.status, 200);
    assert.ok(afterRevoke.body.rows.every((r) => !('monthly_spend' in r.cells) && !('plan' in r.cells)));
    const exportAfterRevoke = await call('/api/exports', { method: 'POST', body: { purpose: 'analytics' } });
    assert.equal(exportAfterRevoke.status, 200);
    assert.ok(!exportAfterRevoke.body.body.includes('monthly_spend'));

    // 重新授权已被清除的列：索引缺少该列，导出必须拒绝而不是放宽或臆造。
    await call('/api/purposes/analytics', { method: 'PATCH', body: { fields: ['customer_id', 'city', 'plan'] } });
    const staleExport = await call('/api/exports', { method: 'POST', body: { purpose: 'analytics' } });
    assert.equal(staleExport.status, 409);
    assert.equal(staleExport.body.error.code, 'E_INDEX_STALE');

    const plan = await call('/api/plan/analytics');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.summary.fetch, 6, '重新授权后所有块都缺该列，需要整块重取');
    assert.ok(plan.body.plan.every((p) => p.reason));
    const state = await call('/api/state/analytics');
    assert.ok(state.body.tombstones.length >= 2);
    assert.ok(!JSON.stringify(state.body).includes('@example.test'));
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 100));
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  }
});
