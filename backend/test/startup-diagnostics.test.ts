import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { startupFailureLine, type StartupStage } from '../src/startup-diagnostics.js';

const syntheticSecret = 'synthetic-private-value-never-output-2026';
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', HOST: '::', PORT: '4000',
  DATABASE_URL: `postgresql://restaurant_app:${syntheticSecret}@database.example.test:5432/postgres?sslmode=verify-full`,
  APP_ORIGIN: 'https://app.example.test', SITE_PUBLIC_ORIGIN: 'https://sites.example.test',
  TOKEN_PEPPER: syntheticSecret, CURSOR_SECRET: `${syntheticSecret}-cursor`, OUTBOX_ENCRYPTION_KEY: '0'.repeat(64),
  EMAIL_MODE: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USER: syntheticSecret, SMTP_PASS: syntheticSecret, SMTP_FROM: 'noreply@example.test',
  STORAGE_MODE: 's3', S3_REGION: 'auto', S3_BUCKET: 'synthetic-assets', S3_ENDPOINT: 'https://objects.example.test',
};
function assertPrivate(line: string): void {
  for (const forbidden of [syntheticSecret, 'postgresql://', '-----BEGIN', 'private-sql-detail', 'PRIVATE_STACK', '/private/certificate.pem']) {
    assert.equal(line.includes(forbidden), false, forbidden);
  }
  assert.equal(line.split('\n').length, 2);
}
function configError(values: NodeJS.ProcessEnv): unknown {
  try { loadConfig(values); }
  catch (error) { return error; }
  assert.fail('Expected a real configuration rejection');
}

test('缺失变量只显示固定字段名，不记录配置值', () => {
  const line = startupFailureLine('CONFIG', configError({ ...env, SMTP_PASS: undefined }));
  assert.match(line, /\[CONFIG\].*缺少配置 SMTP_PASS/);
  assertPrivate(line);
});

test('真实URL解析失败独立指出字段，原始非法URL及密码不出日志', () => {
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'APP_ORIGIN', 'S3_ENDPOINT', 'SITE_PUBLIC_ORIGIN'] as const) {
    const error = configError({ ...env, [key]: `not-a-url-${syntheticSecret}` });
    const line = startupFailureLine('CONFIG', error);
    assert.match(line, new RegExp(`无效配置 ${key}`));
    assertPrivate(line);
  }
});

test('生产必填站点HTTPS、SMTP、S3、密钥保护保持不变', () => {
  for (const change of [{ SITE_PUBLIC_ORIGIN: undefined }, { EMAIL_MODE: 'disabled' },
    { STORAGE_MODE: 'local' }, { OUTBOX_ENCRYPTION_KEY: syntheticSecret }, { PORT: '0' }]) {
    const line = startupFailureLine('CONFIG', configError({ ...env, ...change }));
    assert.match(line, /拒绝启动/);
    assert.doesNotMatch(line, /详细异常已隐藏/);
    assertPrivate(line);
  }
  assert.equal(loadConfig(env).smtp?.secure, false);
});

test('只允许精确的本机错误消息，不能把任意前缀和原始堆栈写入日志', () => {
  for (const error of [new Error(`缺少配置 SMTP_PASS\n${syntheticSecret}`),
    new Error(`无效配置 DATABASE_URL: ${syntheticSecret}`),
    { message: 'Unexpected error', stack: 'PRIVATE_STACK', detail: 'private-sql-detail', input: env.DATABASE_URL },
    syntheticSecret, null, undefined]) {
    const line = startupFailureLine('CONFIG', error);
    assert.match(line, /详细异常已隐藏/);
    assertPrivate(line);
  }
});

