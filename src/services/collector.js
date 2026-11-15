import crypto from 'node:crypto';
import { CHUNK_COUNT } from '../config.js';
import { scopeSignature, sortFields } from './authz.js';
import { chunkVerdict } from './chunkScope.js';

export class CollectorError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const nowIso = () => new Date().toISOString();

function epochMap(authz, purpose, fields) {
  const p = authz.require(purpose);
  return Object.fromEntries(fields.map((f) => [f, p.fieldEpochs[f] ?? 0]));
}

/** 任务协调：一次性范围令牌、逐块接收、明确复用与作废条件。 */
export class Collector {
  constructor({ store, authz, source, receiver }) {
    this.store = store;
    this.authz = authz;
    this.source = source;
    this.receiver = receiver;
    this.indexer = null;
    this.active = new Map();
  }

  attachIndexer(indexer) {
    this.indexer = indexer;
  }

  /** 下载期间的撤权必须在所有已落盘副本上执行，而不只是当前块。 */
  purgeRevokedEverywhere(purpose, fields, epochs, { record = true } = {}) {
    return this.store.tx(() => {
      const chunks = this.purgeScope(purpose, fields, epochs);
      const index = this.indexer?.purgeScope(purpose, fields) ?? { columns: {}, versions: 0 };
      if (record) this.recordRevocation(purpose, fields, epochs, { chunks, indexColumns: index.columns, indexVersions: index.versions });
      return { chunks, indexVersions: index.versions, indexColumns: index.columns };
    });
  }

