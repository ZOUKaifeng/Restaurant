import type { Pool, PoolClient } from 'pg';
import { id, transaction } from './db.js';
import type { AiCallStart, AiCallFinish, AiCallIdentity, AiTokenUsage } from './ai-usage-types.js';

type BillingAccount = { id: string; status: 'active' | 'suspended' | 'closed' };
type CallRecord = {
  id: string; billing_account_id: string; requesting_user_id: string; restaurant_id: string;
  website_job_id: string | null; menu_job_id: string | null; runner_token: string; model: string;
  call_status: 'started' | 'completed' | 'failed'; usage_status: 'pending' | 'known' | 'unknown';
};

function identity(input: AiCallIdentity): [string | null, string | null, number, string] {
  const websiteJobId = input.websiteJobId ?? null, menuJobId = input.menuJobId ?? null;
  if ((websiteJobId !== null) === (menuJobId !== null) || !input.requestingUserId || !input.restaurantId ||
    (websiteJobId !== null && !websiteJobId) || (menuJobId !== null && !menuJobId) ||
    !Number.isInteger(input.callIndex) || input.callIndex < 1 || input.callIndex > 2147483647 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.runnerToken)) {
    throw new Error('无效 AI 调用 identity');
  }
  return [websiteJobId, menuJobId, input.callIndex, input.runnerToken.toLowerCase()];
}
function assertIdentity(call: CallRecord, input: AiCallIdentity, runner: string): void {
  if (call.requesting_user_id !== input.requestingUserId || call.restaurant_id !== input.restaurantId ||
    call.website_job_id !== (input.websiteJobId ?? null) || call.menu_job_id !== (input.menuJobId ?? null) ||
    call.runner_token !== runner) throw new Error('AI 调用 identity 或原 runner 不匹配');
}
function validateUsage(usage: AiTokenUsage | null | undefined): void {
  if (usage == null) return;
  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  if (![prompt_tokens, completion_tokens, total_tokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(prompt_tokens + completion_tokens) || prompt_tokens + completion_tokens !== total_tokens) {
    throw new Error('AI 用量必须为一致的安全非负整数');
  }
}

// 仅供首次真实调用使用；GET 应直接 SELECT 并保留 null，不调用此函数。
// 调用方使用现有事务，并在 start 之前保持 user → restaurant → member → job 锁顺序。
export async function ensureBillingAccount(db: PoolClient, userId: string): Promise<BillingAccount> {
  const existing = (await db.query<BillingAccount>('SELECT id,status FROM billing_accounts WHERE owner_user_id=$1', [userId])).rows[0];
  if (existing) return existing;
  await db.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING', [id('bla'), userId]);
  const account = (await db.query<BillingAccount>('SELECT id,status FROM billing_accounts WHERE owner_user_id=$1', [userId])).rows[0];
  if (!account) throw new Error('AI 计量账户不存在');
  return account;
}

export async function startAiCall(db: PoolClient, input: AiCallStart): Promise<string> {
  const [websiteJobId, menuJobId, callIndex, runner] = identity(input);
  if (typeof input.model !== 'string' || input.model.length < 1 || input.model.length > 100) throw new Error('无效 AI 模型名称');
  const account = await ensureBillingAccount(db, input.requestingUserId);
  const parameters = [websiteJobId, menuJobId, callIndex];
  const select = `SELECT * FROM ai_model_calls WHERE website_job_id IS NOT DISTINCT FROM $1::text
    AND menu_job_id IS NOT DISTINCT FROM $2::text AND call_index=$3 FOR UPDATE`;
  const previous = (await db.query<CallRecord>(select, parameters)).rows[0];
  if (previous) {
    assertIdentity(previous, input, runner);
    if (previous.model !== input.model || previous.billing_account_id !== account.id) throw new Error('AI 调用模型或计量账户不可修改');
    return previous.id;
  }
  const callId = id('aic');
  const inserted = await db.query<{ id: string }>(`INSERT INTO ai_model_calls(id,billing_account_id,requesting_user_id,restaurant_id,
    website_job_id,menu_job_id,feature,model,call_index,runner_token,request_key)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5::text IS NOT NULL THEN
      (SELECT CASE kind WHEN 'chat' THEN 'website_chat' WHEN 'generate' THEN 'website_generate' END FROM website_jobs WHERE id=$5)
      ELSE 'menu_recognition' END,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
  [callId, account.id, input.requestingUserId, input.restaurantId, websiteJobId, menuJobId, input.model, callIndex, runner,
    `${websiteJobId ?? menuJobId}:${callIndex}`]);
  if (inserted.rows[0]) return inserted.rows[0].id;
  const concurrent = (await db.query<CallRecord>(select, parameters)).rows[0];
  if (!concurrent) throw new Error('AI 调用逻辑请求键冲突');
  assertIdentity(concurrent, input, runner);
  if (concurrent.model !== input.model || concurrent.billing_account_id !== account.id) throw new Error('AI 调用模型或计量账户不可修改');
  return concurrent.id;
}

export async function finishAiCall(db: PoolClient, input: AiCallFinish): Promise<void> {
  const [websiteJobId, menuJobId, callIndex, runner] = identity(input);
  if (!['completed', 'failed'].includes(input.status) || !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0 ||
    (input.errorCode !== undefined && (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.errorCode) || input.status !== 'failed'))) {
    throw new Error('无效 AI 调用结算');
  }
  validateUsage(input.usage);
  // 不重新锁定或校验任务权限/租约；撤权、取消、任务终态后已经发生的用量仍需记录。
  const call = (await db.query<CallRecord>(`SELECT * FROM ai_model_calls WHERE website_job_id IS NOT DISTINCT FROM $1::text
    AND menu_job_id IS NOT DISTINCT FROM $2::text AND call_index=$3 FOR UPDATE`, [websiteJobId, menuJobId, callIndex])).rows[0];
  if (!call) throw new Error('AI 调用尚未开始');
  assertIdentity(call, input, runner);
  if (call.call_status !== 'started') {
    if (call.usage_status === 'unknown' && input.usage != null) {
      // 只补用量：即使迟到回调的 status/elapsed/error 不同，也不覆写第一次终态。
      await db.query(`UPDATE ai_model_calls SET usage_status='known',prompt_tokens=$2,completion_tokens=$3,total_tokens=$4,
        received_at=greatest(clock_timestamp(),finished_at) WHERE id=$1`,
      [call.id, input.usage.prompt_tokens, input.usage.completion_tokens, input.usage.total_tokens]);
    }
    return;
  }
  await db.query(`UPDATE ai_model_calls SET call_status=$2,usage_status=$3,prompt_tokens=$4,completion_tokens=$5,total_tokens=$6,
    elapsed_ms=$7,error_code=$8,finished_at=greatest(statement_timestamp(),created_at),
    received_at=CASE WHEN $3='known' THEN greatest(statement_timestamp(),created_at) ELSE NULL END WHERE id=$1`,
  [call.id, input.status, input.usage == null ? 'unknown' : 'known', input.usage?.prompt_tokens ?? null,
    input.usage?.completion_tokens ?? null, input.usage?.total_tokens ?? null, input.elapsedMs, input.errorCode ?? null]);
}

export async function closeInterruptedAiCalls(pool: Pool): Promise<number> {
  return transaction(pool, async db => {
    // 只锁调用行；旧 user/job 与额度行均不加锁，避免反序，也不推断已发生的用量。
    const result = await db.query(`WITH interrupted AS (
      SELECT c.id,coalesce(w.status,m.status) AS job_status,coalesce(w.error_code,m.error_code) AS job_error_code,
        coalesce(w.lease_expires_at,m.lease_expires_at) AS lease_expires_at
      FROM ai_model_calls c
      LEFT JOIN website_jobs w ON w.id=c.website_job_id AND w.restaurant_id=c.restaurant_id
        AND w.requesting_user_id=c.requesting_user_id
      LEFT JOIN menu_jobs m ON m.id=c.menu_job_id AND m.restaurant_id=c.restaurant_id
        AND m.requesting_user_id=c.requesting_user_id
      WHERE c.call_status='started' AND (
        w.status IN ('failed','succeeded') OR (w.status='running' AND w.lease_expires_at<=statement_timestamp()) OR
        m.status IN ('failed','succeeded') OR (m.status='running' AND m.lease_expires_at<=statement_timestamp()))
      ORDER BY c.created_at,c.id LIMIT 50 FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE ai_model_calls c SET call_status='failed',usage_status='unknown',elapsed_ms=NULL,
      finished_at=greatest(clock_timestamp(),c.created_at),
      error_code=CASE WHEN interrupted.job_status='failed' AND interrupted.job_error_code='AGENT_CANCELLED'
        THEN 'AGENT_CANCELLED' ELSE 'JOB_INTERRUPTED' END
    FROM interrupted WHERE c.id=interrupted.id AND c.call_status='started' AND (
      interrupted.job_status IN ('failed','succeeded') OR
      (interrupted.job_status='running' AND interrupted.lease_expires_at<=statement_timestamp()))`);
    return result.rowCount ?? 0;
  });
}
