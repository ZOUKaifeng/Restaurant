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
  emailMode: 'disabled' | 'smtp';
  smtp?: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
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
  if (env.MIGRATION_DATABASE_URL) validateDatabaseUrl(env.MIGRATION_DATABASE_URL);
  const origin = required('APP_ORIGIN');
  const parsed = new URL(origin);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('APP_ORIGIN 必须为精确 origin');
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') throw new Error('生产 APP_ORIGIN 必须 HTTPS');
  const tokenPepper = required('TOKEN_PEPPER');
  const cursorSecret = required('CURSOR_SECRET');
  const outboxEncryptionKey = required('OUTBOX_ENCRYPTION_KEY');
  if (Buffer.byteLength(tokenPepper) < 32 || Buffer.byteLength(cursorSecret) < 32) throw new Error('TOKEN_PEPPER/CURSOR_SECRET 至少32字节');
  if (!/^[a-fA-F0-9]{64}$/.test(outboxEncryptionKey)) throw new Error('OUTBOX_ENCRYPTION_KEY 必须64位hex');
  const emailMode = env.EMAIL_MODE ?? (nodeEnv === 'production' ? 'smtp' : 'disabled');
  if (!['disabled', 'smtp'].includes(emailMode) || (nodeEnv === 'production' && emailMode !== 'smtp')) throw new Error('无效配置 EMAIL_MODE');
  let smtp: Config['smtp'];
  if (emailMode === 'smtp') {
    const secure = env.SMTP_SECURE ?? 'true';
    if (!['true', 'false'].includes(secure)) throw new Error('无效配置 SMTP_SECURE');
    smtp = { host: required('SMTP_HOST'), port: number('SMTP_PORT', 465), secure: secure === 'true', user: required('SMTP_USER'), pass: required('SMTP_PASS'), from: required('SMTP_FROM') };
    if (/[\r\n]/.test(smtp.from) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtp.from)) throw new Error('无效配置 SMTP_FROM');
  }
  return { nodeEnv: nodeEnv as Config['nodeEnv'], databaseUrl, migrationDatabaseUrl: env.MIGRATION_DATABASE_URL, appOrigin: origin, host: env.HOST ?? '127.0.0.1', port: number('PORT', 4000), tokenPepper, cursorSecret, outboxEncryptionKey, emailMode: emailMode as Config['emailMode'], smtp };
}

export function validateDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2) throw new Error('无效 PostgreSQL URL');
}
