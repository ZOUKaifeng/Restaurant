import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const contractUrl = new URL('../contracts/merchant-core.openapi.json', import.meta.url);
const api = JSON.parse(readFileSync(contractUrl, 'utf8'));
let checks = 0;

function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

function resolve(value) {
  if (!value?.$ref) return value;
  assert.ok(value.$ref.startsWith('#/'), `Only local refs supported: ${value.$ref}`);
  let node = api;
  for (const segment of value.$ref.slice(2).split('/')) {
    node = node?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  assert.ok(node !== undefined, `Missing ref: ${value.$ref}`);
  return resolve(node);
}

function validate(schema, value, path = '$') {
  schema = resolve(schema);
  if (schema.anyOf) {
    const valid = schema.anyOf.some((branch) => {
      try { validate(branch, value, path); return true; } catch { return false; }
    });
    assert.ok(valid, `${path}: no anyOf branch matches`);
    return;
  }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${path}: const`);
  if (schema.enum) assert.ok(schema.enum.some((x) => x === value), `${path}: enum`);
  switch (schema.type) {
    case 'null':
      assert.equal(value, null, `${path}: expected null`);
      return;
    case 'object': {
      assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: object`);
      for (const required of schema.required ?? []) {
        assert.ok(Object.hasOwn(value, required), `${path}.${required}: required`);
      }
      if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${path}: minProperties`);
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(schema.properties ?? {}, key)) validate(schema.properties[key], child, `${path}.${key}`);
        else assert.notEqual(schema.additionalProperties, false, `${path}.${key}: unexpected property`);
      }
      return;
    }
    case 'array':
      assert.ok(Array.isArray(value), `${path}: array`);
      if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path}: minItems`);
      if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path}: maxItems`);
      if (schema.uniqueItems) assert.equal(new Set(value.map((x) => JSON.stringify(x))).size, value.length, `${path}: uniqueItems`);
      value.forEach((x, i) => validate(schema.items, x, `${path}[${i}]`));
      return;
    case 'string': {
      assert.equal(typeof value, 'string', `${path}: string`);
      const length = Array.from(value).length;
      if (schema.minLength !== undefined) assert.ok(length >= schema.minLength, `${path}: minLength`);
      if (schema.maxLength !== undefined) assert.ok(length <= schema.maxLength, `${path}: maxLength`);
      if (schema.pattern) assert.ok(new RegExp(schema.pattern, 'u').test(value), `${path}: pattern`);
      if (schema.format === 'email') assert.ok(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), `${path}: email example format`);
      if (schema.format === 'date-time') {
        const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/u.exec(value);
        assert.ok(match, `${path}: date-time requires explicit timezone`);
        const [, ys, ms, ds, hs, mins, ss, zone, , ohs, oms] = match;
        const [year, month, day, hour, minute, second] = [ys, ms, ds, hs, mins, ss].map(Number);
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        assert.ok(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1], `${path}: actual calendar date`);
        assert.ok(hour <= 23 && minute <= 59 && second <= 59, `${path}: clock time; examples do not use leap seconds`);
        if (!/^[Zz]$/u.test(zone)) assert.ok(Number(ohs) <= 23 && Number(oms) <= 59, `${path}: timezone offset`);
        assert.ok(Number.isFinite(Date.parse(value)), `${path}: supported date-time example`);
      }
      if (schema.format === 'uri-reference') assert.ok(!/\s/u.test(value), `${path}: uri-reference example format`);
      return;
    }
    case 'integer':
      assert.ok(Number.isSafeInteger(value), `${path}: safe integer`);
      if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: minimum`);
      if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: maximum`);
      return;
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${path}: boolean`);
      return;
    default:
      throw new Error(`Unsupported schema type ${schema.type} at ${path}`);
  }
}

function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) { resolve(value); check(true, value.$ref); }
  Object.values(value).forEach(walk);
}

function expectValid(name, value) {
  validate(api.components.schemas[name], value);
  check(true, `${name}: positive example`);
}
function expectInvalid(name, value) {
  assert.throws(() => validate(api.components.schemas[name], value));
  check(true, `${name}: negative example`);
}

