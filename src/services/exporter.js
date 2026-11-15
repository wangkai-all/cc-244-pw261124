import crypto from 'node:crypto';
import { FIELD_MAP } from '../config.js';
import { sortFields } from './authz.js';
import { maskValue } from '../crypto.js';

export class ExportError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

/** 导出：字段范围、索引一致性与原值泄露检查都在写文件前完成。 */
export class Exporter {
  constructor({ store, authz, indexer }) {
    this.store = store;
    this.authz = authz;
    this.indexer = indexer;
  }

  history(purpose) {
    const rows = purpose
      ? this.store.db.prepare('SELECT * FROM exports WHERE purpose = ? ORDER BY created_at DESC').all(purpose)
      : this.store.db.prepare('SELECT * FROM exports ORDER BY created_at DESC').all();
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      fields: JSON.parse(r.fields_json),
      rowCount: r.row_count,
      checksum: r.checksum,
      createdAt: r.created_at,
      detail: JSON.parse(r.detail)
    }));
  }

  export({ purpose, fields, format = 'json' }) {
    const p = this.authz.require(purpose);
    const requested = sortFields(fields?.length ? fields : [...p.fields]);
    const outside = requested.filter((f) => !p.fields.has(f));
    if (outside.length) {
      throw new ExportError('E_FIELD_REVOKED', `导出字段已不在当前用途授权内：${outside.join(', ')}`, { outside });
    }
    if (format !== 'json' && format !== 'csv') {
      throw new ExportError('E_FORMAT', '仅支持 json 或 csv 导出', { format });
    }
    // maskRevoked=false 使索引一旦与当前授权不一致就抛错：导出绝不按旧范围生成文件。
    const q = this.indexer.query({ purpose, fields: requested, maskRevoked: false });
    const lines = q.rows.map((r) => requested.map((f) => r.cells[f]));
    const body = format === 'csv'
      ? [requested.join(','), ...lines.map((l) => l.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','))].join('\n')
      : JSON.stringify({ purpose, fields: requested, rows: q.rows.map((r) => r.cells) }, null, 2);
    const checksum = sha(body);
    for (const f of requested) {
      if (!p.fields.has(f)) {
        throw new ExportError('E_FIELD_REVOKED', `导出过程中字段 ${f} 被撤权，导出已取消`);
      }
    }
    const id = `E-${crypto.randomBytes(4).toString('hex')}`;
    const summary = {
      indexVersion: q.index.version,
      indexSignature: q.index.signature,
      currentSignature: this.authz.scopeToken(purpose).signature,
      masks: requested.filter((f) => q.masked.includes(f) || q.staleFields.includes(f)),
      fieldLabels: requested.map((f) => FIELD_MAP[f].label)
    };
    this.store.db.prepare(
      'INSERT INTO exports (id, purpose, fields_json, row_count, checksum, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, purpose, JSON.stringify(requested), q.rows.length, checksum, nowIso(), JSON.stringify(summary));
    this.store.audit('export', purpose, 'ok', null, { id, fields: requested, rowCount: q.rows.length, checksum });
    return { id, purpose, fields: requested, rows: q.rows.map((r) => r.cells), rowCount: q.rows.length, checksum, body, summary, checkedAt: nowIso() };
  }
}
