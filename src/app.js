import { DATASET, FIELDS, FIELD_MAP, POLICY, PURPOSE_LIST, ROW_COUNT, CHUNK_COUNT } from './config.js';
import { Store } from './db.js';
import { AuthzError, AuthzStore, sortFields } from './services/authz.js';
import { Collector, CollectorError } from './services/collector.js';
import { ChunkReceiver, ReceiverError } from './services/receiver.js';
import { Indexer, IndexError } from './services/indexer.js';
import { Exporter, ExportError } from './services/exporter.js';
import { MockSource, SourceError } from './services/source.js';

const HTTP = {
  E_FIELD_UNKNOWN: 400, E_FIELD_EMPTY: 400, E_FIELD_INVALID: 400, E_FIELD_OUT_OF_PURPOSE: 400,
  E_PURPOSE_UNKNOWN: 404, E_SCOPE_EMPTY: 400, E_SCOPE_REVOKED: 409, E_SCOPE_STALE: 409,
  E_TOKEN_UNKNOWN: 400, E_TOKEN_REPLAY: 409, E_TOKEN_EXPIRED: 410, E_TOKEN_PURPOSE_MISMATCH: 409,
  E_CHUNK_RANGE: 400, E_CHUNK_TRUNCATED: 422, E_CHUNK_MALFORMED: 422, E_HASH_MISMATCH: 422, E_REVISION_MISMATCH: 409,
  E_FIELD_NOT_GRANTED: 403, E_FIELD_REVOKED: 403, E_CHUNK_SHAPE: 422, E_ROW_FIELD_VIOLATION: 403,
  E_ROW_WIDTH: 422, E_JOB_UNKNOWN: 404, E_JOB_PURPOSE: 400, E_FENCE: 409,
  E_INDEX_SOURCE_INCOMPLETE: 409, E_INDEX_MISSING: 404, E_INDEX_NOT_ACTIVE: 409, E_INDEX_STALE: 409,
  E_BUILD_ABORTED: 409, E_CAS_FAILED: 409, E_ABORTED: 409, E_FORMAT: 400,
  E_BODY_INVALID: 400, E_JOB_NOT_COMPLETED: 409, E_JOB_SCOPE_STALE: 409, E_INTERNAL: 500
};

