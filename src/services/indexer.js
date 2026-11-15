import crypto from 'node:crypto';
import { CHUNK_COUNT, DATASET, FIELDS, FIELD_MAP } from '../config.js';
import { scopeSignature, sortFields } from './authz.js';
import { chunkVerdict } from './chunkScope.js';
import { maskValue } from '../crypto.js';

export class IndexError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const nowIso = () => new Date().toISOString();
const ID_ORDER = FIELDS.map((f) => f.key);

function buildDocs(rows, fields, extraMask = []) {
  return rows.map((row) => {
    const id = row.customer_id;
    const cells = {};
    for (const f of fields) {
      cells[f] = extraMask.includes(f) ? maskValue(f, id) : row[f];
    }
    return { customer_id: id, cells };
  });
}

/** 索引：任务栅栏 + 构建前后两次授权复核，提交时比较并交换。 */
export class Indexer {
  constructor({ store, authz }) {
    this.store = store;
    this.authz = authz;
    this.building = 0;
  }

  listVersions(purpose) {
    const rows = purpose
      ? this.store.db.prepare('SELECT * FROM index_versions WHERE purpose = ? ORDER BY version DESC').all(purpose)
      : this.store.db.prepare('SELECT * FROM index_versions ORDER BY id DESC').all();
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      version: r.version,
      status: r.status,
      fields: JSON.parse(r.fields_json),
      signature: r.signature,
      revision: r.revision,
      jobId: r.job_id,
      fence: r.fence,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      detail: r.detail ? JSON.parse(r.detail) : null,
      docCount: r.docs_json ? JSON.parse(r.docs_json).length : 0
    }));
  }

  /** 只有 status=active 的版本可被查询；失败/作废的构建不会遮蔽上一份可用索引。 */
  activeVersion(purpose) {
    return this.store.db
      .prepare("SELECT * FROM index_versions WHERE purpose = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(purpose);
  }

  async build({ purpose, jobId = null, breakBeforeCommit = false, delayMs = 0 }) {
    this.building += 1;
    try {
      return await this.#build({ purpose, jobId, breakBeforeCommit, delayMs });
    } finally {
      this.building -= 1;
    }
  }

  async #build({ purpose, jobId, breakBeforeCommit, delayMs }) {
    const p = this.authz.require(purpose);
    const scope = this.authz.scopeToken(purpose);
    // 版本号必须单调递增，撤权清空全部版本后也不能回到 v1，否则审计无法区分新旧。
    const last = this.store.db
      .prepare('SELECT MAX(version) AS v FROM index_versions WHERE purpose = ?')
      .get(purpose);
    const version = Number(last?.v ?? 0) + 1;
    const fenceKey = `fence:${purpose}`;
    const fence = Number(this.store.metaGet(fenceKey) ?? '0');
    const job = jobId ? this.store.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) : null;
    if (jobId && !job) throw new IndexError('E_JOB_UNKNOWN', '指定的任务不存在');
    if (job && job.purpose !== purpose) throw new IndexError('E_JOB_PURPOSE', '任务与索引用途不一致');
    if (job) {
      if (job.status !== 'completed') {
        throw new IndexError('E_JOB_NOT_COMPLETED', '只能基于已完成的任务发布索引', { status: job.status });
      }
      const jobScope = JSON.parse(job.scope_json);
      // 任务必须正好覆盖当前授权：多一列（已撤权）或少一列（撤权后新授权）都不能发布。
      const sameFields = jobScope.fields.length === scope.fields.length
        && scope.fields.every((f) => jobScope.fields.includes(f));
      const sameEpochs = scope.fields.every((f) => jobScope.fieldEpochs?.[f] === scope.fieldEpochs[f]);
      if (!sameFields || !sameEpochs || jobScope.signature !== scope.signature) {
        throw new IndexError(
          'E_JOB_SCOPE_STALE',
          '任务范围与当前授权不一致（任务可能完成于撤权之前），拒绝发布；请重新采集后再发布',
          { jobFields: jobScope.fields, currentFields: scope.fields }
        );
      }
      if (job.fence > fence) throw new IndexError('E_FENCE', '任务栅栏超前，拒绝构建');
    }

    // 块必须覆盖索引所需的全部当前字段，且每列纪元一致；否则拒绝用部分数据建索引。
    const chunkRows = this.store.db.prepare('SELECT * FROM chunks WHERE purpose = ? ORDER BY chunk_index').all(purpose);
    const epochMap = Object.fromEntries(scope.fields.map((f) => [f, p.fieldEpochs[f]]));
    const staleChunks = [];
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      const row = chunkRows.find((c) => c.chunk_index === i);
      // 索引字段必须由块完整提供；块内若还留有当前授权之内的其他列不构成问题。
      const verdict = chunkVerdict({ row, purpose, fields: scope.fields, fieldEpochs: epochMap });
      if (verdict.action === 'fetch' || verdict.action === 'purge') staleChunks.push(i);
    }
    if (staleChunks.length) {
      throw new IndexError(
        'E_INDEX_SOURCE_INCOMPLETE',
        '索引构建前复核失败：存在未下载、缺列或纪元过期的块，拒绝用部分数据建索引',
        { staleChunks }
      );
    }

    const insert = this.store.db.prepare(`
      INSERT INTO index_versions (purpose, version, status, fields_json, docs_json, signature, revision,
        job_id, fence, created_at, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insert.run(purpose, version, 'building', JSON.stringify(scope.fields), null,
      scope.signature, DATASET.revision, jobId, fence, nowIso(),
      JSON.stringify({ stage: 'collect', startedAt: nowIso() }));
    const id = Number(info.lastInsertRowid);

    const rows = [];
    for (const row of chunkRows) {
      if (row.status === 'voided') continue;
      for (const r of JSON.parse(row.rows_json)) rows.push(r);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

    // 模拟构建设置的延迟窗口内可能发生撤权：这里给出中断点。
    if (breakBeforeCommit) {
      this.store.db.prepare('UPDATE index_versions SET status = ?, detail = ? WHERE id = ?')
        .run('aborted', JSON.stringify({ stage: 'aborted', code: 'E_BUILD_ABORTED', message: '构建在提交前被中断' }), id);
      this.store.audit('index.build', purpose, 'warn', 'E_BUILD_ABORTED', { id, version });
      return { ok: false, code: 'E_BUILD_ABORTED', id, version };
    }

    const docs = buildDocs(rows, scope.fields);
    const verify = this.authz.checkScope(purpose, scope);
    const latestFence = Number(this.store.metaGet(fenceKey) ?? '0');
    if (!verify.ok) {
      this.store.db.prepare('UPDATE index_versions SET status = ?, detail = ? WHERE id = ?').run(
        'aborted',
        JSON.stringify({ stage: 'precommit', code: verify.code, message: '构建期间授权版本变化，索引作废，不发布旧范围' }),
        id
      );
      this.store.audit('index.build', purpose, 'warn', verify.code, { id, version });
      return { ok: false, code: verify.code, id, version };
    }
    if (latestFence !== fence) {
      this.store.db.prepare('UPDATE index_versions SET status = ?, detail = ? WHERE id = ?').run(
        'aborted', JSON.stringify({ stage: 'precommit', code: 'E_FENCE', message: '任务栅栏变化，索引作废' }), id
      );
      return { ok: false, code: 'E_FENCE', id, version };
    }

    const result = this.store.tx(() => {
      const current = this.authz.scopeToken(purpose);
      if (current.signature !== scope.signature) {
        this.store.db.prepare('UPDATE index_versions SET status = ?, detail = ? WHERE id = ?').run(
          'aborted', JSON.stringify({ code: 'E_CAS_FAILED', message: '提交时比较并交换失败：授权已变化' }), id
        );
        return { ok: false, code: 'E_CAS_FAILED' };
      }
      this.store.db.prepare('UPDATE index_versions SET status = ? WHERE purpose = ? AND status = ?')
        .run('superseded', purpose, 'active');
      this.store.db.prepare(
        'UPDATE index_versions SET status = ?, docs_json = ?, published_at = ?, detail = ? WHERE id = ?'
      ).run('active', JSON.stringify(docs), nowIso(),
        JSON.stringify({ stage: 'published', docCount: docs.length, rows: rows.length }), id);
      return { ok: true };
    });
    if (!result.ok) {
      this.store.audit('index.build', purpose, 'warn', result.code, { id, version });
      return { ...result, id, version };
    }
    this.store.audit('index.build', purpose, 'ok', null, { id, version, fields: scope.fields });
    return { ok: true, id, version, docCount: docs.length, fields: scope.fields };
  }

  /** 读取索引：每次按当前授权再校验；可遮蔽已撤列，绝不返回原值。 */
  query({ purpose, fields, search = '', maskRevoked = true }) {
    const p = this.authz.require(purpose);
    const current = this.authz.scopeToken(purpose);
    const requested = fields ? sortFields(fields) : [...p.fields];
    // 字段范围先于索引状态校验：越权请求必须收到授权错误，而不是“先建索引再说”。
    const outsideNow = requested.filter((f) => !p.fields.has(f));
    if (outsideNow.length) {
      throw new IndexError('E_FIELD_REVOKED', `查询字段已不在当前授权内：${outsideNow.join(', ')}`, { outside: outsideNow });
    }
    const active = this.activeVersion(purpose);
    if (!active) throw new IndexError('E_INDEX_MISSING', '没有可用的索引，请先构建');
    if (active.status !== 'active') throw new IndexError('E_INDEX_NOT_ACTIVE', '索引未处于可发布状态');
    const storedFields = JSON.parse(active.fields_json);
    // 双向核对：索引里有、授权里没有 → 过期列；授权里有、索引里没有 → 需重建补列。
    const revokedInIndex = storedFields.filter((f) => !current.fields.includes(f));
    const missingFromIndex = requested.filter((f) => !storedFields.includes(f));
    const staleFields = [...new Set([...revokedInIndex, ...missingFromIndex])];
    const stale = active.signature !== current.signature || staleFields.length > 0;
    if (stale && !maskRevoked) {
      throw new IndexError('E_INDEX_STALE', '索引授权版本过期，拒绝按旧范围服务', { stale: true, staleFields });
    }
    const masked = [...new Set([...revokedInIndex.filter((f) => requested.includes(f)), ...missingFromIndex])];
    const docsRaw = active.docs_json ? JSON.parse(active.docs_json) : [];
    const needle = search.trim().toLowerCase();
    const rows = docsRaw
      .map((d) => {
        const cells = {};
        for (const f of requested) {
          if (revokedInIndex.includes(f) || missingFromIndex.includes(f)) cells[f] = maskValue(f, d.customer_id);
          else cells[f] = d.cells[f];
        }
        return { customer_id: d.customer_id, cells };
      })
      .filter((r) => !needle || Object.values(r).some((v) => String(v).toLowerCase().includes(needle))
        || Object.values(r.cells).some((v) => String(v).toLowerCase().includes(needle)));
    return {
      index: { id: active.id, version: active.version, fields: storedFields, signature: active.signature },
      requested,
      rows,
      stale,
      staleFields,
      revokedInIndex,
      missingFromIndex,
      masked,
      rowCount: rows.length,
      note: stale
        ? [
            revokedInIndex.length ? `索引含已撤权列 ${revokedInIndex.join(', ')}，已遮蔽` : '',
            missingFromIndex.length ? `索引缺少当前授权字段 ${missingFromIndex.join(', ')}，已遮蔽，需重建` : ''
          ].filter(Boolean).join('；') || '索引与当前授权版本不一致，已按当前授权遮蔽'
        : '索引与当前授权一致'
    };
  }

  /** 撤权时清除索引中的对应列；活动版本立即失效，旧版本一并清除原值。 */
  purgeScope(purpose, revokedFields) {
    const rows = this.store.db.prepare('SELECT * FROM index_versions WHERE purpose = ?').all(purpose);
    const columns = {};
    let versions = 0;
    for (const row of rows) {
      const fields = JSON.parse(row.fields_json);
      const touched = fields.filter((f) => revokedFields.includes(f));
      if (!touched.length) continue;
      const keep = fields.filter((f) => !revokedFields.includes(f));
      let docs = row.docs_json ? JSON.parse(row.docs_json) : null;
      if (docs) {
        docs = docs.map((d) => {
          const cells = Object.fromEntries(keep.map((f) => [f, d.cells[f]]));
          return { customer_id: d.customer_id, cells };
        });
      }
      // 只对当前活动索引重算范围签名：清除被撤列后若剩余列仍覆盖当前授权，索引可继续服务；
      // 之后重新授权新列会因缺列而变成 stale。历史版本保留原签名，作为审计证据。
      const epochs = Object.fromEntries(keep.map((f) => [f, this.authz.require(purpose).fieldEpochs[f] ?? 0]));
      const nextSignature = row.status === 'active'
        ? scopeSignature(purpose, keep, epochs)
        : row.signature;
      const status = row.status === 'active' ? (keep.length ? 'active' : 'voided') : 'voided';
      this.store.db.prepare(
        'UPDATE index_versions SET fields_json = ?, docs_json = ?, signature = ?, status = ?, detail = ? WHERE id = ?'
      ).run(JSON.stringify(keep), docs ? JSON.stringify(docs) : null, nextSignature, status,
        JSON.stringify({ stage: 'purged', revoked: touched, at: nowIso() }), row.id);
      for (const f of touched) columns[f] = (columns[f] ?? 0) + 1;
      versions += 1;
    }
    return { columns, versions };
  }
}
