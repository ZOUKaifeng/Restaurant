import { createHmac, randomBytes, timingSafeEqual, createCipheriv } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { ApiError, invalid } from './errors.js';

export const SESSION_COOKIE = '__Host-restaurant_session';
export const FLOW_COOKIE = '__Host-restaurant_authflow';
export const REGISTRATION_COOKIE = '__Host-restaurant_registration';
export const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };
export const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 };
// 固定的有效 Argon2id 编码用于不存在的账号，照常执行完整验证。
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
export function secret(): string { return randomBytes(32).toString('base64url'); }
export function digest(config: Config, value: string, purpose: string): string { return createHmac('sha256', config.tokenPepper).update(`${purpose}\0${value}`).digest('hex'); }
export function equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function csrf(config: Config, context: string, expires: Date): string {
  const time = Math.floor(expires.getTime() / 1000).toString();
  return `${time}.${createHmac('sha256', config.tokenPepper).update(`csrf\0${context}\0${time}`).digest('base64url')}`;
}
export function validCsrf(config: Config, context: string, token: unknown): boolean {
  if (typeof token !== 'string' || !/^\d{10}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const expiry = Number(token.split('.')[0]);
  return expiry > Date.now() / 1000 && equal(csrf(config, context, new Date(expiry * 1000)), token);
}
function flow(config: Config, value: unknown): { context: string; expires: Date } | null {
  if (typeof value !== 'string' || value.length > 180) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(parts[0]!) || !/^\d{10}$/.test(parts[1]!)) return null;
  const [nonce, time, signature] = parts as [string, string, string];
  const expected = digest(config, `${nonce}.${time}`, 'authflow');
  if (!equal(expected, signature) || Number(time) <= Date.now() / 1000) return null;
  return { context: `flow:${nonce}.${time}`, expires: new Date(Number(time) * 1000) };
}
export interface RegistrationProof { userId: string; tokenId: string; credential: string; expires: Date }
// This proof is issued only after creating a password identity, never from an anonymous
// resend alone. It is separate from the email token and from generic CSRF cookies.
export function registrationProofCookie(config: Config, proof: RegistrationProof): string {
  const base = `${proof.userId}.${proof.tokenId}.${proof.credential}.${Math.floor(proof.expires.getTime() / 1000)}.${secret()}`;
  return `${base}.${digest(config, base, 'registration-proof')}`;
}
export function readRegistrationProof(config: Config, raw: unknown): RegistrationProof | null {
  if (typeof raw !== 'string' || raw.length > 320) return null;
  const match = /^(usr_[A-Za-z0-9_-]{24})\.(tok_[A-Za-z0-9_-]{24})\.([a-f0-9]{64})\.(\d{10})\.([A-Za-z0-9_-]{43})\.([a-f0-9]{64})$/.exec(raw);
  if (!match) return null;
  const [, userId, tokenId, credential, time] = match;
  const base = raw.slice(0, raw.lastIndexOf('.'));
  if (!equal(digest(config, base, 'registration-proof'), match[6]!) || Number(time) <= Date.now() / 1000) return null;
  return { userId: userId!, tokenId: tokenId!, credential: credential!, expires: new Date(Number(time) * 1000) };
}

