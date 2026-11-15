import { FIELDS, FIELD_MAP, PURPOSES } from '../config.js';

/** 范围签名只包含用途、字段集合与每列纪元；任何一列的版本变化都会改变它。 */
export function scopeSignature(purposeKey, fields, fieldEpochs) {
  return JSON.stringify({
    p: purposeKey,
    f: sortFields(fields).map((f) => [f, fieldEpochs[f]])
  });
}

export class AuthzError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const ORDER = FIELDS.map((f) => f.key);
export function sortFields(list) {
  return [...new Set(list)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

export function validateFieldSelection(purposeKey, purpose, requested) {
  if (!Array.isArray(requested)) {
    throw new AuthzError('E_FIELD_INVALID', '字段范围必须是数组');
  }
  if (requested.length === 0) {
    throw new AuthzError('E_FIELD_EMPTY', '至少选择一个字段');
  }
  const unknown = requested.filter((f) => !FIELD_MAP[f]);
  if (unknown.length) {
    throw new AuthzError('E_FIELD_UNKNOWN', `未知字段：${unknown.join(', ')}，请求已拒绝`, { unknown });
  }
  const disallowed = requested.filter((f) => !purpose.allowedFields.includes(f));
  if (disallowed.length) {
    throw new AuthzError(
      'E_FIELD_OUT_OF_PURPOSE',
      `用途「${purpose.label}」不允许字段：${disallowed.join(', ')}，请求已拒绝`,
      { disallowed, allowed: purpose.allowedFields }
    );
  }
  return sortFields(requested);
}

export class AuthzStore {
  constructor(revision) {
    this.revision = revision;
    this.purposes = new Map();
    for (const p of Object.values(PURPOSES)) {
      this.purposes.set(p.key, {
        key: p.key,
        label: p.label,
        allowed: new Set(p.allowedFields),
        fields: new Set(p.defaultFields),
        version: 0,
        epoch: 0,
        fieldEpochs: Object.fromEntries(p.allowedFields.map((f) => [f, 0])),
        updatedAt: new Date().toISOString()
      });
    }
    this.revocations = [];
    this.changeSeq = 0;
    this.revokeHooks = [];
  }

  /** 撤权副作用（清块、清索引）注册在此，任何入口改字段都会触发，无法绕过。 */
  onRevoke(hook) {
    this.revokeHooks.push(hook);
  }

  require(purposeKey) {
    const p = this.purposes.get(purposeKey);
    if (!p) throw new AuthzError('E_PURPOSE_UNKNOWN', '未知用途');
    return p;
  }

  snapshot() {
    return {
      revision: this.revision,
      changeSeq: this.changeSeq,
      purposes: [...this.purposes.values()].map((p) => ({
        key: p.key,
        label: p.label,
        description: PURPOSES[p.key].description,
        allowed: sortFields([...p.allowed]),
        fields: sortFields([...p.fields]),
        version: p.version,
        epoch: p.epoch,
        fieldEpochs: { ...p.fieldEpochs },
        updatedAt: p.updatedAt
      })),
      revocations: this.revocations.slice(-50)
    };
  }

  setFields(purposeKey, requested) {
    const p = this.require(purposeKey);
    const fields = validateFieldSelection(purposeKey, { label: p.label, allowedFields: [...p.allowed] }, requested);
    const before = new Set(p.fields);
    const after = new Set(fields);
    const removed = [...before].filter((f) => !after.has(f));
    const added = [...after].filter((f) => !before.has(f));
    if (!removed.length && !added.length) {
      return { changed: false, purpose: p, revoked: [] };
    }
    p.fields = after;
    p.version += 1;
    p.epoch += 1;
    p.updatedAt = new Date().toISOString();
    const revoked = removed.map((field) => {
      p.fieldEpochs[field] += 1;
      const tombstone = {
        id: `R-${String(this.revocations.length + 1).padStart(4, '0')}`,
        seq: ++this.changeSeq,
        purpose: p.key,
        field,
        fieldEpoch: p.fieldEpochs[field],
        purposeVersion: p.version,
        datasetRevision: this.revision,
        at: p.updatedAt,
        note: `${p.label}：${FIELD_MAP[field].label} 已移出用途范围`
      };
      this.revocations.push(tombstone);
      return tombstone;
    });
    const payload = {
      removed: removed ?? [],
      added: added ?? [],
      revoked,
      fields: sortFields([...p.fields]),
      fieldEpochs: Object.fromEntries((removed ?? []).map((f) => [f, p.fieldEpochs[f]]))
    };
    const purges = [];
    if (removed.length) for (const hook of this.revokeHooks) purges.push(hook(purposeKey, payload));
    return { changed: true, purpose: p, removed, added, revoked, purges };
  }

  /** 用于比较并交换的授权指纹：只看字段集合与各字段纪元，与整包版本号无关。 */
  scopeToken(purposeKey) {
    const p = this.require(purposeKey);
    const fields = sortFields([...p.fields]);
    const fieldEpochs = Object.fromEntries(fields.map((f) => [f, p.fieldEpochs[f]]));
    return {
      purpose: p.key,
      version: p.version,
      epoch: p.epoch,
      fields,
      fieldEpochs,
      signature: scopeSignature(p.key, fields, fieldEpochs)
    };
  }

  /** 在任务/索引/导出每个关键点复核当前授权，拒绝越界字段。 */
  checkScope(purposeKey, scope) {
    const current = this.scopeToken(purposeKey);
    if (!scope) {
      return { ok: false, code: 'E_SCOPE_MISSING', current };
    }
    // 任务范围是当前授权的子集即可（页面可能只选部分字段），但每一列都必须仍被授权。
    const outside = scope.fields.filter((f) => !current.fields.includes(f));
    if (outside.length) {
      return { ok: false, code: 'E_SCOPE_REVOKED', detail: { outside }, current };
    }
    const epochMismatch = scope.fields.filter(
      (f) => current.fieldEpochs[f] !== scope.fieldEpochs?.[f]
    );
    if (epochMismatch.length) {
      return { ok: false, code: 'E_SCOPE_STALE', detail: { fields: epochMismatch }, current };
    }
    // 任务只需保证自己的字段仍被授权且纪元未变；之后新增的字段不会让旧任务扩大范围。
    return { ok: true, current };
  }
}
