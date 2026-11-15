import crypto from 'node:crypto';
import { FIELDS } from './config.js';

const SALT = 'fieldscope-lab-v1';
const cache = new Map();

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 不可逆指纹：仅用于完整性、去重与墓碑展示，不能还原原值。 */
export function fingerprint(value) {
  return digest(`${SALT}|${value}`).slice(0, 12);
}

/** 按行+列生成确定性遮蔽替换值，长度与类别稳定，便于演练对照。 */
export function maskValue(column, rowId) {
  const key = `${column}:${rowId}`;
  if (cache.has(key)) return cache.get(key);
  const field = FIELDS.find((f) => f.key === column);
  const h = digest(`${SALT}|mask|${key}`);
  let out;
  if (field?.kind === 'number') out = '••••';
  else if (field?.sensitivity === 'high') out = `⟨已撤权·${h.slice(0, 4)}⟩`;
  else out = `⟨遮蔽·${h.slice(0, 6)}⟩`;
  cache.set(key, out);
  return out;
}

export function redactError(error) {
  return { code: error.code || 'E_INTERNAL', message: error.message || '未知错误' };
}

export function mergeScopes(scopes) {
  const out = new Set();
  for (const list of scopes) for (const f of list) out.add(f);
  return [...out];
}