export function requireOrigin(request: FastifyRequest, config: Config, allowReferer = false): void {
  if (request.headers.origin !== undefined) {
    if (request.headers.origin === config.appOrigin) return;
    throw new ApiError(403);
  }
  if (allowReferer && request.headers['sec-fetch-site'] === 'same-origin' && typeof request.headers.referer === 'string') {
    try {
      const url = new URL(request.headers.referer);
      if (url.origin === config.appOrigin && !url.username && !url.password) return;
    } catch { /* 不接受无法解析的同源证据。 */ }
  }
  throw new ApiError(403);
}
export interface Session {
  sessionId: string; sessionHash: string; expires: Date;
  user: { id: string; email: string; display_name: string | null; locale: string; status: 'active'; email_verified_at: Date; created_at: Date };
}
export async function findSession(pool: Pool, config: Config, request: FastifyRequest): Promise<Session | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const sessionHash = digest(config, raw, 'session');
  const result = await pool.query(`SELECT s.id AS session_id,s.expires_at,u.id,u.email,u.display_name,u.locale,u.status,u.email_verified_at,u.created_at
    FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.session_secret_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    AND u.status='active' AND u.email_verified_at IS NOT NULL`, [sessionHash]);
  const row = result.rows[0];
  if (!row) return null;
  return { sessionId: row.session_id, sessionHash, expires: row.expires_at, user: { id: row.id, email: row.email, display_name: row.display_name, locale: row.locale, status: row.status, email_verified_at: row.email_verified_at, created_at: row.created_at } };
}
export async function requireSession(pool: Pool, config: Config, request: FastifyRequest): Promise<Session> {
  const session = await findSession(pool, config, request);
  if (!session) throw new ApiError(401);
  return session;
}
export async function lockAuthenticated(client: PoolClient, _config: Config, session: Session): Promise<Session> {
  // Serialize account mutations without blocking KEY SHARE checks from the
  // already-started calls' ledger foreign keys. User IDs are never changed here.
  const users = await client.query(`SELECT id,email,display_name,locale,status,email_verified_at,created_at
    FROM users WHERE id=$1 FOR NO KEY UPDATE`, [session.user.id]);
  const user = users.rows[0];
  if (!user || user.status !== 'active' || !user.email_verified_at) throw new ApiError(401);
  const sessions = await client.query(`SELECT id,user_id,session_secret_hash,revoked_at,expires_at
    FROM auth_sessions WHERE id=$1 FOR UPDATE`, [session.sessionId]);
  const current = sessions.rows[0];
  if (!current || current.user_id !== user.id || current.revoked_at ||
      typeof current.session_secret_hash !== 'string' || !equal(current.session_secret_hash, session.sessionHash)) throw new ApiError(401);
  // 在锁等待结束后读取数据库时钟，不使用事务开始时间或锁前求值的快照。
  const clock = await client.query('SELECT $1::timestamptz > clock_timestamp() AS valid', [current.expires_at]);
  if (!clock.rows[0].valid) throw new ApiError(401);
  return { sessionId: current.id, sessionHash: current.session_secret_hash, expires: current.expires_at, user };
}
export async function requireWrite(pool: Pool, config: Config, request: FastifyRequest, sessionRequired = true): Promise<Session | null> {
  const session = sessionRequired ? await requireSession(pool, config, request) : await findSession(pool, config, request);
  requireOrigin(request, config);
  const context = session ? `session:${session.sessionHash}` : flow(config, request.cookies[FLOW_COOKIE])?.context;
  if (!context || !validCsrf(config, context, request.headers['x-csrf-token'])) throw new ApiError(403);
  return session;
}
export async function issueCsrf(pool: Pool, config: Config, request: FastifyRequest, reply: FastifyReply) {
  requireOrigin(request, config, true);
  const session = await findSession(pool, config, request);
  if (session) return { csrf_token: csrf(config, `session:${session.sessionHash}`, session.expires), expires_at: session.expires.toISOString() };
  let current = flow(config, request.cookies[FLOW_COOKIE]);
  if (!current) {
    const nonce = secret(), expires = new Date(Date.now() + 30 * 60 * 1000);
    const base = `${nonce}.${Math.floor(expires.getTime() / 1000)}`;
    reply.setCookie(FLOW_COOKIE, `${base}.${digest(config, base, 'authflow')}`, { ...cookieOptions, maxAge: 1800 });
    current = { context: `flow:${base}`, expires };
  }
  return { csrf_token: csrf(config, current.context, current.expires), expires_at: current.expires.toISOString() };
}
export function hashPassword(password: string): Promise<string> { return argon2.hash(password, passwordOptions); }
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> { const valid = await argon2.verify(hash ?? DUMMY_HASH, password); return Boolean(hash) && valid; }
export function checkPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) invalid('password', 'LENGTH');
  const folded = password.toLowerCase();
  if (/^(.)\1+$/u.test(password) || ['passwordpassword', '123456789012345', '1234567890123456', 'qwertyuiopasdfgh', 'correcthorsebatterystaple'].includes(folded)) invalid('password', 'WEAK_PASSWORD');
}
export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
export function encryptAction(config: Config, outboxId: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(outboxId));
  const data = Buffer.concat([cipher.update(JSON.stringify({ token }), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