test('数据库错误仅映射固定分类，不打印SQL详情、主机或密码', () => {
  for (const [code, expected] of [['28P01', '数据库身份验证失败'], ['42501', '缺少必要权限'],
    ['42P01', '缺少必要数据库表'], ['ENOTFOUND', '无法解析数据库主机'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', '数据库证书与主机不匹配']]) {
    const line = startupFailureLine('DATABASE_READY', { code, message: syntheticSecret,
      detail: 'private-sql-detail', stack: 'PRIVATE_STACK' });
    assert.ok(line.includes(expected));
    assertPrivate(line);
  }
});

test('证书文件不可读提示变量名，不显示文件路径；网络代码限制对应阶段', () => {
  assert.match(startupFailureLine('DATABASE_CONFIG', { code: 'ENOENT', path: '/private/certificate.pem' }), /DATABASE_SSL_CA_FILE 文件不存在/);
  assertPrivate(startupFailureLine('DATABASE_CONFIG', { code: 'ENOENT', path: '/private/certificate.pem' }));
  assert.match(startupFailureLine('APP_SETUP', { code: 'ENOENT' }), /详细异常已隐藏/);
  assert.match(startupFailureLine('LISTEN', { code: 'EADDRINUSE' }), /监听端口已被占用/);
  assert.match(startupFailureLine('CONFIG', { code: '__proto__' }), /详细异常已隐藏/);
});

test('未知异常和异常属性getter也不泄露或使诊断失败', () => {
  const error = { get message(): string { throw new Error(syntheticSecret); } };
  for (const stage of ['CONFIG', 'DATABASE_CONFIG', 'APP_SETUP', 'DATABASE_READY', 'LISTEN'] as StartupStage[]) {
    const line = startupFailureLine(stage, error);
    assert.ok(line.includes(`[${stage}]`));
    assertPrivate(line);
  }
});

test('错误属性只读取一次，变值getter及原型属性不能绕过代码白名单', () => {
  let reads = 0;
  const line = startupFailureLine('DATABASE_READY', {
    get code(): string { reads += 1; return reads === 1 ? '28P01' : 'constructor'; },
  });
  assert.equal(reads, 1);
  assert.match(line, /数据库身份验证失败/);
  for (const code of ['constructor', '__proto__', 'toString', `28P01\n${syntheticSecret}`]) {
    for (const stage of ['DATABASE_CONFIG', 'DATABASE_READY'] as const) {
      const hidden = startupFailureLine(stage, { code });
      assert.match(hidden, /详细异常已隐藏/);
      assertPrivate(hidden);
    }
  }
});

test('Postmark配置仅需Server token和发信地址，不要求SMTP凭据且缺失错误脱敏', () => {
  const httpsEnv = { ...env, EMAIL_MODE: 'postmark', POSTMARK_SERVER_TOKEN: syntheticSecret,
    SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_PORT: undefined };
  const config = loadConfig(httpsEnv);
  assert.equal(config.emailMode, 'postmark');
  assert.equal(config.smtp, undefined);
  assert.deepEqual(config.postmark, { serverToken: syntheticSecret, from: 'noreply@example.test' });
  for (const token of [undefined, '', 'POSTMARK_API_TEST', 'CHANGE_ME', 'postmark_api_test', 'cHaNgE_Me', `${syntheticSecret}\n`, 'x'.repeat(513)]) {
    const line = startupFailureLine('CONFIG', configError({ ...httpsEnv, POSTMARK_SERVER_TOKEN: token }));
    assert.match(line, /POSTMARK_SERVER_TOKEN/);
    assertPrivate(line);
  }
  assertPrivate(startupFailureLine('CONFIG', configError({ ...httpsEnv, SMTP_FROM: 'name <a@example.test>' })));
});

function failingStartup(changes: NodeJS.ProcessEnv): string {
  const source = 'import pg from "pg"; pg.Client.prototype.connect = function () { process.stderr.write("UNEXPECTED_DB_CONNECTION\\n"); process.exit(73); }; await import("./src/index.ts");';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, ...env, ...changes }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1, result.error?.name);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('UNEXPECTED_DB_CONNECTION'), false);
  assertPrivate(result.stderr);
  return result.stderr;
}

test('真实启动入口在缺SMTP配置时输出安全字段后退出，不触发数据库连接', () => {
  const line = failingStartup({ SMTP_PASS: undefined });
  assert.match(line, /\[CONFIG\].*缺少配置 SMTP_PASS/);
});

test('真实启动入口在缺远程CA时准确标注数据库配置阶段，保留TLS门禁', () => {
  const line = failingStartup({ DATABASE_SSL_CA: undefined, DATABASE_SSL_CA_FILE: undefined });
  assert.match(line, /\[DATABASE_CONFIG\].*sslmode=verify-full.*DATABASE_SSL_CA/);
});

test('真实启动入口拒绝把私钥当CA且只输出安全原因，不连接数据库', () => {
  const line = failingStartup({ DATABASE_SSL_CA: `-----BEGIN PRIVATE KEY-----\n${syntheticSecret}\n-----END PRIVATE KEY-----` });
  assert.match(line, /\[DATABASE_CONFIG\].*数据库 CA 文件无效/);
});
