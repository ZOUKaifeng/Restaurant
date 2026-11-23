import type { Pool } from 'pg';
import { id, transaction, type Database } from './db.js';
import type { AiQuotaView } from './ai-usage-types.js';
import { ApiError } from './errors.js';

const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const unconfigured = (): AiQuotaView => ({ configured: false, enforced: false, available_tokens: null,
  granted_tokens: null, reserved_tokens: null, consumed_tokens: null });
type QuotaRow = {
  id: string; starts_at: string; ends_at: string; granted_at: string;
  granted_tokens: string; reserved_tokens: string; consumed_tokens: string; available_tokens: string;
};
function integer(value: string, signed = false): bigint {
  if (!(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)) throw new ApiError(422, 'AI_USAGE_OVERFLOW');
  const result = BigInt(value);
  if (result < -maximum || result > maximum) throw new ApiError(422, 'AI_USAGE_OVERFLOW');
  return result;
}
function quota(row: QuotaRow): AiQuotaView {
  const granted = integer(row.granted_tokens), reserved = integer(row.reserved_tokens), consumed = integer(row.consumed_tokens);
  const available = integer(row.available_tokens, true);
  if (granted - reserved - consumed !== available) throw new ApiError(422, 'AI_USAGE_OVERFLOW');
  return { configured: true, enforced: false, granted_tokens: Number(granted), reserved_tokens: Number(reserved),
    consumed_tokens: Number(consumed), available_tokens: Number(available), period: {
      id: row.id, starts_at: row.starts_at, ends_at: row.ends_at, granted_at: row.granted_at,
      timezone: 'UTC', origin: 'development_test', tokens_per_credit: 100, auto_renew: false,
    } };
}

export async function readCalendarQuota(db: Database, accountId: string | null, at?: string): Promise<AiQuotaView> {
  if (accountId === null) return unconfigured();
  // 可复用报告 generated_at 的 PG 锚点；默认 statement 时钟，不依赖 JS 时钟，不生成过期账本。
  const { rows } = await db.query<QuotaRow>(`WITH clock AS MATERIALIZED (SELECT coalesce($2::timestamptz,statement_timestamp()) AS at),
    month AS (SELECT at,date_trunc('month',at AT TIME ZONE 'UTC') AS start FROM clock)
    SELECT p.id,to_char(p.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(p.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at,
      to_char(g.granted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at,
      p.granted_tokens::text,p.reserved_tokens::text,p.consumed_tokens::text,p.available_tokens::text
    FROM ai_calendar_credit_grants g JOIN ai_quota_periods p ON p.id=g.period_id AND p.billing_account_id=g.billing_account_id
    JOIN billing_accounts a ON a.id=g.billing_account_id AND a.owner_user_id=g.actor_user_id CROSS JOIN month m
    WHERE a.id=$1 AND a.status='active' AND p.kind='trial' AND g.timezone='UTC' AND g.origin='development_test'
      AND g.tokens_per_credit=100 AND g.auto_renew=false AND g.granted_at<=m.at
      AND p.starts_at=(m.start AT TIME ZONE 'UTC') AND p.ends_at=((m.start+interval '1 month') AT TIME ZONE 'UTC')
      AND p.starts_at<=m.at AND m.at<p.ends_at`, [accountId, at ?? null]);
  return rows[0] ? quota(rows[0]) : unconfigured();
}

