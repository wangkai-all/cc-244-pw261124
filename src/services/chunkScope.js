import { DATASET } from '../config.js';

/**
 * 块可用性的唯一判定入口：接收端、任务复用计划与索引构建共用同一套规则，
 * 避免“某一处认为可复用、另一处认为已过期”的权限版本混用。
 *
 * 返回 action:
 *  - reuse: 可复用
 *  - purge: 块内含已撤权列，必须清除后重取
 *  - fetch: 缺列、纪元不符或修订号不符，必须重取
 */
export function chunkVerdict({ row, purpose, fields, fieldEpochs, revision = DATASET.revision }) {
  if (!row) {
    return { action: 'fetch', code: 'E_CHUNK_ABSENT', reason: '该块从未接收，需下载' };
  }
  const storedFields = JSON.parse(row.fields_json);
  const stored = row.scope_json ? JSON.parse(row.scope_json) : {};
  const storedEpochs = stored.fieldEpochs ?? {};
  const outside = storedFields.filter((f) => !fields.includes(f));
  if (outside.length) {
    return {
      action: 'purge', outside, code: 'E_CHUNK_HAS_REVOKED',
      reason: `块内含已撤权列 ${outside.join(', ')}：清除该列后整块重取，不能复用`
    };
  }
  // 块字段必须覆盖任务字段：任务可以只采子集，但缺一列就必须整块重取。
  const missing = fields.filter((f) => !storedFields.includes(f));
  if (missing.length) {
    return {
      action: 'fetch', missing, code: 'E_CHUNK_MISSING_FIELD',
      reason: `块缺少任务所需字段 ${missing.join(', ')}（可能撤权后重新授权）：仅新增字段无法补齐，整块重取`
    };
  }
  if (row.revision !== revision) {
    return { action: 'fetch', code: 'E_CHUNK_REVISION', reason: `数据集修订号 ${row.revision} ≠ 当前 ${revision}，整块作废` };
  }
  const epochMismatch = storedFields.filter((f) => storedEpochs[f] !== fieldEpochs[f]);
  if (epochMismatch.length) {
    return {
      action: 'fetch', missing: epochMismatch, code: 'E_CHUNK_EPOCH',
      reason: `字段授权纪元变化（${epochMismatch.join(', ')}），旧块与当前授权版本不一致，整块重取`
    };
  }
  if (row.status === 'voided') {
    return { action: 'fetch', code: 'E_CHUNK_VOIDED', reason: '块已被清除，需重新下载' };
  }
  return {
    action: 'reuse', code: 'E_CHUNK_OK',
    reason: storedFields.length === fields.length
      ? '完整、字段与纪元均一致，可复用'
      : `块已覆盖全部任务字段（块内另有 ${storedFields.length - fields.length} 列也属当前授权），可复用`
  };
}

export function chunkScopePayload(fields, fieldEpochs, purpose) {
  return {
    purpose,
    fields,
    fieldEpochs,
    signature: JSON.stringify({ p: purpose, f: fields.map((f) => [f, fieldEpochs[f]]) })
  };
}