export function createApp({ dbFile = ':memory:', latencyChunkMs = 220, faults = {} } = {}) {
  const store = new Store(dbFile);
  const authz = new AuthzStore(DATASET.revision);
  const source = new MockSource(authz, { latencyChunkMs, faults });
  const receiver = new ChunkReceiver(store, authz);
  const collector = new Collector({ store, authz, source, receiver });
  const indexer = new Indexer({ store, authz });
  const exporter = new Exporter({ store, authz, indexer });
  collector.attachIndexer(indexer);

  authz.onRevoke((purpose, payload) => store.tx(() => {
    const chunks = collector.purgeScope(purpose, payload.removed, payload.fieldEpochs);
    const index = indexer.purgeScope(purpose, payload.removed);
    collector.recordRevocation(purpose, payload.removed, payload.fieldEpochs, {
      chunks, indexColumns: index.columns, indexVersions: index.versions
    });
    store.audit('authz.fields', purpose, 'ok', null, {
      fields: payload.fields, removed: payload.removed, added: payload.added,
      purgedChunks: chunks.length, purgedIndexColumns: index.columns
    });
    return { chunks, indexVersions: index.versions, indexColumns: index.columns };
  }));

  const api = {
    store, authz, source, receiver, collector, indexer, exporter,

    meta() {
      return {
        dataset: DATASET,
        fields: FIELDS,
        purposes: PURPOSE_LIST.map((p) => ({ key: p.key, label: p.label, description: p.description, allowed: p.allowedFields })),
        rowCount: ROW_COUNT,
        chunkCount: CHUNK_COUNT,
        policy: POLICY,
        dataNotice: '全部记录为本地生成的虚构数据（example.test 域名），系统不访问外部网络。'
      };
    },

    state(purpose) {
      const snap = authz.snapshot();
      const chunks = purpose ? receiver.listChunks(purpose) : [];
      const jobs = collector.listJobs(purpose ?? null);
      const versions = indexer.listVersions(purpose ?? null);
      const active = purpose ? indexer.activeVersion(purpose) : null;
      const exports = exporter.history(purpose ?? null);
      const invalidations = store.db.prepare(
        purpose ? 'SELECT * FROM invalidations WHERE purpose = ? ORDER BY id DESC LIMIT 60'
          : 'SELECT * FROM invalidations ORDER BY id DESC LIMIT 60'
      ).all(...(purpose ? [purpose] : []));
      const audit = store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 80').all().map((a) => ({
        id: a.id, at: a.at, action: a.action, purpose: a.purpose, outcome: a.outcome, code: a.code,
        detail: a.detail_json ? JSON.parse(a.detail_json) : null
      }));
      const tombstones = store.db.prepare(
        purpose ? 'SELECT * FROM tombstones WHERE purpose = ? ORDER BY id DESC LIMIT 40'
          : 'SELECT * FROM tombstones ORDER BY id DESC LIMIT 40'
      ).all(...(purpose ? [purpose] : []));
      return {
        authz: snap,
        chunks,
        jobs: jobs.slice(0, 20),
        indexVersions: versions.slice(0, 20),
        activeIndex: active ? { id: active.id, version: active.version, status: active.status, fields: JSON.parse(active.fields_json) } : null,
        exports: exports.slice(0, 20),
        invalidations,
        audit,
        tombstones
      };
    },

    /** 只计算下一次采集的块判定，不签令牌、不下载，用于页面解释“哪些块会复用/作废”。 */
    planPreview(purpose) {
      const p = authz.require(purpose);
      const scope = authz.scopeToken(purpose);
      const plan = collector.reusePlan(purpose, scope);
      const summary = {
        reuse: plan.filter((x) => x.action === 'reuse').length,
        fetch: plan.filter((x) => x.action === 'fetch').length,
        purge: plan.filter((x) => x.action === 'purge').length
      };
      return { purpose, scope: { fields: scope.fields, fieldEpochs: scope.fieldEpochs }, plan, summary, checkedAt: new Date().toISOString() };
    },

    async runJob({ purpose, fields, simulate }) {
      const breakAfter = simulate?.mode === 'disconnect' ? Number(simulate.afterChunks) : null;
      return collector.start({ purpose, fields, breakAfter });
    },

    async waitJob(jobId) {
      for (let i = 0; i < 200; i += 1) {
        const job = collector.getJob(jobId);
        if (job && job.status !== 'running') return job;
        await new Promise((r) => setTimeout(r, 60));
      }
      return collector.getJob(jobId);
    },

    setFields(purpose, fields) {
      const result = authz.setFields(purpose, fields);
      if (!result.changed) return { changed: false, message: '字段范围未变化' };
      return {
        changed: true,
        removed: result.removed,
        added: result.added,
        revoked: result.revoked,
        purge: result.purges?.[0] ?? { chunks: [], indexVersions: 0, indexColumns: {} },
        fields: sortFields([...result.purpose.fields]),
        fieldEpochs: { ...result.purpose.fieldEpochs }
      };
    },

    commitIndex({ purpose, jobId }) {
      return indexer.build({ purpose, jobId });
    }
  };

  return { api, store, authz, source, receiver, collector, indexer, exporter };
}

export function classifyError(err) {
  const code = err.code || 'E_INTERNAL';
  return {
    status: HTTP[code] ?? (err instanceof AuthzError || err instanceof CollectorError
      || err instanceof ReceiverError || err instanceof IndexError || err instanceof ExportError
      || err instanceof SourceError ? 400 : 500),
    body: { error: { code, message: err.message || '未知错误', detail: err.detail ?? {} } }
  };
}
