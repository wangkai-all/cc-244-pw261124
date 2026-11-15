// 用 jsdom 驱动真实页面与真实 HTTP 服务，验证用途切换、撤字段、断线恢复与最终导出。
import { JSDOM } from 'jsdom';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const port = Number(process.env.SMOKE_PORT ?? 4199);
const db = `/tmp/fieldscope-smoke-${process.pid}.sqlite`;
for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });

const proc = spawn('node', [new URL('../../src/server.js', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(port), FIELDSCOPE_DB: db, CHUNK_LATENCY_MS: '45' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverUp = false;
proc.stdout.on('data', (d) => { if (String(d).includes('运行于')) serverUp = true; });
proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
for (let i = 0; i < 50 && !serverUp; i += 1) await new Promise((r) => setTimeout(r, 100));
if (!serverUp) throw new Error('服务未能启动');

const dom = await JSDOM.fromURL(`http://127.0.0.1:${port}/`, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, window.location.href), init);
    window.confirm = () => true;
  }
});
const appJs = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
dom.window.eval(appJs);
const doc = dom.window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => doc.querySelector(sel)?.textContent?.trim() ?? '';
const assert = (cond, msg) => { if (!cond) throw new Error(`断言失败：${msg}`); console.log(`  ✓ ${msg}`); };
const waitFor = async (fn, label, tries = 120) => {
  for (let i = 0; i < tries; i += 1) { if (fn()) return; await sleep(120); }
  throw new Error(`等待超时：${label}`);
};
const idle = () => waitFor(() => dom.window.fieldscope?.state?.busy === false, '页面空闲');

