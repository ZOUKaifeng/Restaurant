import { createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { loadConfig, type Config } from './config.js';
import { assertAppDatabase, createPool, transaction } from './db.js';
import { secret } from './security.js';

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
export async function runMailBatch(pool: Pool, config: Config): Promise<'disabled' | 'idle' | 'accepted' | 'failed'> {
  await pool.query(`UPDATE email_outbox SET sensitive_payload_ciphertext=NULL,
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now()
    WHERE sensitive_payload_ciphertext IS NOT NULL AND sensitive_payload_expires_at<=now()`);
  // 租约过期表示进程可能已提交 SMTP DATA，绝不直接重新排队。
  await pool.query(`UPDATE email_outbox SET status='failed',last_error_code='DELIVERY_UNKNOWN',lease_token=NULL,
    lease_expires_at=NULL,updated_at=now() WHERE status='sending' AND lease_expires_at<=now()`);
  await pool.query(`UPDATE email_outbox o SET status='cancelled',sensitive_payload_ciphertext=NULL,updated_at=now()
    FROM auth_tokens t,users u WHERE o.auth_token_id=t.id AND t.user_id=u.id AND o.status='queued'
    AND (t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=now()
      OR u.email_normalized<>t.target_email_normalized OR u.status NOT IN ('active','pending_verification'))`);
  if (config.emailMode === 'disabled') return 'disabled';
  if (!config.smtp) throw new Error('缺少 SMTP 配置');
  const lease = secret();
  const task = await transaction(pool, async db => {
    const result = await db.query(`WITH candidate AS (
      SELECT id FROM email_outbox WHERE status='queued' AND available_at<=now() AND scheduled_at<=now()
        AND sensitive_payload_expires_at>now() AND sensitive_payload_ciphertext IS NOT NULL AND attempt_count<max_attempts
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE email_outbox o SET status='sending',attempt_count=attempt_count+1,lease_token=$1,
        lease_expires_at=now()+interval '90 seconds',updated_at=now()
      FROM candidate c WHERE o.id=c.id RETURNING o.*`, [lease]);
    return result.rows[0];
  });
  if (!task) return 'idle';
  const smtp = config.smtp;
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
    requireTLS: !smtp.secure, auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10000, greetingTimeout: 10000,
    socketTimeout: 20000, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
  let submitted = false;
  try {
    const token = decrypt(config, task.id, task.sensitive_payload_ciphertext);
    const verifying = task.template_key === 'verify_email';
    const url = new URL(verifying ? '/auth/verify' : '/auth/reset', config.appOrigin);
    url.hash = `token=${encodeURIComponent(token)}`;
    submitted = true;
    const info = await transport.sendMail({ from: smtp.from, to: task.recipient_email,
      messageId: `<${task.id}@${new URL(config.appOrigin).hostname}>`,
      subject: verifying ? '验证餐厅商家邮箱' : '重置餐厅商家密码',
      text: `${verifying ? '请打开链接并主动确认邮箱验证。' : '请打开链接设置新密码。'}\n${url.href}\n如非本人请求，请忽略此邮件。`,
    });
    if (!info.accepted?.length || info.rejected?.length) throw new Error('SMTP 未接受收件人');
    await pool.query(`UPDATE email_outbox SET status='accepted',accepted_at=now(),provider_message_id=$1,
      sensitive_payload_ciphertext=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=now()
      WHERE id=$2 AND lease_token=$3 AND status='sending'`, [info.messageId, task.id, lease]);
    return 'accepted';
  } catch {
    await pool.query(`UPDATE email_outbox SET status='failed',last_error_code=$1,lease_token=NULL,lease_expires_at=NULL,
      updated_at=now() WHERE id=$2 AND lease_token=$3 AND status='sending'`, [submitted ? 'DELIVERY_UNKNOWN' : 'INVALID_ENCRYPTED_PAYLOAD', task.id, lease]);
    return 'failed';
  } finally { transport.close(); }
}
async function main(): Promise<void> {
  const config = loadConfig(), pool = createPool(config.databaseUrl);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    await assertAppDatabase(pool);
    do {
      const result = await runMailBatch(pool, config);
      if (process.argv.includes('--once')) { process.stdout.write(`邮件任务状态：${result}（accepted 不代表送达）\n`); break; }
      if (!controller.signal.aborted && result !== 'accepted') await setTimeout(1000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('邮件 worker 失败，请核查脱敏任务状态\n'); process.exitCode = 1; });
