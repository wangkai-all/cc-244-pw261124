import crypto from 'node:crypto';
import { DATASET } from '../config.js';
import { sortFields } from './authz.js';
import { chunkScopePayload } from './chunkScope.js';

export class ReceiverError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseComplete(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new ReceiverError('E_CHUNK_MALFORMED', '块内容无法解析，已丢弃，不与其他版本拼接');
  }
}

/**
 * 分块接收端：
 * 1) 先在暂存区校验长度与内容哈希，失败即丢弃；
 * 2) 解析后逐行逐列校验字段范围，越界列整块拒绝；
 * 3) 只有完整且一致的块才写入块存储。
 */
export class ChunkReceiver {
  constructor(store, authz) {
    this.store = store;
    this.authz = authz;
    this.pending = new Map();
  }

  validateEnvelope(packet, task) {
    const actualHash = sha(packet.body);
    if (packet.truncated && actualHash !== packet.headerHash) {
      throw new ReceiverError('E_CHUNK_TRUNCATED', '块字节被截断，接收端丢弃半包，不拼接', {
        chunkIndex: packet.chunkIndex, bytes: packet.bytes
      });
    }
    if (actualHash !== packet.headerHash) {
      throw new ReceiverError('E_HASH_MISMATCH', '内容哈希与包头不一致，块已丢弃', {
        chunkIndex: packet.chunkIndex, actualHash: actualHash.slice(0, 12), headerHash: packet.headerHash.slice(0, 12)
      });
    }
    let parsed;
    try {
      parsed = parseComplete(packet.body);
    } catch (err) {
      if (packet.truncated) {
        throw new ReceiverError('E_CHUNK_TRUNCATED', '块字节被截断，接收端丢弃半包，不拼接', { chunkIndex: packet.chunkIndex });
      }
      throw err;
    }
    if (parsed.revision !== DATASET.revision) {
      throw new ReceiverError('E_REVISION_MISMATCH', '数据集修订号与当前来源不一致，块作废', {
        chunkIndex: packet.chunkIndex, saw: parsed.revision, current: DATASET.revision
      });
    }
    const p = this.authz.require(task.purpose);
    const allowedNow = sortFields([...p.fields]);
    const envelopeFields = parsed.fields || [];
    const outside = envelopeFields.filter((f) => !task.scope.fields.includes(f));
    if (outside.length) {
      throw new ReceiverError('E_FIELD_NOT_GRANTED', `块含任务授权之外的列：${outside.join(', ')}，整块拒绝`, {
        chunkIndex: packet.chunkIndex, outside
      });
    }
    const revokedNow = envelopeFields.filter((f) => !allowedNow.includes(f));
    if (revokedNow.length) {
      throw new ReceiverError('E_FIELD_REVOKED', `块含已撤权列：${revokedNow.join(', ')}，整块拒绝`, {
        chunkIndex: packet.chunkIndex, revoked: revokedNow
      });
    }
    if (!parsed.rows?.length || parsed.chunkIndex !== packet.chunkIndex) {
      throw new ReceiverError('E_CHUNK_SHAPE', '块结构或序号不一致，块已丢弃', { chunkIndex: packet.chunkIndex });
    }
    for (const row of parsed.rows) {
      for (const key of Object.keys(row)) {
        if (!allowedNow.includes(key)) {
          throw new ReceiverError('E_ROW_FIELD_VIOLATION', `行内出现越权列 ${key}，整块拒绝`, {
            chunkIndex: packet.chunkIndex, field: key
          });
        }
      }
      if (Object.keys(row).length !== envelopeFields.length) {
        throw new ReceiverError('E_ROW_WIDTH', '行宽与块字段数不一致，块已丢弃', { chunkIndex: packet.chunkIndex });
      }
    }
    return { parsed, fields: envelopeFields, contentHash: actualHash };
  }

  receive(packet, task) {
    const { parsed, fields, contentHash } = this.validateEnvelope(packet, task);
    const p = this.authz.require(task.purpose);
    const fieldEpochs = Object.fromEntries(fields.map((f) => [f, p.fieldEpochs[f]]));
    const rowFingerprints = parsed.rows.map((r) => sha(JSON.stringify(r)).slice(0, 10));
    const scopeJson = JSON.stringify(chunkScopePayload(fields, fieldEpochs, task.purpose));
    const rowsJson = JSON.stringify(parsed.rows);
    this.store.db.prepare(`
      INSERT INTO chunks (purpose, chunk_index, rows_json, fields_json, scope_json, signature, revision,
        content_hash, rows_hash, bytes, duration_ms, received_at, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(purpose, chunk_index) DO UPDATE SET
        rows_json = excluded.rows_json, fields_json = excluded.fields_json, scope_json = excluded.scope_json,
        signature = excluded.signature, revision = excluded.revision, content_hash = excluded.content_hash,
        rows_hash = excluded.rows_hash, bytes = excluded.bytes, duration_ms = excluded.duration_ms,
        received_at = excluded.received_at, status = excluded.status, source = excluded.source
    `).run(
      task.purpose, packet.chunkIndex, rowsJson, JSON.stringify(fields), scopeJson,
      JSON.parse(scopeJson).signature, parsed.revision, contentHash, sha(rowsJson), packet.bytes,
      packet.latencyMs, new Date().toISOString(), 'ready', 'local-mock-source'
    );
    return {
      chunkIndex: packet.chunkIndex,
      fields,
      contentHash: contentHash.slice(0, 12),
      bytes: packet.bytes,
      rowCount: parsed.rows.length,
      rowFingerprints
    };
  }

  listChunks(purpose) {
    return this.store.db
      .prepare('SELECT * FROM chunks WHERE purpose = ? ORDER BY chunk_index')
      .all(purpose)
      .map((row) => ({
        chunkIndex: row.chunk_index,
        fields: JSON.parse(row.fields_json),
        contentHash: row.content_hash.slice(0, 12),
        status: row.status,
        bytes: row.bytes,
        receivedAt: row.received_at
      }));
  }
}
