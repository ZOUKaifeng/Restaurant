import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { audit, id, transaction } from './db.js';
import { ApiError, invalid } from './errors.js';
import { input, locales } from './validation.js';
import { checkPassword, cookieOptions, csrf, digest, encryptAction, FLOW_COOKIE, hashPassword, issueCsrf, lockAuthenticated, normalizeEmail, requireSession, requireWrite, secret, SESSION_COOKIE, verifyPassword } from './security.js';

const accepted = { message: '如该请求符合条件，我们将向对应邮箱发送说明。' };
async function queueAction(db: PoolClient, config: Config, user: { id: string; email: string; email_normalized: string }, purpose: 'verify_email' | 'reset_password'): Promise<boolean> {
  const recent = await db.query(`SELECT id FROM auth_tokens WHERE user_id=$1 AND purpose=$2 AND created_at>now()-interval '60 seconds' LIMIT 1`, [user.id, purpose]);
  if (recent.rowCount) return false;
  await db.query(`UPDATE auth_tokens SET revoked_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND revoked_at IS NULL`, [user.id, purpose]);
  await db.query(`UPDATE email_outbox SET status='cancelled',sensitive_payload_ciphertext=NULL,updated_at=now()
    WHERE user_id=$1 AND template_key=$2 AND status='queued'`, [user.id, purpose]);
  const token = secret(), tokenId = id('tok'), outboxId = id('mail');
  const expires = new Date(Date.now() + (purpose === 'verify_email' ? 24 * 3600 : 30 * 60) * 1000);
  await db.query(`INSERT INTO auth_tokens(id,token_hash,purpose,user_id,target_email_normalized,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, [tokenId, digest(config, token, purpose), purpose, user.id, user.email_normalized, expires]);
  await db.query(`INSERT INTO email_outbox(id,category,template_key,template_version,recipient_email,recipient_email_normalized,recipient_email_key,user_id,auth_token_id,sensitive_payload_ciphertext,sensitive_payload_expires_at,dedupe_key)
    VALUES($1,'transactional',$2,'v1',$3,$4,$5,$6,$7,$8,$9,$10)`, [outboxId, purpose, user.email, user.email_normalized, digest(config, user.email_normalized, 'email'), user.id, tokenId, encryptAction(config, outboxId, token), expires, `${purpose}:${tokenId}:v1`]);
  return true;
}
async function actionTarget(db: PoolClient, config: Config, token: string, purpose: string) {
  const hash = digest(config, token, purpose);
  const initial = await db.query('SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose=$2', [hash, purpose]);
  if (!initial.rows[0]) throw new ApiError(410);
  // 所有凭据/令牌操作先锁用户再锁令牌，避免登录与改密交错及死锁。
  const userResult = await db.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [initial.rows[0].user_id]);
  const tokenResult = await db.query(`SELECT *,expires_at>clock_timestamp() AS valid FROM auth_tokens WHERE token_hash=$1 AND purpose=$2 FOR UPDATE`, [hash, purpose]);
  const user = userResult.rows[0], action = tokenResult.rows[0];
  if (!user || !action || !action.valid || action.revoked_at || action.target_email_normalized !== user.email_normalized || ['suspended', 'deleted'].includes(user.status)) throw new ApiError(410);
  return { user, action };
}
async function cleanupAction(db: PoolClient, tokenId: string): Promise<void> {
  await db.query(`UPDATE email_outbox SET sensitive_payload_ciphertext=NULL,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE auth_token_id=$1`, [tokenId]);
}
export function registerAuth(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/api/v1/auth/registration-policy', async () => ({ terms_version: 'terms-v1', terms_url: '/legal/terms-v1', privacy_notice_version: 'privacy-v1', privacy_url: '/legal/privacy-v1', supported_locales: locales, password_min_length: 15, password_max_length: 128 }));
  app.get('/api/v1/auth/csrf', async (request, reply) => issueCsrf(pool, config, request, reply));
  app.post('/api/v1/auth/register', async (request, reply) => {
    await requireWrite(pool, config, request, false);
    const body = input('RegisterInput', request.body);
    if (body.terms_version !== 'terms-v1') invalid('terms_version', 'TERMS_VERSION_CHANGED');
    checkPassword(body.password as string);
    const hash = await hashPassword(body.password as string);
    await transaction(pool, async db => {
      const userId = id('usr');
      const result = await db.query(`INSERT INTO users(id,email,email_normalized,display_name,locale,terms_version,terms_accepted_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(email_normalized) DO NOTHING RETURNING id,email,email_normalized`, [userId, body.email, normalizeEmail(body.email as string), body.display_name ?? null, body.locale, body.terms_version]);
      if (!result.rows[0]) return;
      await db.query(`INSERT INTO auth_identities(id,user_id,provider,password_hash) VALUES($1,$2,'password',$3)`, [id('ident'), userId, hash]);
      await queueAction(db, config, result.rows[0], 'verify_email');
      await audit(db, userId, 'register', userId, request.id);
    });
    return reply.code(202).send(accepted);
  });
  const requestMail = (purpose: 'verify_email' | 'reset_password') => async (request: FastifyRequest) => {
    await requireWrite(pool, config, request, false);
    const body = input('EmailInput', request.body);
    await verifyPassword(null, 'neutral-mail-request');
    await transaction(pool, async db => {
      const result = await db.query('SELECT * FROM users WHERE email_normalized=$1 FOR NO KEY UPDATE', [body.email]);
      const user = result.rows[0];
      if (!user || !['active', 'pending_verification'].includes(user.status) || (purpose === 'verify_email' && user.email_verified_at)) return;
      if (await queueAction(db, config, user, purpose)) await audit(db, user.id, purpose === 'verify_email' ? 'request_verification' : 'request_reset', user.id, request.id);
    });
    return accepted;
  };
  app.post('/api/v1/auth/verification-emails', async (request, reply) => reply.code(202).send(await requestMail('verify_email')(request)));
  app.post('/api/v1/auth/password-reset-requests', async (request, reply) => reply.code(202).send(await requestMail('reset_password')(request)));
  app.post('/api/v1/auth/verify-email', async (request, reply) => {
    const body = input('ActionTokenInput', request.body);
    await transaction(pool, async db => {
      const { user, action } = await actionTarget(db, config, body.token as string, 'verify_email');
      if (action.used_at) return;
      await db.query(`UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),status='active',updated_at=now() WHERE id=$1`, [user.id]);
      await db.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [action.id]);
      await cleanupAction(db, action.id);
      await audit(db, user.id, 'verify_email', user.id, request.id);
    });
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const previous = await requireWrite(pool, config, request, false);
    const body = input('LoginInput', request.body);
    const initial = await pool.query(`SELECT u.id,i.password_hash FROM users u JOIN auth_identities i ON i.user_id=u.id AND i.provider='password' WHERE u.email_normalized=$1`, [body.email]);
    const credentials = initial.rows[0];
    if (!await verifyPassword(credentials?.password_hash, body.password as string)) throw new ApiError(401);
    const token = secret(), sessionHash = digest(config, token, 'session'), expires = new Date(Date.now() + 24 * 3600 * 1000);
    const user = await transaction(pool, async db => {
      // 切换账户时也先锁旧会话用户；两名用户按 ID 排序，避免互换登录死锁。
      const result = await db.query('SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE', [[credentials.id, ...(previous ? [previous.user.id] : [])]]);
      const current = result.rows.find(row => row.id === credentials.id);
      const identity = await db.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [credentials.id]);
      if (!current || identity.rows[0]?.password_hash !== credentials.password_hash) throw new ApiError(401);
      if (['suspended', 'deleted'].includes(current.status)) throw new ApiError(403, 'ACCOUNT_UNAVAILABLE');
      if (!current.email_verified_at || current.status !== 'active') throw new ApiError(403, 'EMAIL_VERIFICATION_REQUIRED');
      if (previous) await db.query(`UPDATE auth_sessions SET revoked_at=now(),updated_at=now()
        WHERE id=$1 AND user_id=$2 AND session_secret_hash=$3`, [previous.sessionId, previous.user.id, previous.sessionHash]);
      await db.query(`INSERT INTO auth_sessions(id,user_id,session_secret_hash,expires_at,last_seen_at) VALUES($1,$2,$3,$4,now())`, [id('ses'), current.id, sessionHash, expires]);
      await db.query('UPDATE users SET last_login_at=now(),updated_at=now() WHERE id=$1', [current.id]);
      await audit(db, current.id, 'login', current.id, request.id);
      return { id: current.id, email: current.email, display_name: current.display_name, locale: current.locale, status: current.status, email_verified_at: current.email_verified_at, created_at: current.created_at };
    });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: 86400 });
    reply.clearCookie(FLOW_COOKIE, cookieOptions);
    return { user, session_expires_at: expires.toISOString(), csrf_token: csrf(config, `session:${sessionHash}`, expires) };
  });
  app.get('/api/v1/auth/me', async request => {
    const session = await requireSession(pool, config, request);
    return { user: session.user, session_expires_at: session.expires.toISOString() };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!;
    await transaction(pool, async db => {
      await lockAuthenticated(db, config, session);
      await db.query('UPDATE auth_sessions SET revoked_at=now(),updated_at=now() WHERE id=$1', [session.sessionId]);
      await audit(db, session.user.id, 'logout', session.user.id, request.id);
    });
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/logout-all', async (request, reply) => {
    const session = (await requireWrite(pool, config, request))!;
    const body = input('LogoutAllInput', request.body);
    const result = await pool.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [session.user.id]);
    const hash = result.rows[0]?.password_hash;
    if (!await verifyPassword(hash, body.current_password as string)) throw new ApiError(401);
    await transaction(pool, async db => {
      await lockAuthenticated(db, config, session);
      const current = await db.query('SELECT password_hash FROM auth_identities WHERE user_id=$1', [session.user.id]);
      if (current.rows[0]?.password_hash !== hash) throw new ApiError(401);
      await db.query('UPDATE auth_sessions SET revoked_at=now(),updated_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [session.user.id]);
      await audit(db, session.user.id, 'logout_all', session.user.id, request.id);
    });
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/password-reset', async (request, reply) => {
    const body = input('ResetPasswordInput', request.body);
    checkPassword(body.new_password as string);
    const hash = await hashPassword(body.new_password as string);
    await transaction(pool, async db => {
      const { user, action } = await actionTarget(db, config, body.token as string, 'reset_password');
      if (action.used_at) throw new ApiError(410);
      await db.query(`UPDATE auth_identities SET password_hash=$1,credential_changed_at=now(),updated_at=now() WHERE user_id=$2 AND provider='password'`, [hash, user.id]);
      await db.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [action.id]);
      await db.query(`UPDATE auth_tokens SET revoked_at=now() WHERE user_id=$1 AND purpose='reset_password' AND id<>$2 AND revoked_at IS NULL`, [user.id, action.id]);
      await db.query('UPDATE auth_sessions SET revoked_at=now(),updated_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
      await db.query(`UPDATE email_outbox SET sensitive_payload_ciphertext=NULL,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE user_id=$1 AND template_key='reset_password'`, [user.id]);
      await audit(db, user.id, 'reset_password', user.id, request.id);
    });
    return reply.code(204).send();
  });
}