try {
  await waitFor(() => doc.querySelectorAll('.purpose-tab').length === 3, '用途标签渲染');
  console.log('\n[1] 初始页面');
  assert(doc.querySelectorAll('.field-chip').length === 9, '九个字段全部列出');
  assert(text('#appliedCount') === '5', '账单用途已授权 5 个字段');
  assert([...doc.querySelectorAll('.field-chip.locked, .field-chip.disallowed')].length === 4, '用途外字段被禁用');

  console.log('\n[2] 首次采集');
  doc.querySelector('#startJob').click();
  await waitFor(() => text('#jobSummary').includes('completed'), '任务完成');
  assert([...doc.querySelectorAll('.chunk')].every((c) => c.dataset.state === 'ready'), '6 个块全部校验通过');
  assert(text('#jobSummary').includes('客户编号'), '任务范围以中文字段名展示');

  console.log('\n[3] 断线恢复');
  doc.querySelector('#simulateBreak').checked = true;
  doc.querySelector('#simulateBreak').dispatchEvent(new dom.window.Event('change'));
  doc.querySelector('#breakAfter').value = '3';
  doc.querySelector('#breakAfter').dispatchEvent(new dom.window.Event('change'));
  doc.querySelector('#startJob').click();
  await waitFor(() => text('#jobSummary').includes('interrupted'), '任务中断');
  assert(text('#jobFailure').includes('E_INTERRUPTED'), '中断原因只给错误码');
  const beforeResume = doc.querySelectorAll('.chunk[data-state="ready"], .chunk[data-state="reused"]').length;
  doc.querySelector('#simulateBreak').checked = false;
  doc.querySelector('#simulateBreak').dispatchEvent(new dom.window.Event('change'));
  doc.querySelector('#startJob').click();
  await waitFor(() => text('#jobSummary').includes('completed') && text('#reusePlan').includes('复用'), '恢复完成并复用');
  const reuseRows = [...doc.querySelectorAll('#reusePlan li')].filter((li) => li.dataset.action);
  assert(reuseRows.slice(0, 3).every((li) => li.dataset.action === 'reuse'), '前三块复用，不重复下载');
  assert(beforeResume >= 3, '中断前至少保留了三个块');

  console.log('\n[4] 构建索引与查询');
  doc.querySelector('#buildIndex').click();
  await waitFor(() => text('#indexStatus').includes('active'), '索引发布');
  doc.querySelector('#runQuery').click();
  await waitFor(() => doc.querySelectorAll('#queryWrap tbody tr').length === 24, '查询返回 24 行');
  const headers = [...doc.querySelectorAll('#queryWrap thead th')].map((t) => t.textContent);
  assert(!headers.includes('电话'), '查询表头不含用途外字段');

  console.log('\n[5] 撤字段');
  const emailChip = [...doc.querySelectorAll('.field-chip')].find((c) => c.textContent.includes('邮箱'));
  emailChip.querySelector('input').click();
  await waitFor(() => text('#revocationStrip').includes('撤出'), '显示撤权提示');
  doc.querySelector('#applyFields').click();
  await waitFor(() => text('#revocationStrip') === '' || doc.querySelector('#revocationStrip').hidden, '撤权生效');
  const chunkFields = [...doc.querySelectorAll('.chunk .fields')].map((n) => n.textContent);
  assert(chunkFields.every((f) => !f.includes('邮箱')), '块内已无邮箱列');
  doc.querySelector('#runQuery').click();
  await sleep(400);
  assert(![...doc.querySelectorAll('#queryWrap thead th')].map((t) => t.textContent).includes('邮箱'), '查询表头已移除邮箱');
  const tomb = text('#tombstoneList');
  assert(tomb.includes('email'), '留下邮箱的清除墓碑');

  console.log('\n[6] 撤权后索引同步清理，导出仍可用但绝不含被撤列');
  doc.querySelector('#exportCsv').click();
  await waitFor(() => text('#exportResult') !== '', '导出完成');
  assert(!text('#exportResult').includes('导出被拒绝'), '剩余字段仍覆盖授权，导出可继续');
  assert(!text('#exportResult').includes('@example.test'), '导出不含邮箱原值');
  assert(!text('#exportResult').includes('email'), '导出不含邮箱列');
  assert(text('#finalChecks').includes('当前授权'), '最终检查面板已渲染');

  console.log('\n[6b] 重新授权已清除的列后，索引缺列必须拒绝导出');
  const emailChip2 = [...doc.querySelectorAll('.field-chip')].find((c) => c.textContent.includes('邮箱'));
  emailChip2.querySelector('input').click();
  await sleep(80);
  doc.querySelector('#applyFields').click();
  await waitFor(() => doc.querySelector('#exportResult').hidden, '重新授权生效');
  await idle();
  doc.querySelector('#exportCsv').click();
  await waitFor(() => text('#exportResult').includes('导出被拒绝'), '缺列索引拒绝导出');
  await idle();
  assert(text('#exportResult').includes('E_INDEX_STALE'), '拒绝原因是索引过期');
  await waitFor(() => !doc.querySelector('#buildIndex').disabled, '构建按钮可用');
  doc.querySelector('#buildIndex').click();
  await waitFor(() => text('#toast').includes('E_INDEX_SOURCE_INCOMPLETE'), '缺列块阻止建索引');
  await idle();
  await waitFor(() => !doc.querySelector('#startJob').disabled, '采集按钮可用');
  doc.querySelector('#startJob').click();
  await waitFor(() => text('#jobSummary').includes('completed'), '重新采集补齐列');
  assert([...doc.querySelectorAll('#reusePlan li')].filter((li) => li.dataset.action).every((li) => li.dataset.action !== 'reuse'), '所有块缺列，全部重取');
  await idle();
  doc.querySelector('#buildIndex').click();
  await waitFor(() => /当前索引v\d+ · active/.test(text('#indexStatus')), '重建索引');
  await idle();
  doc.querySelector('#exportCsv').click();
  await waitFor(() => text('#exportResult') !== '' && !text('#exportResult').includes('导出被拒绝'), '导出恢复');
  assert(text('#exportResult').includes('@example.test'), '重新采集后邮箱列恢复');
  await idle();
  doc.querySelector('#runQuery').click();
  await waitFor(() => text('#queryNote').includes('逐列复核'), '查询按当前授权复核');
  assert(text('#finalChecks').includes('按当前授权复核通过'), '最终检查显示查询与授权一致');
  assert(text('#finalChecks').includes('索引与授权一致'), '最终检查显示索引一致');

  console.log('\n[7] 切换用途');
  [...doc.querySelectorAll('.purpose-tab')].find((t) => t.textContent.includes('用量分析')).click();
  await waitFor(() => text('#purposeDesc').includes('聚合'), '切换至用量分析');
  assert(text('#appliedCount') === '4', '用量分析授权 4 个字段');
  const careAbroad = [...doc.querySelectorAll('.field-chip')].filter((c) => c.textContent.includes('电话'));
  assert(careAbroad.every((c) => c.querySelector('input').disabled), '电话在用量分析中不可选');

  console.log('\n[8] 查询页与导出对撤权字段的拒绝');
  const res = await fetch(`http://127.0.0.1:${port}/api/query/analytics`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: ['customer_id', 'full_name'] })
  });
  const payload = await res.json();
  assert(res.status === 403 && payload.error.code === 'E_FIELD_REVOKED', '查询用途外字段返回 403');
  assert(!JSON.stringify(payload).includes('@example.test'), '拒绝响应不含原值');

  console.log('\n全部页面场景通过。');
} finally {
  proc.kill();
  dom.window.close();
}