for (const invalidDate of ['2026-11-14T00:00:00', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-14T24:00:00Z']) {
  assert.throws(() => validate({ type: 'string', format: 'date-time' }, invalidDate));
  check(true, `Reject invalid date-time: ${invalidDate}`);
}
validate({ type: 'string', format: 'date-time' }, '2028-02-29T23:59:59+01:00');
check(true, 'Accept actual leap day with explicit timezone');

check(api.openapi === '3.1.0', 'OpenAPI 3.1');
check(api['x-implementation-status'] === 'local-tested-not-production', 'Local tests must not imply completed production deployment');
check(api.servers.every((x) => x.url === '/api/v1'), 'No fictional deployed API URL');
walk(api);

const operationIds = new Set();
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
let operationCount = 0;
let exampleCount = 0;
for (const [path, item] of Object.entries(api.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    operationCount += 1;
    check(!operationIds.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
    operationIds.add(operation.operationId);
    const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(resolve);
    for (const match of path.matchAll(/\{([^}]+)\}/gu)) {
      check(parameters.some((x) => x.in === 'path' && x.name === match[1] && x.required), `${method} ${path}: path parameter`);
    }
    const security = operation.security ?? api.security;
    check(Array.isArray(security), `${method} ${path}: security`);
    for (const group of security) {
      for (const scheme of Object.keys(group)) check(Object.hasOwn(api.components.securitySchemes, scheme), `Unknown security scheme ${scheme}`);
    }
    const request = operation.requestBody ? resolve(operation.requestBody) : null;
    for (const media of Object.values(request?.content ?? {})) {
      if (media.example !== undefined) { validate(media.schema, media.example); exampleCount += 1; check(true, `${method} ${path}: request example`); }
    }
    for (const [status, responseRef] of Object.entries(operation.responses)) {
      const response = resolve(responseRef);
      check(Boolean(response.description), `${method} ${path} ${status}: response description`);
      for (const media of Object.values(response.content ?? {})) {
        if (media.example !== undefined) { validate(media.schema, media.example); exampleCount += 1; check(true, `${method} ${path} ${status}: response example`); }
      }
      if (status === '204') check(!response.content, `${method} ${path}: 204 without body`);
    }
    if (path.startsWith('/restaurants') && method !== 'get') {
      check(security.some((x) => 'SessionCookie' in x && 'CsrfToken' in x), `${method} ${path}: protected write`);
    }
    if (method === 'patch' || (method === 'put' && path.endsWith('/opening-hours'))) {
      check(parameters.some((x) => x.name === 'If-Match' && x.required), `${method} ${path}: precondition`);
      check('412' in operation.responses && '428' in operation.responses, `${method} ${path}: concurrency errors`);
    }
  }
}
const pathCount = Object.keys(api.paths).length;
const schemaCount = Object.keys(api.components.schemas).length;
check(operationCount === 17, '17 scoped operations');
check(pathCount === 14, '14 scoped paths');
check(schemaCount === 22, '22个限定schema');

const verifyInput = api.components.schemas.VerifyEmailInput;
check(verifyInput.type === 'object' && verifyInput.additionalProperties === false, 'VerifyEmailInput仅接受精确对象');
check(JSON.stringify(Object.keys(verifyInput.properties).sort()) === JSON.stringify(['continue_session', 'token']), 'VerifyEmailInput仅包含token及continue_session');
check(JSON.stringify(verifyInput.required) === JSON.stringify(['token']), 'VerifyEmailInput仅token必填');
assert.deepEqual(verifyInput.properties.token, api.components.schemas.ActionTokenInput.properties.token);
check(true, 'VerifyEmailInput复用完全一致的动作令牌属性schema');
check(verifyInput.properties.continue_session.type === 'boolean' && verifyInput.properties.continue_session.default === false, 'continue_session是缺省false的可选布尔值');

const verifyOperation = api.paths['/auth/verify-email'].post;
const loginResponse = api.paths['/auth/login'].post.responses['200'];
check(verifyOperation.requestBody.required && verifyOperation.requestBody.content['application/json'].schema.$ref === '#/components/schemas/VerifyEmailInput', '邮箱验证请求使用必填VerifyEmailInput');
check(verifyOperation.security.length === 0, '旧token-only验证不增加无条件CSRF要求；true分支要求见操作描述');
check(verifyOperation.responses['200'].content['application/json'].schema.$ref === '#/components/schemas/LoginResponse', '继续会话成功返回200 LoginResponse');
assert.deepEqual(verifyOperation.responses['200'].headers, loginResponse.headers);
check(true, '邮箱验证200沿用登录200的Cookie及安全响应头模式');
assert.deepEqual(verifyOperation.responses['200'].content['application/json'].example, loginResponse.content['application/json'].example);
check(true, '邮箱验证200复用已有合成登录响应示例');
check(verifyOperation.responses['204'] !== undefined && !verifyOperation.responses['204'].content, '旧204兼容且无响应体');
check(!verifyOperation.responses['206'], '继续会话使用200而非206');
check(verifyOperation.responses['403'].$ref === '#/components/responses/Error403', '继续会话Origin或CSRF校验失败引用Error403');
check(verifyOperation.responses['410'].$ref === '#/components/responses/Error410', '令牌过期或撤销仍引用Error410');
for (const path of ['/auth/register', '/auth/verification-emails']) {
  check(api.paths[path].post.responses['202'].headers['Set-Cookie'].$ref === '#/components/headers/RegistrationCookie', `${path}的202声明注册证明Cookie元数据`);
}

const verify = { token: 'example_action_token_not_a_real_secret_123456' };
expectValid('VerifyEmailInput', verify);
expectValid('VerifyEmailInput', { ...verify, continue_session: true });
expectValid('VerifyEmailInput', { ...verify, continue_session: false });
expectInvalid('VerifyEmailInput', { ...verify, continue_session: 'false' });
expectInvalid('VerifyEmailInput', { ...verify, continue_session: null });
expectInvalid('VerifyEmailInput', { ...verify, continue_session: true, extra: true });
expectInvalid('VerifyEmailInput', { continue_session: true });
expectInvalid('VerifyEmailInput', { token: 'short' });

const register = { email: 'owner@restaurant.example', password: 'Example-only-password-for-contract-tests', locale: 'en', terms_version: 'terms-v1', accepted_terms: true };
expectValid('RegisterInput', register);
expectInvalid('RegisterInput', { ...register, platform_role: 'admin' });
expectInvalid('RegisterInput', { ...register, role: 'owner' });
expectInvalid('RegisterInput', { ...register, accepted_terms: false });
expectInvalid('RegisterInput', { ...register, password: 'short' });
expectInvalid('RegisterInput', { ...register, email: 'not-an-email' });
expectInvalid('RegisterInput', { ...register, password: 'a'.repeat(129) });
expectValid('RestaurantCreateInput', { name: 'Example Restaurant', primary_locale: 'en' });
expectInvalid('RestaurantCreateInput', { name: 'Example Restaurant' });
expectInvalid('RestaurantCreateInput', { name: 'Example Restaurant', primary_locale: 'en', owner_id: 'usr_another_user_001' });
expectInvalid('RestaurantPatchInput', {});
expectInvalid('RestaurantPatchInput', { name: null });
expectInvalid('RestaurantPatchInput', { status: 'active' });
expectInvalid('RestaurantPatchInput', { reservation_enabled: true });
expectInvalid('RestaurantPatchInput', { revision: 999 });
expectInvalid('RestaurantPatchInput', { name: 'a'.repeat(151) });
expectInvalid('RestaurantPatchInput', { country_code: 'GBR' });
expectInvalid('RestaurantPatchInput', { phone: '1234' });
expectValid('RestaurantPatchInput', { description: null, timezone: 'Europe/London' });
expectValid('OpeningHoursInput', { intervals: [] });
const interval = { weekday: 5, opens_at_local: '18:00', closes_at_local: '02:00', closes_day_offset: 1, accepts_requests: false, sort_order: 0 };
expectValid('OpeningHoursInput', { intervals: [interval] });
expectInvalid('OpeningHoursInput', { intervals: [{ ...interval, weekday: 0 }] });
expectInvalid('OpeningHoursInput', { intervals: [{ ...interval, opens_at_local: '25:00' }] });
expectInvalid('OpeningHoursInput', { intervals: [{ ...interval, closes_day_offset: 2 }] });
expectInvalid('OpeningHoursInput', { intervals: Array(22).fill(interval) });
expectInvalid('OpeningHoursInput', { intervals: [{ ...interval, capacity: 30 }] });
expectInvalid('ResetPasswordInput', { token: 'short', new_password: register.password });
expectValid('ResetPasswordInput', { token: 'example_reset_token_for_contract_test_123456', new_password: register.password });

for (const name of ['CurrentUser', 'Restaurant', 'RestaurantList']) {
  const names = Object.keys(api.components.schemas[name].properties);
  check(!names.some((x) => ['password', 'password_hash', 'session_secret_hash', 'platform_role', 'create_request_fingerprint'].includes(x)), `${name}: no raw persistence serialization`);
}
check(api.paths['/auth/register'].post.responses['202'] !== undefined, 'Registration neutral accepted response');
check(api.paths['/auth/password-reset-requests'].post.responses['202'] !== undefined, 'Password reset neutral response');
check(!api.paths['/auth/verify-email'].get && !api.paths['/auth/password-reset'].get, 'GET must not consume action tokens');
check(!Object.values(api.paths).some((x) => x.delete), 'No arbitrary physical deletion endpoints');
check(!Object.keys(api.paths).some((x) => /reservations|menus|publish|campaigns/u.test(x)), 'First slice does not silently implement later scopes');

for (const document of ['../../README.md', '../../TODO.md', '../../outputs/商家账户与餐厅接口契约-v0.1.md']) {
  const location = new URL(document, import.meta.url);
  const text = readFileSync(location, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
    const link = match[1];
    if (/^(https?:|#)/u.test(link)) continue;
    const target = new URL(link, location);
    check(existsSync(fileURLToPath(target)), `${document}: link ${link}`);
  }
}

console.log(`通过：${operationCount}个操作、${pathCount}条路径、${schemaCount}个schema，${exampleCount}个请求/响应示例，${checks}条静态契约检查。`);
console.log('范围：仅引用、声明、schema子集和示例验证；未验证真实服务器、数据库事务、认证、邮件或部署。');