export async function grantCurrentCalendarCredits(owner: Pool, userId: string, credits: number, key: string, expectedMonth?: string): Promise<AiQuotaView> {
  if (key.startsWith('calendar-test:')) throw new Error('calendar-test: 是消费专用幂等命名空间，不能授额');
  if (expectedMonth !== undefined && !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(expectedMonth)) throw new Error('预期授额月份必须为 YYYY-MM');
  if (!/^usr_[A-Za-z0-9_-]{24}$/.test(userId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key) ||
      !Number.isSafeInteger(credits) || credits <= 0 || BigInt(credits) * 100n > maximum) {
    throw new Error('授额需要有效用户、稳定幂等键及安全正整数积分');
  }
  const tokens = (BigInt(credits) * 100n).toString();
  return transaction(owner, async db => {
    const user = await db.query(`SELECT id FROM users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR NO KEY UPDATE`, [userId]);
    if (!user.rows[0]) throw new Error('授额需要真实已验证活跃用户');
    // 显式授额可为真实用户建立计量账户，但不调用 AI、不创建用户或套餐。
    await db.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING', [id('bla'), userId]);
    const account = (await db.query<{ id: string; status: string }>(
      'SELECT id,status FROM billing_accounts WHERE owner_user_id=$1 FOR NO KEY UPDATE', [userId])).rows[0];
    if (!account || account.status !== 'active') throw new Error('授额需要活跃归属账户');
    const month = (await db.query<{ month: string; starts_at: string; ends_at: string }>(`WITH month AS (
      SELECT date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AS start)
      SELECT to_char(start,'YYYY-MM') AS month,to_char(start,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
        to_char(start+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM month`)).rows[0]!;
    if (expectedMonth !== undefined && expectedMonth !== month.month) {
      throw new Error('预期授额月份已变化，请重新确认 UTC 当前月授权');
    }
    const previous = (await db.query<{ id: string; billing_account_id: string; kind: string; active_month: boolean;
      registered: boolean; actor_user_id: string | null; amount: string | null }>(`SELECT p.id,p.billing_account_id,p.kind,
      p.starts_at=$2::timestamptz AND p.ends_at=$3::timestamptz AS active_month,
      g.period_id IS NOT NULL AS registered,g.actor_user_id,l.delta_granted_tokens::text AS amount
      FROM ai_quota_periods p LEFT JOIN ai_calendar_credit_grants g ON g.period_id=p.id AND g.billing_account_id=p.billing_account_id
      LEFT JOIN ai_quota_ledger l ON l.period_id=p.id AND l.idempotency_key=p.grant_key AND l.entry_type='grant'
        AND l.actor_user_id=$4 AND l.reason_code='DEVELOPMENT_TEST_GRANT'
      WHERE p.grant_key=$1 FOR UPDATE OF p`, [key, month.starts_at, month.ends_at, userId])).rows[0];
    if (previous) {
      if (previous.billing_account_id !== account.id || previous.kind !== 'trial' || !previous.active_month ||
          !previous.registered || previous.actor_user_id !== userId || previous.amount !== tokens) {
        throw new Error('授额幂等键不能改变用户、金额、周期或既有登记');
      }
    } else {
      if ((await db.query("SELECT id FROM ai_quota_periods WHERE billing_account_id=$1 AND kind='trial' FOR UPDATE", [account.id])).rows[0]) {
        throw new Error('账户已经使用一次 trial；额外或跨月授额必须明确独立策略');
      }
      const periodId = id('aqp');
      await db.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
        VALUES($1,$2,'trial',$3::timestamptz,$4::timestamptz,$5)`, [periodId, account.id, month.starts_at, month.ends_at, key]);
      await db.query(`SELECT apply_ai_quota_entry($1,$2,NULL,'grant',$3,$4::bigint,0::bigint,0::bigint,'DEVELOPMENT_TEST_GRANT',$5)`,
        [periodId, account.id, key, tokens, userId]);
      // 默认 granted_at 是实际 DB clock；只登记之后开始的新调用，绝不扫描/补扣旧调用。
      await db.query('INSERT INTO ai_calendar_credit_grants(period_id,billing_account_id,actor_user_id) VALUES($1,$2,$3)',
        [periodId, account.id, userId]);
    }
    const result = await readCalendarQuota(db, account.id);
    if (!result.configured) throw new Error('授额期间自然月已结束，请重新确认本月授权');
    return result;
  });
}
