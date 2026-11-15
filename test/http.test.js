import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, classifyError } from '../src/app.js';
import { AuthzError } from '../src/services/authz.js';

test('接口错误映射：越权 400/403，过期索引 409，且不回显原值', () => {
  const env = createApp({ dbFile: ':memory:', latencyChunkMs: 1 });
  const mapped = classifyError(new AuthzError('E_FIELD_OUT_OF_PURPOSE', '用途「账单核对」不允许字段：phone', { disallowed: ['phone'] }));
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error.code, 'E_FIELD_OUT_OF_PURPOSE');
  assert.ok(!mapped.body.error.message.includes('138-'));
  const stale = classifyError(Object.assign(new Error('索引过期'), { code: 'E_INDEX_STALE' }));
  assert.equal(stale.status, 409);
  assert.ok(env.api);
});

test('状态接口不返回明文敏感列以外的块内容', () => {
  const env = createApp({ dbFile: ':memory:', latencyChunkMs: 1 });
  const state = env.api.state('billing');
  const text = JSON.stringify(state);
  assert.ok(!text.includes('@example.test'));
  assert.ok(!text.includes('138-0000'));
  assert.ok(!text.includes('虚构健康标记'));
  assert.ok(state.authz.purposes.length === 3);
});
