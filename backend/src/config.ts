import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  migrationDatabaseUrl?: string;
  appOrigin: string;
  host: string;
  port: number;
  tokenPepper: string;
  cursorSecret: string;
  outboxEncryptionKey: string;
  storageMode: 'local' | 's3';
  storageLocalRoot: string;
  s3?: { region: string; bucket: string; endpoint?: string; forcePathStyle: boolean };
  website?: { apiKey?: string; baseUrl: string; model: string; publicOrigin: string; port: number; host: string; baseDomain?: string };
  emailMode: 'disabled' | 'smtp' | 'postmark';
  smtp?: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  postmark?: { serverToken: string; from: string };
}

function parseConfigUrl(value: string, key: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL' | 'APP_ORIGIN' | 'S3_ENDPOINT' | 'SITE_PUBLIC_ORIGIN'): URL {
  try { return new URL(value); }
  catch { throw new Error(`无效配置 ${key}`); }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`缺少配置 ${key}`);
    return value;
  };
  const number = (key: string, fallback: number): number => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error(`无效配置 ${key}`);
    return Number(raw);
  };
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('无效配置 NODE_ENV');
  const databaseUrl = required('DATABASE_URL');
  validateDatabaseUrl(databaseUrl);
  if (env.MIGRATION_DATABASE_URL) validateDatabaseUrl(env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  const origin = required('APP_ORIGIN');
  const parsed = parseConfigUrl(origin, 'APP_ORIGIN');
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('APP_ORIGIN 必须为精确 origin');
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') throw new Error('生产 APP_ORIGIN 必须 HTTPS');
  const tokenPepper = required('TOKEN_PEPPER');
  const cursorSecret = required('CURSOR_SECRET');
  const outboxEncryptionKey = required('OUTBOX_ENCRYPTION_KEY');
  if (Buffer.byteLength(tokenPepper) < 32 || Buffer.byteLength(cursorSecret) < 32) throw new Error('TOKEN_PEPPER/CURSOR_SECRET 至少32字节');
  if (!/^[a-fA-F0-9]{64}$/.test(outboxEncryptionKey)) throw new Error('OUTBOX_ENCRYPTION_KEY 必须64位hex');
  const emailMode = env.EMAIL_MODE ?? (nodeEnv === 'production' ? 'smtp' : 'disabled');
  if (!['disabled', 'smtp', 'postmark'].includes(emailMode) || (nodeEnv === 'production' && emailMode === 'disabled')) throw new Error('无效配置 EMAIL_MODE');
  let smtp: Config['smtp'], postmark: Config['postmark'];
  if (emailMode === 'smtp') {
    const secure = env.SMTP_SECURE ?? 'true';
    if (!['true', 'false'].includes(secure)) throw new Error('无效配置 SMTP_SECURE');
    smtp = { host: required('SMTP_HOST'), port: number('SMTP_PORT', 465), secure: secure === 'true', user: required('SMTP_USER'), pass: required('SMTP_PASS'), from: required('SMTP_FROM') };
    if (/[\r\n]/.test(smtp.from) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtp.from)) throw new Error('无效配置 SMTP_FROM');
  } else if (emailMode === 'postmark') {
    const serverToken = required('POSTMARK_SERVER_TOKEN'), from = required('SMTP_FROM');
    if (!/^[\x21-\x7e]{1,512}$/.test(serverToken) || /^(POSTMARK_API_TEST|CHANGE_ME)$/i.test(serverToken)) throw new Error('无效配置 POSTMARK_SERVER_TOKEN');
    if (from.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(from)) throw new Error('无效配置 SMTP_FROM');
    postmark = { serverToken, from };
  }
  const storageMode = env.STORAGE_MODE ?? (nodeEnv === 'production' ? 's3' : 'local');
  if (!['local', 's3'].includes(storageMode) || (nodeEnv === 'production' && storageMode !== 's3')) throw new Error('生产素材必须配置 S3，不能回退本地存储');
  const backendRoot = fileURLToPath(new URL(existsSync(new URL('../contracts', import.meta.url)) ? '../' : '../../', import.meta.url));
  const storageLocalRoot = resolve(backendRoot, env.STORAGE_LOCAL_ROOT ?? '../.workbuddy/runtime/assets');
  let s3: Config['s3'];
  if (storageMode === 's3' || env.S3_BUCKET) {
    const region = required('S3_REGION'), bucket = required('S3_BUCKET');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]{3,64}$/.test(region)) throw new Error('无效 S3 配置');
    const endpoint = env.S3_ENDPOINT;
    if (endpoint) {
      const address = parseConfigUrl(endpoint, 'S3_ENDPOINT');
      const localDevelopment = nodeEnv !== 'production' && address.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(address.hostname);
      if ((address.protocol !== 'https:' && !localDevelopment) || address.username || address.password || address.search || address.hash) throw new Error('无效 S3 endpoint');
    }
    const pathStyle = env.S3_FORCE_PATH_STYLE ?? 'false';
    if (!['true', 'false'].includes(pathStyle)) throw new Error('无效 S3_FORCE_PATH_STYLE');
    s3 = { region, bucket, endpoint, forcePathStyle: pathStyle === 'true' };
  }
  const baseUrl = env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  if (baseUrl !== 'https://api.deepseek.com') throw new Error('本轮仅允许已核验的 DeepSeek 官方接口，禁止向未知主机发送密钥');
  const model = env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  if (model !== 'deepseek-flash') throw new Error('本轮指定 DeepSeek V4.1 Flash，model 必须 deepseek-flash');
  const sitePort = number('SITE_PORT', 4174);
  const publicOrigin = env.SITE_PUBLIC_ORIGIN ?? `http://localhost:${sitePort}`;
  const publicAddress = parseConfigUrl(publicOrigin, 'SITE_PUBLIC_ORIGIN');
  if (publicAddress.origin !== publicOrigin || publicAddress.username || publicAddress.password || publicOrigin === origin ||
      !['http:', 'https:'].includes(publicAddress.protocol)) throw new Error('SITE_PUBLIC_ORIGIN 必须为独立站点 origin');
  if (nodeEnv !== 'production' && (!['localhost', '127.0.0.1'].includes(publicAddress.hostname) || publicAddress.protocol !== 'http:' || Number(publicAddress.port) !== sitePort)) throw new Error('本轮本地站点只允许独立端口的回环 HTTP 地址');
  if (nodeEnv === 'production' && publicAddress.protocol !== 'https:') throw new Error('正式站点必须配置 HTTPS origin，公网发布尚未验收');
  const website = { apiKey: env.DEEPSEEK_API_KEY, baseUrl, model, publicOrigin, port: sitePort, host: '127.0.0.1', baseDomain: env.SITE_BASE_DOMAIN };
  return { nodeEnv: nodeEnv as Config['nodeEnv'], databaseUrl, migrationDatabaseUrl: env.MIGRATION_DATABASE_URL, appOrigin: origin, host: env.HOST ?? '127.0.0.1', port: number('PORT', 4000), tokenPepper, cursorSecret, outboxEncryptionKey, storageMode: storageMode as Config['storageMode'], storageLocalRoot, s3, website, emailMode: emailMode as Config['emailMode'], smtp, postmark };
}

export function validateDatabaseUrl(value: string, key: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL' = 'DATABASE_URL'): void {
  const url = parseConfigUrl(value, key);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2) throw new Error('无效 PostgreSQL URL');
}