  listJobs(purpose) {
    const rows = purpose
      ? this.store.db.prepare('SELECT * FROM jobs WHERE purpose = ? ORDER BY created_at DESC').all(purpose)
      : this.store.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      status: r.status,
      scope: JSON.parse(r.scope_json),
      progress: JSON.parse(r.progress_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      elapsedMs: r.elapsed_ms,
      fence: r.fence,
      detail: r.detail ? JSON.parse(r.detail) : null,
      reuse: r.reuse_json ? JSON.parse(r.reuse_json) : null,
      results: r.results_json ? JSON.parse(r.results_json) : []
    }));
  }

  getJob(id) {
    return this.listJobs().find((j) => j.id === id) ?? null;
  }

  reusePlan(purpose, scope) {
    const p = this.authz.require(purpose);
    const chunks = this.store.db
      .prepare('SELECT * FROM chunks WHERE purpose = ? ORDER BY chunk_index')
      .all(purpose);
    const currentFields = sortFields(scope.fields);
    const epochMap = Object.fromEntries(
      sortFields([...new Set([...currentFields, ...p.fields])]).map((f) => [f, p.fieldEpochs[f]])
    );
    const plan = [];
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      const row = chunks.find((c) => c.chunk_index === i);
      let verdict = chunkVerdict({ row, purpose, fields: currentFields, fieldEpochs: epochMap });
      if (verdict.action === 'reuse') {
        // 判定为可复用后仍要读回落盘内容：哈希或行宽变化说明块已损坏，预判阶段就改为下载。
        const check = this.verifyStoredChunk(purpose, i, currentFields);
        if (!check.ok) verdict = { action: 'fetch', code: 'E_CHUNK_CORRUPT', reason: check.reason };
      }
      plan.push({
        chunkIndex: i,
        action: verdict.action,
        reason: verdict.reason,
        code: verdict.code,
        missing: verdict.missing ?? [],
        invalidatedBy: verdict.outside ?? [],
        previousFields: row ? JSON.parse(row.fields_json) : null
      });
    }
    return plan;
  }

  async start({ purpose, fields, breakAfter = null, speedMs = null }) {
    const p = this.authz.require(purpose);
    const scopeToken = this.authz.scopeToken(purpose);
    if (!fields) fields = [...p.fields];
    const outside = fields.filter((f) => !p.fields.has(f));
    if (outside.length) {
      throw new CollectorError('E_FIELD_OUT_OF_PURPOSE', `任务字段超出当前用途授权：${outside.join(', ')}`, { outside });
    }
    const selected = sortFields(fields);
    if (!selected.length) throw new CollectorError('E_FIELD_EMPTY', '任务至少需要一个字段');
    const epochs = Object.fromEntries(selected.map((f) => [f, p.fieldEpochs[f]]));
    const scope = {
      purpose,
      fields: selected,
      fieldEpochs: epochs,
      signature: scopeSignature(p.key, selected, epochs),
      sourceRevision: this.source.authz.revision,
      purposeVersion: p.version
    };

    const token = this.source.requestScope(purpose, scope.fields);
    const plan = this.reusePlan(purpose, scope);
    // 栅栏按用途独立：另一个用途的采集不会干扰本用途的索引构建。
    const fenceKey = `fence:${purpose}`;
    const fence = Number(this.store.metaGet(fenceKey) ?? '0') + 1;
    this.store.metaSet(fenceKey, String(fence));
    const jobId = `J-${crypto.randomBytes(4).toString('hex')}`;
    this.store.db.prepare(`
      INSERT INTO jobs (id, purpose, status, scope_json, signature, progress_json, created_at, updated_at,
        elapsed_ms, fence, reuse_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, purpose, 'running', JSON.stringify(scope), scope.signature,
      JSON.stringify({ done: 0, total: CHUNK_COUNT }), nowIso(), nowIso(), 0, fence, JSON.stringify(plan));
    this.store.audit('job.start', purpose, 'ok', null, { jobId, fields: scope.fields, fence });

    const job = {
      id: jobId,
      purpose,
      status: 'running',
      scope,
      token,
      plan,
      fence,
      breakAfter,
      speedMs: speedMs ?? this.source.latencyChunkMs,
      abort: new AbortController(),
      results: [],
      startedAt: Date.now()
    };
    this.active.set(jobId, job);
    this.run(job);
    return { jobId, tokenId: token.tokenId, scope, plan, fence };
  }

  async run(job) {
    const totalStart = Date.now();
    let processed = 0;
    const invalidations = [];
    try {
      for (let i = 0; i < CHUNK_COUNT; i += 1) {
        if (job.breakAfter != null && processed >= job.breakAfter) {
          job.status = 'interrupted';
          job.detail = { code: 'E_INTERRUPTED', message: '模拟断线：任务已中断，已接收块保留，可恢复' };
          break;
        }
        if (job.abort.signal.aborted) {
          job.status = 'interrupted';
          job.detail = { code: 'E_ABORTED', message: '任务已中断' };
          break;
        }
        const item = job.plan[i];
        const started = Date.now();
        if (item.action === 'reuse') {
          // 复用前再次读取落盘块，复核长度、行宽与内容哈希；任何不一致都退回下载。
          const check = this.verifyStoredChunk(job.purpose, i, job.scope.fields);
          if (!check.ok) {
            item.action = 'fetch';
            item.reason = check.reason;
            invalidations.push({ chunkIndex: i, fields: [], reason: check.reason });
          } else {
            processed += 1;
            job.results.push({ chunkIndex: i, action: 'reuse', fields: check.fields, durationMs: 0 });
            this.progress(job, i + 1, totalStart);
            continue;
          }
        }
        if (item.action === 'purge') {
          const cleared = this.purgeChunk(
            job.purpose, i, item.invalidatedBy || [], epochMap(this.authz, job.purpose, item.invalidatedBy || [])
          );
          invalidations.push({ chunkIndex: i, fields: item.invalidatedBy || [], reason: item.reason });
          job.results.push({ chunkIndex: i, action: 'purge-then-fetch', cleared, reason: item.reason });
        }
        let packet;
        try {
          packet = await this.source.fetchChunk(job.token.tokenId, job.purpose, i, { abort: job.abort.signal });
        } catch (err) {
          if (err.code === 'E_SCOPE_REVOKED') {
            const fields = err.detail?.revoked ?? [];
            const cleared = this.purgeRevokedEverywhere(job.purpose, fields, epochMap(this.authz, job.purpose, fields));
            invalidations.push({ chunkIndex: i, fields, reason: err.message });
            job.abort.abort();
            job.status = 'invalidated';
            job.detail = {
              code: 'E_SCOPE_REVOKED',
              message: `下载第 ${i} 块期间授权被缩小，未接收字节丢弃，块作废；所有已落盘副本中的撤权列均已清除`,
              revokedFields: fields, chunkIndex: i, cleared
            };
            break;
          }
          throw err;
        }
        if (job.speedMs !== this.source.latencyChunkMs) {
          await new Promise((r) => setTimeout(r, Math.max(0, job.speedMs - packet.latencyMs)));
        }
        if (job.breakAfter != null && processed + 1 > job.breakAfter) {
          job.status = 'interrupted';
          job.detail = { code: 'E_INTERRUPTED', message: '模拟断线：块字节未完整到达，已丢弃；任务可恢复' };
          break;
        }
        try {
          const result = this.receiver.receive(packet, { purpose: job.purpose, scope: job.scope });
          job.results.push({ ...result, action: 'fetch', durationMs: Date.now() - started });
        } catch (err) {
          job.results.push({
            chunkIndex: i, action: 'discard', code: err.code, message: err.message,
            detail: err.detail ?? {}, durationMs: Date.now() - started
          });
          if (err.code === 'E_FIELD_REVOKED') {
            const cleared = this.purgeRevokedEverywhere(
              job.purpose, err.detail?.revoked ?? [], epochMap(this.authz, job.purpose, err.detail?.revoked ?? [])
            );
            invalidations.push({ chunkIndex: i, fields: err.detail?.revoked ?? [], reason: err.message });
            job.abort.abort();
            job.status = 'invalidated';
            job.detail = { code: err.code, message: err.message, chunkIndex: i, revokedFields: err.detail?.revoked, cleared };
            break;
          }
          throw err;
        }
        processed += 1;
        this.progress(job, i + 1, totalStart);
      }
      if (job.status === 'running') {
        const verify = this.authz.checkScope(job.purpose, job.scope);
        if (!verify.ok) {
          job.status = 'invalidated';
          job.detail = { code: verify.code, message: '任务完成前授权版本已变化，任务结果作废，不发布范围' };
        } else {
          job.status = 'completed';
        }
      }
    } catch (err) {
      job.status = 'failed';
      job.detail = { code: err.code || 'E_INTERNAL', message: err.message, detail: err.detail ?? {} };
    }
    const elapsed = Date.now() - totalStart;
    this.store.db.prepare(
      'UPDATE jobs SET status = ?, progress_json = ?, updated_at = ?, finished_at = ?, elapsed_ms = ?, detail = ?, results_json = ? WHERE id = ?'
    ).run(
      job.status,
      JSON.stringify({ done: job.results.filter((r) => r.action !== 'discard').length, total: CHUNK_COUNT }),
      nowIso(), nowIso(), elapsed,
      job.detail ? JSON.stringify({ ...job.detail, invalidations }) : null,
      JSON.stringify(job.results),
      job.id
    );
    this.store.audit('job.finish', job.purpose, job.status === 'completed' ? 'ok' : 'warn', job.detail?.code ?? null, {
      jobId: job.id, status: job.status, elapsedMs: elapsed, invalidations,
      fetched: job.results.filter((r) => r.action === 'fetch' || r.action === 'purge-then-fetch').length
    });
    this.active.delete(job.id);
    return job;
  }

  progress(job, done, started) {
    this.store.db.prepare('UPDATE jobs SET progress_json = ?, updated_at = ?, elapsed_ms = ? WHERE id = ?')
      .run(JSON.stringify({ done, total: CHUNK_COUNT }), nowIso(), Date.now() - started, job.id);
  }

  /** 复用的最后一道闸：落盘内容必须仍完整、行宽一致且哈希未变。 */
  verifyStoredChunk(purpose, chunkIndex, fields) {
    const row = this.store.db.prepare('SELECT * FROM chunks WHERE purpose = ? AND chunk_index = ?').get(purpose, chunkIndex);
    if (!row) return { ok: false, reason: '块在复用前消失，改为下载' };
    const storedFields = JSON.parse(row.fields_json);
    if (storedFields.length !== fields.length || !storedFields.every((f) => fields.includes(f))) {
      return { ok: false, reason: '块字段集合在复用前变化，改为下载' };
    }
    const rows = JSON.parse(row.rows_json);
    for (const r of rows) {
      const keys = Object.keys(r);
      if (keys.length !== fields.length || !keys.every((k) => fields.includes(k))) {
        return { ok: false, reason: '块行宽与字段集合不一致，改为下载' };
      }
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    if (row.rows_hash && row.rows_hash !== hash) {
      return { ok: false, reason: '块内容哈希不一致（疑似损坏），改为下载' };
    }
    return { ok: true, fields: storedFields };
  }

  /** 从块中清除被撤列；块若已不完整则标记为需整块重取。 */
  purgeChunk(purpose, chunkIndex, fields, epochs = {}) {
    const row = this.store.db.prepare('SELECT * FROM chunks WHERE purpose = ? AND chunk_index = ?').get(purpose, chunkIndex);
    let cleared = 0;
    if (row) {
      const rows = JSON.parse(row.rows_json);
      const previous = JSON.parse(row.scope_json);
      const keep = JSON.parse(row.fields_json).filter((f) => !fields.includes(f));
      const nextRows = keep.length
        ? rows.map((r) => Object.fromEntries(keep.map((f) => [f, r[f]])))
        : [];
      const nextScope = {
        ...previous,
        fields: keep,
        fieldEpochs: Object.fromEntries(keep.map((f) => [f, previous.fieldEpochs?.[f] ?? 0])),
        signature: JSON.stringify({ p: purpose, f: keep.map((f) => [f, previous.fieldEpochs?.[f] ?? 0]) }),
        purgedAt: nowIso(),
        purgedFields: [...fields]
      };
      const nextRowsJson = JSON.stringify(nextRows);
      this.store.db.prepare(
        'UPDATE chunks SET rows_json = ?, fields_json = ?, scope_json = ?, signature = ?, status = ?, rows_hash = ? WHERE purpose = ? AND chunk_index = ?'
      ).run(nextRowsJson, JSON.stringify(keep), JSON.stringify(nextScope), nextScope.signature,
        keep.length ? 'partial' : 'voided',
        crypto.createHash('sha256').update(nextRowsJson).digest('hex'), purpose, chunkIndex);
      cleared = fields.length;
    }
    for (const field of fields) {
      this.store.db.prepare(
        'INSERT INTO invalidations (purpose, chunk_index, field, reason, field_epoch, at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(purpose, chunkIndex, field, '授权缩小：块内列清除', epochs[field] ?? 0, nowIso());
    }
    return cleared;
  }

  /** 撤权时对所有受影响块立即执行清除。 */
  purgeScope(purpose, revokedFields, epochs = {}) {
    const rows = this.store.db.prepare('SELECT chunk_index, fields_json FROM chunks WHERE purpose = ?').all(purpose);
    const touched = rows.filter((r) => JSON.parse(r.fields_json).some((f) => revokedFields.includes(f)));
    const details = touched.map((r) => ({
      chunkIndex: r.chunk_index,
      cleared: this.purgeChunk(purpose, r.chunk_index, revokedFields, epochs)
    }));
    return details;
  }

  /**
   * 撤权墓碑：每个字段一条，记录清除了多少块、多少个索引版本，并注明已作废的块号。
   * 墓碑只含字段名与计数，绝不含原值。
   */
  recordRevocation(purpose, fields, epochs, { chunks, indexVersions, indexColumns }) {
    if (!fields.length) return [];
    const chunkIndexes = (chunks ?? []).map((c) => c.chunkIndex);
    return fields.map((field) => {
      const count = (chunks ?? []).filter((c) => c.cleared > 0 || chunkIndexes.length === 0).length;
      const id = this.store.db.prepare(
        'INSERT INTO tombstones (at, purpose, field, field_epoch, cleared_chunks, cleared_index_versions, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(nowIso(), purpose, field, epochs[field] ?? 0,
        chunkIndexes.length || count,
        indexColumns?.[field] ?? indexVersions ?? 0,
        `撤权清除：块 ${chunkIndexes.join(', ') || '无'} 已无该列，索引按列清除；仅保留不可逆墓碑`
      );
      return Number(id.lastInsertRowid);
    });
  }
}
