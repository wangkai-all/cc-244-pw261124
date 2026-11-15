import crypto from 'node:crypto';
import { CHUNK_COUNT, CHUNK_SIZE, FIELDS, FIELD_MAP, ROWS, DATASET } from '../config.js';
import { fingerprint } from '../crypto.js';

export class SourceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const FIELD_ORDER = FIELDS.map((f) => f.key);

/** 模拟数据来源。来源独立校验字段范围、签发范围令牌，并拒绝越权读取。 */
export class MockSource {
  constructor(authz, { latencyChunkMs = 220, faults = {} } = {}) {
    this.authz = authz;
    this.latencyChunkMs = latencyChunkMs;
    this.faults = new Map(Object.entries(faults));
    this.tokens = new Map();
    this.requests = [];
    this.reportedFields = new Set();
  }

  catalog() {
    return {
      dataset: DATASET,
      fields: FIELDS,
      chunkCount: CHUNK_COUNT,
      chunkRows: CHUNK_SIZE,
      sourceName: '本地模拟来源（虚构数据）',
      network: '未访问任何外部地址'
    };
  }

  setFault(key, value) {
    if (value == null) this.faults.delete(key);
    else this.faults.set(key, value);
  }

  scopeFor(purpose, granted) {
    const p = this.authz.require(purpose);
    const fields = granted.filter((f) => p.fields.has(f));
    return {
      dataset: DATASET.id,
      revision: DATASET.revision,
      purpose,
      fields,
      epoch: p.epoch,
      purposeVersion: p.version
    };
  }

  /** 签发一次性范围令牌；令牌只代表签发时可见的字段。 */
  requestScope(purpose, requestedFields, ttlSeconds = 300) {
    const p = this.authz.require(purpose);
    if (!Array.isArray(requestedFields) || requestedFields.length === 0) {
      throw new SourceError('E_SCOPE_EMPTY', '来源拒绝空字段范围');
    }
    const unknown = requestedFields.filter((f) => !FIELD_MAP[f]);
    if (unknown.length) throw new SourceError('E_FIELD_UNKNOWN', `来源拒绝未知字段：${unknown.join(', ')}`, { unknown });
    const outside = requestedFields.filter((f) => !p.allowed.has(f));
    if (outside.length) {
      throw new SourceError(
        'E_SCOPE_OUT_OF_PURPOSE',
        `来源拒绝用途「${p.label}」之外的字段：${outside.join(', ')}`,
        { outside, allowed: [...p.allowed] }
      );
    }
    const granted = FIELD_ORDER.filter((f) => requestedFields.includes(f) && p.fields.has(f));
    if (granted.length === 0) throw new SourceError('E_SCOPE_EMPTY', '来源签发范围内没有当前授权字段');
    const token = {
      id: `T-${crypto.randomBytes(6).toString('hex')}`,
      purpose,
      fields: granted,
      signature: JSON.stringify({ purpose, fields: granted, epoch: p.epoch }),
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
      usedChunks: new Set()
    };
    this.tokens.set(token.id, token);
    return { tokenId: token.id, fields: granted, expiresAt: token.expiresAt, ttlSeconds };
  }

  /** 令牌按块消费：同一块不能重复使用同一令牌，避免重放；不同块共享一次任务授权。 */
  consumeToken(tokenId, purpose, chunkIndex) {
    const token = this.tokens.get(tokenId);
    if (!token) throw new SourceError('E_TOKEN_UNKNOWN', '范围令牌不存在或已被清理');
    if (token.purpose !== purpose) throw new SourceError('E_TOKEN_PURPOSE_MISMATCH', '范围令牌与任务用途不匹配');
    if (Date.now() > token.expiresAt) throw new SourceError('E_TOKEN_EXPIRED', '范围令牌已过期，请重新授权下载');
    if (token.usedChunks.has(chunkIndex)) {
      throw new SourceError('E_TOKEN_REPLAY', `范围令牌已用于第 ${chunkIndex} 块，拒绝重放`);
    }
    token.usedChunks.add(chunkIndex);
    return token;
  }

  /** 分块生成：半包模拟只返回部分字节，接收端必须丢弃且不得拼接。 */
  async fetchChunk(tokenId, purpose, chunkIndex, { abort } = {}) {
    const token = this.consumeToken(tokenId, purpose, chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= CHUNK_COUNT) {
      throw new SourceError('E_CHUNK_RANGE', `块序号越界：${chunkIndex}`);
    }
    await new Promise((r) => setTimeout(r, this.latencyChunkMs));
    if (abort?.aborted) throw new SourceError('E_ABORTED', '下载已中断');

    const p = this.authz.require(purpose);
    const currentFields = FIELD_ORDER.filter((f) => token.fields.includes(f) && p.fields.has(f));
    const revokedDuringDownload = token.fields.filter((f) => !p.fields.has(f));
    if (revokedDuringDownload.length) {
      throw new SourceError(
        'E_SCOPE_REVOKED',
        `下载期间字段被撤出用途：${revokedDuringDownload.join(', ')}；该块整块作废`,
        { revoked: revokedDuringDownload, chunkIndex, discardsChunk: true }
      );
    }
    if (!currentFields.length) throw new SourceError('E_SCOPE_EMPTY', '当前授权没有可选字段');

    const start = chunkIndex * CHUNK_SIZE;
    const sourceRows = ROWS.slice(start, start + CHUNK_SIZE);
    const rows = sourceRows.map((row) => Object.fromEntries(currentFields.map((f) => [f, row[f]])));
    const payload = {
      dataset: DATASET.id,
      revision: DATASET.revision,
      purpose,
      chunkIndex,
      rowCount: rows.length,
      fields: currentFields,
      rows
    };
    let body = JSON.stringify(payload);
    const contentHash = crypto.createHash('sha256').update(body).digest('hex');
    const truncation = this.faults.get(`truncate:${chunkIndex}`) ?? this.faults.get('truncate');
    let truncated = false;
    if (truncation) {
      body = body.slice(0, Math.max(1, Math.floor(body.length * truncation)));
      truncated = true;
    }
    const corruption = this.faults.get(`corrupt:${chunkIndex}`) ?? this.faults.get('corrupt');
    if (corruption) {
      body = body.replace(/"C-30\d\d"/, '"C-99xx"');
    }
    const fail = this.faults.get(`fail:${chunkIndex}`);
    if (fail) {
      // 只暴露错误码与块号；故障注入的原始负载绝不进入错误详情。
      throw new SourceError(fail.code || 'E_SOURCE_FAIL', fail.message || `来源在第 ${chunkIndex} 块失败`, {
        chunkIndex, retryable: true
      });
    }

    this.requests.push({ at: new Date().toISOString(), chunkIndex, fields: currentFields, truncated, corrupted: Boolean(corruption) });
    for (const f of currentFields) this.reportedFields.add(f);
    return {
      chunkIndex,
      purpose,
      revision: DATASET.revision,
      fields: currentFields,
      body,
      headerHash: contentHash,
      bytes: Buffer.byteLength(body),
      latencyMs: this.latencyChunkMs,
      truncated,
      corrupted: Boolean(corruption),
      rowCount: rows.length,
      sourceFingerprint: fingerprint(body.slice(0, 64))
    };
  }
}
