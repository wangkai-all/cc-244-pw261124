const polling = new Set();

const state = {
  meta: null,
  purpose: 'billing',
  selected: new Set(),
  applied: new Set(),
  snap: null,
  job: null,
  plan: [],
  query: null,
  preview: null,
  exportResult: null,
  exportError: null,
  busy: false,
  breakSim: false,
  breakAfter: 3,
  chunkView: {}
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const FIELD_LABEL = new Map();
const SENS = { low: '低敏', medium: '中敏', high: '高敏' };

function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('err', isError);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `请求失败（${res.status}）`);
    err.code = data.error?.code ?? `HTTP_${res.status}`;
    err.detail = data.error?.detail ?? {};
    throw err;
  }
  return data;
}

function currentPurpose() {
  return state.snap?.authz.purposes.find((p) => p.key === state.purpose);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fieldName(key) {
  return FIELD_LABEL.get(key)?.label ?? key;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

async function boot() {
  state.meta = await api('/api/meta');
  for (const f of state.meta.fields) FIELD_LABEL.set(f.key, f);
  $('#datasetMeta').textContent = `${state.meta.dataset.name} · rev ${state.meta.dataset.revision} · ${state.meta.rowCount} 行 / ${state.meta.chunkCount} 块`;
  const rl = $('#reusePolicy');
  const pl = $('#publishPolicy');
  for (const line of state.meta.policy.reuse) rl.append(el('li', '', line));
  for (const line of state.meta.policy.publication) pl.append(el('li', '', line));
  renderPurposeTabs();
  await refresh();
}

function renderPurposeTabs() {
  const nav = $('#purposeTabs');
  nav.replaceChildren();
  for (const p of state.meta.purposes) {
    const b = el('button', 'purpose-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(p.key === state.purpose));
    b.append(el('span', '', p.label), el('small', '', `${p.allowed.length} 个可选字段 · ${p.key}`));
    b.addEventListener('click', () => switchPurpose(p.key));
    nav.append(b);
  }
}

async function switchPurpose(key) {
  if (key === state.purpose) return;
  state.purpose = key;
  state.query = null;
  state.exportResult = null;
  state.exportError = null;
  state.job = null;
  state.plan = [];
  state.chunkView = {};
  renderPurposeTabs();
  await refresh();
}

async function refresh() {
  state.snap = await api(`/api/state/${state.purpose}`);
  const p = currentPurpose();
  if (!p) return;
  try {
    const preview = await api(`/api/plan/${state.purpose}`);
    state.preview = preview;
  } catch {
    state.preview = null;
  }
  state.applied = new Set(p.fields);
  if (!state.selected.size || !sameSet(new Set([...state.selected].filter((f) => p.allowed.includes(f))), state.selected)) {
    state.selected = new Set(p.fields);
  }
  renderScope();
  renderTransfer();
  renderIndex();
  renderExports();
  renderAudit();
  // 刷新页面后若任务仍在运行，继续轮询而不是停在“运行中”。
  const latest = state.snap.jobs[0];
  if (latest && latest.status === 'running' && state.job?.id !== latest.id && !polling.has(latest.id)) {
    state.job = latest;
    state.plan = latest.reuse ?? [];
    state.busy = true;
    pollJob(latest.id);
  }
}

function renderScope() {
  const p = currentPurpose();
  $('#purposeDesc').textContent = p.description;
  $('#purposeVersion').textContent = `v${p.version} / epoch ${p.epoch}`;
  const chips = $('#fieldChips');
  chips.replaceChildren();
  for (const f of state.meta.fields) {
    const allowed = p.allowed.includes(f.key);
    const selected = state.selected.has(f.key);
    const applied = state.applied.has(f.key);
    const label = el('label', 'field-chip');
    label.dataset.sensitivity = f.sensitivity;
    if (!allowed) label.classList.add('disallowed');
    else if (selected && !applied) label.classList.add('pending-add');
    else if (!selected && applied) label.classList.add('pending-remove');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected;
    input.disabled = !allowed;
    input.dataset.field = f.key;
    input.setAttribute('aria-label', `${fieldName(f.key)}${allowed ? '' : '（该用途不可用）'}`);
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(f.key);
      else state.selected.delete(f.key);
      renderScope();
    });
    const body = el('div');
    body.append(el('span', 'fname', f.label), el('span', 'fmeta', `${f.key} · ${SENS[f.sensitivity]}`));
    if (!allowed) body.append(el('span', 'fmeta', '用途外 · 不可选'));
    label.append(input, body);
    chips.append(label);
  }
  const epochText = Object.entries(p.fieldEpochs).filter(([, v]) => v > 0).map(([k, v]) => `${k}:e${v}`);
  $('#epochSummary').textContent = epochText.length ? epochText.join(' · ') : '全部 e0';
  $('#appliedCount').textContent = String(state.applied.size);
  $('#pendingCount').textContent = String(state.selected.size);
  const changed = !sameSet(state.selected, state.applied);
  $('#applyFields').disabled = !changed || state.busy || state.selected.size === 0;
  const removed = [...state.applied].filter((f) => !state.selected.has(f));
  const strip = $('#revocationStrip');
  if (removed.length) {
    strip.hidden = false;
    strip.replaceChildren(
      el('strong', '', '将撤出：'),
      document.createTextNode(removed.map((f) => fieldName(f)).join('、')),
      el('div', '', '撤权后对应列会从块、索引与导出中清除；失败详情不会回显原值。')
    );
  } else {
    strip.hidden = true;
  }
  $('#scopeHint').textContent = changed
    ? '有待应用的变更。撤出字段不可逆，新增字段需要整块重取对应数据。'
    : '字段范围与当前授权一致；撤出的字段会从块、索引与导出中清除，原值不再可取回。';
}

function renderTransfer() {
  const grid = $('#chunkGrid');
  grid.replaceChildren();
  const byIndex = new Map(state.snap.chunks.map((c) => [c.chunkIndex, c]));
  // 任务进行中展示任务计划；空闲时展示下一次采集的预判，便于逐块解释复用/作废原因。
  const shownPlan = state.plan.length ? state.plan : (state.preview?.plan ?? []);
  const planByIndex = new Map(shownPlan.map((p) => [p.chunkIndex, p]));
  const jobStatus = state.job?.status;
  for (const r of state.job?.results ?? []) {
    if (r.action === 'discard') state.chunkView[r.chunkIndex] = 'discarded';
  }
  for (let i = 0; i < state.meta.chunkCount; i += 1) {
    const card = el('div', 'chunk');
    const view = state.chunkView[i];
    const stored = byIndex.get(i);
    let kind = stored ? stored.status : 'empty';
    if (view === 'fetching') kind = 'fetching';
    if (view === 'reused') kind = 'reused';
    if (view === 'discarded') kind = 'discarded';
    card.dataset.state = kind;
    const head = el('div', 'idx');
    head.append(el('span', '', `#${i}`), el('span', '', stored ? `${stored.bytes}B` : '—'));
    const labels = {
      ready: '已校验', partial: '缺列', voided: '已清除', empty: '未接收',
      fetching: '接收中', reused: '复用', discarded: '已丢弃'
    };
    card.append(head, el('span', 'state', labels[kind] ?? kind));
    if (stored) card.append(el('span', 'fields', stored.fields.map(fieldName).join(' · ')));
    else if (planByIndex.get(i)) card.append(el('span', 'fields', planByIndex.get(i).action === 'reuse' ? '可复用' : '待下载'));
    else card.append(el('span', 'fields', '—'));
    grid.append(card);
  }

  const planList = $('#reusePlan');
  planList.replaceChildren();
  if (!shownPlan.length) {
    planList.append(el('li', 'muted', '尚无可判定的块。'));
  } else {
    const head = el('li', 'muted');
    const s = state.preview?.summary;
    head.textContent = state.plan.length
      ? '本次任务计划：'
      : s ? `若现在采集：复用 ${s.reuse} 块 · 下载 ${s.fetch} 块 · 清除重取 ${s.purge} 块` : '';
    planList.append(head);
    for (const p of shownPlan) {
      const li = el('li');
      li.dataset.action = p.action;
      li.append(el('span', 'pi', `#${p.chunkIndex}`), el('span', 'pi', p.action === 'reuse' ? '复用' : p.action === 'purge' ? '清除重取' : '下载'));
      li.append(el('span', 'why', p.reason));
      planList.append(li);
    }
  }

  const summary = $('#jobSummary');
  summary.replaceChildren();
  if (!state.job) {
    summary.append(el('span', 'muted', '尚无任务记录。'));
  } else {
    const j = state.job;
    const rows = [
      ['任务', j.id],
      ['状态', j.status],
      ['块进度', `${j.progress.done}/${j.progress.total}`],
      ['任务范围', j.scope.fields.map((f) => fieldName(f)).join('、')],
      ['字段纪元', Object.entries(j.scope.fieldEpochs ?? {}).map(([k, v]) => `${k}:e${v}`).join(' · ')],
      ['栅栏', String(j.fence ?? '—')],
      ['耗时', `${j.elapsedMs} ms`]
    ];
    for (const [k, v] of rows) {
      const kv = el('div', 'kv');
      kv.append(el('span', '', k), el('span', '', v));
      summary.append(kv);
    }
  }
  const prog = $('#jobProgress');
  if (state.job && jobStatus === 'running') {
    prog.hidden = false;
    prog.firstElementChild.style.width = `${Math.round((state.job.progress.done / state.job.progress.total) * 100)}%`;
  } else prog.hidden = true;

  const fail = $('#jobFailure');
  const d = state.job?.detail;
  if (!d) {
    fail.hidden = true;
  } else {
    fail.hidden = false;
    fail.className = 'failure';
    fail.replaceChildren();
    fail.append(el('strong', '', `${d.code ?? '信息'} · ${state.job.status}`));
    fail.append(el('div', '', d.message));
    if (d.revokedFields?.length) fail.append(el('div', '', `撤权字段：${d.revokedFields.map(fieldName).join('、')}`));
    if (d.invalidations?.length) {
      fail.append(el('div', '', `作废块：${d.invalidations.map((x) => `#${x.chunkIndex}`).join('、')}`));
    }
    fail.append(el('div', 'muted', '详情只包含错误码、块号与字段名，不含任何原值。'));
  }
  const pending = !sameSet(state.selected, state.applied);
  $('#startJob').disabled = state.busy || state.applied.size === 0 || pending;
  $('#startJob').title = pending ? '请先应用字段范围，再开始采集' : '';
  $('#startJob').textContent = state.job && ['interrupted', 'invalidated', 'failed'].includes(state.job.status) ? '从断点恢复采集' : '开始采集';
  $('#buildIndex').disabled = pending || state.busy;
}

function renderIndex() {
  const box = $('#indexStatus');
  box.replaceChildren();
  const active = state.snap.activeIndex;
  const versions = state.snap.indexVersions;
  const latest = versions.reduce((a, b) => (!a || b.version > a.version ? b : a), null);
  const cells = [
    ['当前索引', active ? `v${active.version} · ${active.status}` : (latest ? `v${latest.version} · ${latest.status}` : '无可用索引')],
    ['索引用途', (active ?? latest) ? (active ?? latest).fields.map((f) => fieldName(f)).join('、') : '—'],
    ['历史版本', versions.length ? versions.map((v) => `v${v.version}:${v.status}`).join(' ') : '—'],
    ['可查询', active ? '是 · 每次按当前授权复核' : '否 · 需重新构建']
  ];
  for (const [k, v] of cells) {
    const m = el('div', 'metric');
    m.append(el('span', 'metric-label', k), el('strong', '', v));
    box.append(m);
  }
  renderQuery();
}

function renderQuery() {
  const wrap = $('#queryWrap');
  const q = state.query;
  if (!q) {
    wrap.replaceChildren(el('p', 'muted pad', '索引发布后，这里会按当前授权渲染表格。'));
    $('#queryNote').textContent = '';
    return;
  }
  const current = currentPurpose();
  const table = el('table');
  const thead = el('thead');
  const tr = el('tr');
  tr.append(el('th', '', '记录'));
  for (const f of q.requested) tr.append(el('th', '', fieldName(f)));
  thead.append(tr);
  const tbody = el('tbody');
  const maskedFields = new Set([...(q.revokedInIndex ?? []), ...(q.missingFromIndex ?? [])]);
  for (const row of q.rows) {
    const r = el('tr');
    r.append(el('td', '', row.customer_id));
    for (const f of q.requested) {
      const v = row.cells[f];
      const revoked = maskedFields.has(f) || (current && !current.fields.includes(f));
      const td = el('td', revoked ? 'masked-cell' : '', String(v ?? '—'));
      r.append(td);
    }
    tbody.append(r);
  }
  table.append(thead, tbody);
  wrap.replaceChildren(table);
  const notes = [`索引 v${q.index.version} · ${q.rowCount} 行`];
  if (q.stale) notes.push(`${q.note}`);
  if (q.staleFields.length) notes.push('过期列一律遮蔽，不返回原值');
  else notes.push('查询结果按当前授权逐列复核');
  $('#queryNote').textContent = notes.join(' · ');
}

function renderExports() {
  const list = $('#exportHistory');
  list.replaceChildren();
  const history = state.snap.exports;
  if (!history.length) {
    list.append(el('li', 'muted', '尚无导出。'));
  } else {
    for (const h of history) {
      const li = el('li');
      const left = el('div');
      left.append(el('strong', '', h.id), document.createTextNode(' · '), el('span', '', h.fields.map(fieldName).join('、')));
      const right = el('div');
      right.append(el('code', '', `${h.rowCount} 行`), document.createTextNode(' · '), el('code', '', h.checksum.slice(0, 12)));
      li.append(left, right);
      list.append(li);
    }
  }
  renderChecks();
  renderExportResult();
}

function renderChecks() {
  const box = $('#finalChecks');
  box.replaceChildren();
  const current = currentPurpose();
  const active = state.snap.activeIndex;
  const checks = [];
  checks.push({
    label: '当前授权',
    value: current ? current.fields.map(fieldName).join('、') : '—',
    ok: Boolean(current)
  });
  checks.push({
    label: '索引与授权一致',
    value: active ? (active.fields.join(',') === current.fields.join(',') ? '一致' : `不一致：${active.fields.join(',')}`) : '无索引',
    ok: Boolean(active) && active.fields.join(',') === current.fields.join(',')
  });
  const chunkOk = state.snap.chunks.length === state.meta.chunkCount
    && state.snap.chunks.every((c) => c.status === 'ready')
    && state.snap.chunks.every((c) => c.fields.join(',') === current.fields.join(','));
  checks.push({ label: '块覆盖当前字段', value: chunkOk ? '6/6 完整' : `${state.snap.chunks.length}/6 可用`, ok: chunkOk });
  checks.push({
    label: '查询与导出一致',
    value: state.query
      ? (state.query.stale ? `索引过期：${state.query.staleFields.map(fieldName).join('、')} 已遮蔽` : '按当前授权复核通过')
      : '尚未查询',
    ok: !state.query || !state.query.stale
  });
  const tombstones = state.snap.tombstones ?? [];
  checks.push({
    label: '撤权墓碑',
    value: tombstones.length ? `${tombstones.length} 条（原值已清除）` : '无撤权',
    ok: true
  });
  checks.push({
    label: '数据来源',
    value: '本地模拟 · 无外网',
    ok: true
  });
  for (const c of checks) {
    const n = el('div', `check ${c.ok ? 'pass' : 'fail'}`);
    n.append(el('span', 'ck-label', c.label), el('span', 'ck-value', c.value));
    box.append(n);
  }
}

function renderExportResult() {
  const box = $('#exportResult');
  const r = state.exportResult;
  if (!r) {
    if (state.exportError) {
      box.hidden = false;
      box.replaceChildren();
      const f = el('div', 'failure');
      f.append(el('strong', '','导出被拒绝'), el('div', '', state.exportError.message));
      if (state.exportError.code) f.append(el('code', '', state.exportError.code));
      box.append(f);
    } else {
      box.hidden = true;
    }
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const head = el('div', 'ex-head');
  const meta = el('div');
  meta.append(el('strong', '', `${r.format.toUpperCase()} · ${r.id}`));
  meta.append(el('div', 'muted', `${r.rowCount} 行 · 字段：${r.fields.map(fieldName).join('、')}`));
  const sum = el('div');
  sum.append(el('div', 'muted', 'SHA-256'), el('code', '', r.checksum.slice(0, 24)));
  head.append(meta, sum);
  box.append(head);
  const pre = el('pre', '', r.preview);
  box.append(pre);
}

function renderAudit() {
  const list = $('#auditList');
  list.replaceChildren();
  const items = state.snap.audit.slice(0, 24);
  if (!items.length) list.append(el('li', 'muted', '尚无事件。'));
  for (const a of items) {
    const li = el('li');
    li.dataset.outcome = a.outcome;
    li.append(el('span', 'at', fmtTime(a.at)));
    const mid = el('span', 'act', a.action);
    if (a.purpose) mid.append(document.createTextNode(` · ${a.purpose}`));
    if (a.code) mid.append(el('span', 'oc', ` ${a.code}`));
    li.append(mid, el('span', 'oc', a.outcome));
    list.append(li);
  }
  const tl = $('#tombstoneList');
  tl.replaceChildren();
  const marks = state.snap.tombstones ?? [];
  if (!marks.length) tl.append(el('li', 'muted', '尚无撤权。'));
  for (const m of marks.slice(0, 12)) {
    tl.append(el('li', '', `${fmtTime(m.at)} · ${m.purpose}/${m.field} e${m.field_epoch} · 块 ${m.cleared_chunks} · 索引 ${m.cleared_index_versions} · 原值已清除`));
  }
}

async function onApplyFields() {
  if (state.busy) return;
  const removed = [...state.applied].filter((f) => !state.selected.has(f));
  if (removed.length) {
    const ok = window.confirm(`将撤出 ${removed.map(fieldName).join('、')}。相关列会从块、索引与导出中清除且不可恢复，继续？`);
    if (!ok) return;
  }
  state.busy = true;
  renderScope();
  try {
    const out = await api(`/api/purposes/${state.purpose}`, { method: 'PATCH', body: { fields: [...state.selected] } });
    if (!out.changed) {
      toast('字段范围未变化');
    } else {
      const bits = [];
      if (out.removed?.length) bits.push(`撤出 ${out.removed.map(fieldName).join('、')} 并清除 ${out.purge.chunks.length} 个块`);
      if (out.added?.length) bits.push(`新增 ${out.added.map(fieldName).join('、')}`);
      toast(bits.join('；') || '字段范围已更新');
    }
    state.job = null;
    state.plan = [];
    state.query = null;
    state.exportResult = null;
    state.exportError = null;
    state.chunkView = {};
    await refresh();
  } catch (err) {
    toast(err.message, true);
    await refresh();
  } finally {
    state.busy = false;
    renderScope();
    renderTransfer();
  }
}

async function onStartJob() {
  if (state.busy) return;
  state.busy = true;
  state.plan = [];
  state.query = null;
  state.exportResult = null;
  state.chunkView = {};
  $('#startJob').disabled = true;
  try {
    // 任务严格使用已应用的授权范围，不把页面上尚未应用的勾选带进下载。
    const body = { purpose: state.purpose };
    if (state.breakSim) body.simulate = { mode: 'disconnect', afterChunks: state.breakAfter };
    const started = await api('/api/jobs', { method: 'POST', body });
    state.plan = started.plan;
    state.job = { id: started.jobId, status: 'running', progress: { done: 0, total: state.meta.chunkCount }, scope: started.scope, fence: started.fence, elapsedMs: 0, detail: null };
    renderTransfer();
    pollJob(started.jobId);
  } catch (err) {
    toast(err.message, true);
    state.busy = false;
    renderTransfer();
  }
}

async function pollJob(id) {
  if (polling.has(id)) return;
  polling.add(id);
  const fetchState = async () => {
    try {
      return await api(`/api/jobs/${id}`);
    } catch {
      return null;
    }
  };
  let job = await fetchState();
  try {
    while (job && job.status === 'running') {
      state.job = job;
      renderTransfer();
      await new Promise((r) => setTimeout(r, 180));
      job = await fetchState();
    }
  } finally {
    polling.delete(id);
  }
  state.job = job;
  state.busy = false;
  if (job) {
    for (const p of job.reuse ?? []) {
      if (p.action === 'reuse') state.chunkView[p.chunkIndex] = 'reused';
    }
    if (job.status === 'completed') {
      // 用实际块状态覆盖视图
      state.chunkView = {};
    }
    if (job.status === 'completed') toast(`采集完成：${job.progress.done}/${job.progress.total} 块`);
    else if (job.detail) toast(`${job.detail.code} · ${job.status}`, job.status === 'failed');
  }
  await refresh();
}

async function onBuildIndex() {
  if (state.busy) return;
  state.busy = true;
  $('#buildIndex').disabled = true;
  try {
    // 只把“范围与当前授权完全一致且已完成”的任务作为发布依据；
    // 否则让服务端仅依据块与当前授权复核，避免被旧任务范围牵连。
    const job = state.job;
    const current = currentPurpose();
    const jobMatches = Boolean(job && job.status === 'completed' && current
      && Array.isArray(job.scope?.fields)
      && job.scope.fields.length === current.fields.length
      && current.fields.every((f) => job.scope.fields.includes(f))
      && current.fields.every((f) => (job.scope.fieldEpochs?.[f] ?? 0) === (current.fieldEpochs[f] ?? 0)));
    const out = await api(`/api/index/${state.purpose}`, {
      method: 'POST',
      body: { jobId: jobMatches ? job.id : null }
    });
    if (out.ok) toast(`索引 v${out.version} 已发布（${out.docCount} 行）`);
    else toast(`索引未发布：${out.code}`, true);
    state.query = null;
    state.exportError = null;
    await refresh();
  } catch (err) {
    toast(`${err.code} · ${err.message}`, true);
    await refresh();
  } finally {
    state.busy = false;
    renderScope();
    renderTransfer();
  }
}

async function onQuery() {
  try {
    const q = await api(`/api/query/${state.purpose}`, { method: 'POST', body: { search: $('#searchInput').value } });
    state.query = q;
    renderQuery();
    renderChecks();
  } catch (err) {
    toast(`${err.code} · ${err.message}`, true);
    state.query = null;
    renderQuery();
  }
}

async function onExport(format) {
  if (state.busy) return;
  state.busy = true;
  try {
    const out = await api('/api/exports', { method: 'POST', body: { purpose: state.purpose, format } });
    state.exportResult = {
      ...out,
      format,
      preview: out.body.length > 1200 ? `${out.body.slice(0, 1200)}\n…` : out.body
    };
    state.exportError = null;
    toast(`导出 ${out.id} · ${out.rowCount} 行`);
    await refresh();
  } catch (err) {
    toast(`${err.code} · ${err.message}`, true);
    state.exportResult = null;
    state.exportError = { code: err.code, message: err.message };
  } finally {
    state.busy = false;
    renderExports();
    renderTransfer();
  }
}

async function onResetFields() {
  const p = currentPurpose();
  state.selected = new Set(p.allowed);
  renderScope();
}

function wire() {
  $('#applyFields').addEventListener('click', onApplyFields);
  $('#startJob').addEventListener('click', onStartJob);
  $('#buildIndex').addEventListener('click', onBuildIndex);
  $('#runQuery').addEventListener('click', onQuery);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') onQuery(); });
  $('#exportJson').addEventListener('click', () => onExport('json'));
  $('#exportCsv').addEventListener('click', () => onExport('csv'));
  $('#resetFields').addEventListener('click', onResetFields);
  $('#simulateBreak').addEventListener('change', (e) => { state.breakSim = e.target.checked; });
  $('#breakAfter').addEventListener('change', (e) => { state.breakAfter = Number(e.target.value); });
}

wire();
// 调试/自动化入口：只暴露只读状态，不提供绕过授权的写操作。
if (typeof window !== 'undefined') window.fieldscope = { state, refresh };

boot().catch((err) => toast(`初始化失败：${err.message}`, true));
