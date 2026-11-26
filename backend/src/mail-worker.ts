import { createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { loadConfig, type Config } from './config.js';
import { assertAppDatabase, createPool, transaction } from './db.js';
import { secret } from './security.js';
import { sendPostmarkMail, PostmarkMailError } from './postmark-mail.js';
import { renderAccountMail } from './mail-templates.js';
import { startupFailureLine, type StartupStage } from './startup-diagnostics.js';

function decrypt(config: Config, outboxId: string, value: string): string {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('邮件加密格式无效');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.outboxEncryptionKey, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(outboxId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) throw new Error('邮件动作材料无效');
  return data.token;
}
export async function runMailBatch(pool: Pool, config: Config, postmarkFetch?: typeof fetch): Promise<'disabled' | 'idle' | 'accepted' | 'failed'> {
  await pool.query(`UPDATE email_outbox SET sensitive_payload_ciphertext=NULL,
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now()
    WHERE sensitive_payload_ciphertext IS NOT NULL AND sensitive_payload_expires_at<=now()`);
  // 租约过期表示进程可能已提交 SMTP DATA 或 HTTPS 请求，绝不直接重新排队。
  await pool.query(`UPDATE email_outbox SET status='failed',last_error_code='DELIVERY_UNKNOWN',lease_token=NULL,
    lease_expires_at=NULL,updated_at=now() WHERE status='sending' AND lease_expires_at<=now()`);
  await pool.query(`UPDATE email_outbox o SET status='cancelled',sensitive_payload_ciphertext=NULL,updated_at=now()
    FROM auth_tokens t,users u WHERE o.auth_token_id=t.id AND t.user_id=u.id AND o.status='queued'
    AND (t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=now()
      OR u.email_normalized<>t.target_email_normalized OR u.status NOT IN ('active','pending_verification'))`);
  if (config.emailMode === 'disabled') return 'disabled';
  if (config.emailMode === 'smtp' && !config.smtp) throw new Error('缺少 SMTP 配置');
  if (config.emailMode === 'postmark' && !config.postmark) throw new Error('缺少配置 POSTMARK_SERVER_TOKEN');
  const lease = secret();
  const task = await transaction(pool, async db => {
    const result = await db.query(`WITH candidate AS (
      SELECT id FROM email_outbox WHERE status='queued' AND available_at<=now() AND scheduled_at<=now()
        AND sensitive_payload_expires_at>now()
        AND (sensitive_payload_ciphertext IS NOT NULL OR template_key IN
          ('reservation_received','reservation_confirmed','reservation_declined','reservation_cancelled'))
        AND attempt_count<max_attempts
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE email_outbox o SET status='sending',attempt_count=attempt_count+1,lease_token=$1,
        lease_expires_at=now()+interval '90 seconds',updated_at=now()
      FROM candidate c WHERE o.id=c.id RETURNING o.*`, [lease]);
    return result.rows[0];
  });
  if (!task) return 'idle';
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  let submitted = false, providerAccepted = false;
  try {
    const token = task.sensitive_payload_ciphertext ? decrypt(config, task.id, task.sensitive_payload_ciphertext) : null;
    const reservationTemplates = ['reservation_received','reservation_confirmed','reservation_declined','reservation_cancelled'];
    const reservation = reservationTemplates.includes(task.template_key);
    let url: URL | null, subject: string, text: string, html: string | undefined;
    if (reservation) {
      const payload = (task.payload ?? {}) as Record<string, unknown>;
      const reference = typeof payload.reference === 'string' ? payload.reference : '';
      const when = `${typeof payload.local_date === 'string' ? payload.local_date : ''} ${typeof payload.local_time === 'string' ? payload.local_time : ''}`.trim();
      const party = typeof payload.party_size === 'number' ? payload.party_size : '';
      url = token ? new URL(`/r/${encodeURIComponent(token)}`, config.website?.publicOrigin ?? config.appOrigin) : null;
      const intro: Record<string, string> = {
        reservation_received: 'We received your reservation request. It is a request only and is not confirmed until the restaurant responds.',
        reservation_confirmed: 'The restaurant confirmed your reservation.',
        reservation_declined: 'The restaurant could not accept this reservation request.',
        reservation_cancelled: 'This reservation has been cancelled.',
      };
      subject = `${intro[task.template_key]!.split('.')[0]} (${reference})`;
      text = `${intro[task.template_key]!}\nReference: ${reference}\nDate/time: ${when}\nParty size: ${party}\n${url ? `View status or cancel: ${url.href}` : 'Use the link in your confirmation email to view status.'}\nIf you did not make this request, please ignore this email.`;
    } else {
      if (!token) throw new Error('邮件动作材料缺失');
      if (!['verify_email', 'reset_password'].includes(task.template_key)) throw new Error('不支持的邮件模板');
      const purpose = task.template_key as 'verify_email' | 'reset_password';
      url = new URL(purpose === 'verify_email' ? '/auth/verify' : '/auth/reset', config.appOrigin);
      url.hash = `token=${encodeURIComponent(token)}`;
      ({ subject, text, html } = renderAccountMail(purpose, url));
    }
    const messageId = `<${task.id}@${new URL(config.appOrigin).hostname}>`;
    let providerMessageId: string;
    if (config.emailMode === 'postmark') {
      submitted = true;
      const info = await sendPostmarkMail(config.postmark!, { to: task.recipient_email, subject, text, ...(html ? { html } : {}), messageId }, postmarkFetch);
      providerMessageId = info.messageId;
    } else {
      const smtp = config.smtp!;
      transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
        requireTLS: !smtp.secure, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10000, greetingTimeout: 10000,
        socketTimeout: 20000, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
      submitted = true;
      const info = await transport.sendMail({ from: smtp.from, to: task.recipient_email, messageId, subject, text, ...(html ? { html } : {}) });
      if (!info.accepted?.length || info.rejected?.length) throw new Error('SMTP 未接受收件人');
      providerMessageId = info.messageId;
    }
    providerAccepted = true;
    const saved = await pool.query(`UPDATE email_outbox SET status='accepted',accepted_at=now(),provider_message_id=$1,
      sensitive_payload_ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=now()
      WHERE id=$2 AND lease_token=$3 AND status='sending'`, [providerMessageId, task.id, lease]);
    if (saved.rowCount !== 1) throw new Error('邮件接受回执未保存；结果未知');
    return 'accepted';
  } catch (error) {
    const code = !submitted ? 'INVALID_ENCRYPTED_PAYLOAD' :
      !providerAccepted && error instanceof PostmarkMailError ? error.code : 'DELIVERY_UNKNOWN';
    await pool.query(`UPDATE email_outbox SET status='failed',last_error_code=$1,lease_token=NULL,lease_expires_at=NULL,
      updated_at=now() WHERE id=$2 AND lease_token=$3 AND status='sending'`, [code, task.id, lease]);
    if (config.nodeEnv !== 'test') process.stderr.write(`邮件任务失败 [${code}]；未自动重发\n`);
    return 'failed';
  } finally { transport?.close(); }
}
let startupStage: StartupStage = 'CONFIG';
async function main(): Promise<void> {
  const config = loadConfig();
  startupStage = 'DATABASE_CONFIG';
  const pool = createPool(config.databaseUrl);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    startupStage = 'DATABASE_READY';
    await assertAppDatabase(pool);
    process.stdout.write(`邮件进程就绪 [${config.emailMode}]；accepted不代表送达\n`);
    do {
      const result = await runMailBatch(pool, config);
      if (process.argv.includes('--once')) { process.stdout.write(`邮件任务状态：${result}（accepted 不代表送达）\n`); break; }
      if (!controller.signal.aborted && result !== 'accepted') await setTimeout(1000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(startupFailureLine(startupStage, error).replace('后端启动失败', '邮件进程启动失败')); process.exitCode = 1; });
