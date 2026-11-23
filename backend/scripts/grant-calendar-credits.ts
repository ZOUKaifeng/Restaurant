import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, createPool } from '../src/db.js';
import { grantCurrentCalendarCredits, readCalendarQuota } from '../src/calendar-credits.js';
import type { AiQuotaView } from '../src/ai-usage-types.js';

export function parseCalendarCreditArgs(args: string[]): { userId: string; credits: number; key: string; apply: boolean } {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--apply') {
      if (apply) throw new Error('不能重复 --apply');
      apply = true;
    } else {
      if (!['--user-id', '--credits', '--key'].includes(argument) || values.has(argument)) throw new Error('授额参数无效或重复');
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('授额参数缺少值');
      values.set(argument, value);
    }
  }
  const userId = values.get('--user-id') ?? '', key = values.get('--key') ?? '';
  if (key.startsWith('calendar-test:')) throw new Error('calendar-test: 是消费专用幂等命名空间，不能授额');
  if (!/^usr_[A-Za-z0-9_-]{24}$/.test(userId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || values.get('--credits') !== '10000') {
    throw new Error('本轮仅允许 --user-id、--credits 10000 和显式 --key；默认 dry-run');
  }
  return { userId, credits: 10000, key, apply };
}
export function assertCalendarCreditEnvironment(config: Pick<Config, 'nodeEnv' | 'databaseUrl' | 'migrationDatabaseUrl'>): void {
  if (config.nodeEnv !== 'development' || !config.migrationDatabaseUrl) throw new Error('测试授额仅允许本地 development');
  const endpoint = (value: string, role: string): URL => {
    if (/[\s\\?#]/u.test(value)) throw new Error('测试授额数据库连接必须为固定本地端点');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== '55439' || url.pathname !== '/restaurant_dev' || url.username !== role || !url.password ||
        value.slice(value.lastIndexOf('@') + 1) !== `${url.hostname}:55439/restaurant_dev` || url.search || url.hash) {
      throw new Error('测试授额仅允许固定本地 restaurant_dev 及对应 app/owner 角色');
    }
    return url;
  };
  const app = endpoint(config.databaseUrl, 'restaurant_app'), owner = endpoint(config.migrationDatabaseUrl, 'restaurant_owner');
  if (app.hostname !== owner.hostname || app.port !== owner.port || app.pathname !== owner.pathname) {
    throw new Error('应用与迁移连接必须指向同一固定本地数据库');
  }
}
function credits(tokens: number): string {
  const value = BigInt(tokens), absolute = value < 0n ? -value : value;
  const fraction = (absolute % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / 100n}${fraction ? `.${fraction}` : ''}`;
}
function receipt(view: AiQuotaView): object {
  return view.configured ? { configured: true, enforced: false, granted_credits: credits(view.granted_tokens),
    available_credits: credits(view.available_tokens), reserved_credits: credits(view.reserved_tokens),
    consumed_credits: credits(view.consumed_tokens), period: view.period } : { configured: false, enforced: false,
    granted_credits: null, available_credits: null, reserved_credits: null, consumed_credits: null };
}
async function main(): Promise<void> {
  const input = parseCalendarCreditArgs(process.argv.slice(2));
  // 配置仅从 CLI 继承的环境读取；不自行读取 .env 或输出连接、密钥及原始 tokens。
  const config = loadConfig();
  assertCalendarCreditEnvironment(config);
  const app = createPool(config.databaseUrl), owner = createPool(config.migrationDatabaseUrl!);
  try {
    await assertAppDatabase(app);
    const identity = (await owner.query(`SELECT current_database() AS database,current_user AS role,session_user AS session_role`)).rows[0];
    if (identity?.database !== 'restaurant_dev' || identity.role !== 'restaurant_owner' || identity.session_role !== 'restaurant_owner') {
      throw new Error('授额连接实际身份不匹配');
    }
    const user = (await app.query<{ id: string | null; status: string | null }>(`SELECT a.id,a.status FROM users u
      LEFT JOIN billing_accounts a ON a.owner_user_id=u.id
      WHERE u.id=$1 AND u.status='active' AND u.email_verified_at IS NOT NULL`, [input.userId])).rows[0];
    if (!user || (user.id !== null && user.status !== 'active')) throw new Error('指定用户或计量账户未就绪');
    const month = (await app.query<{ month: string; at: string; starts_at: string; ends_at: string }>(`WITH clock AS MATERIALIZED (
      SELECT statement_timestamp() AS at),month AS (
      SELECT at,date_trunc('month',at AT TIME ZONE 'UTC') AS start FROM clock)
      SELECT to_char(start,'YYYY-MM') AS month,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        to_char(start,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
        to_char(start+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM month`)).rows[0]!;
    // key 保留已确认的月份；月底后重跑旧 dry-run 命令不能悄悄授权下个月。
    if (!input.key.endsWith(`:${month.month}`)) throw new Error('授额 key 必须以已确认 UTC 当前月份 :YYYY-MM 结尾');
    const view = input.apply ? await grantCurrentCalendarCredits(owner, input.userId, input.credits, input.key, month.month)
      : await readCalendarQuota(app, user.id, month.at);
    if (view.configured && (view.period.starts_at !== month.starts_at || view.period.ends_at !== month.ends_at)) {
      throw new Error('授额结果与已确认 UTC 月份不一致');
    }
    process.stdout.write(`${JSON.stringify({ operation: input.apply ? 'apply' : 'dry-run', requested_credits: input.credits,
      mode: 'observation', payments_enabled: false, actual_fees: false, timezone: 'UTC', auto_renew: false,
      current_month: { month: month.month, starts_at: month.starts_at, ends_at: month.ends_at }, quota: receipt(view) })}\n`);
  } finally { await Promise.all([app.end(), owner.end()]); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('自然月测试积分授额失败；请核查本地环境、真实用户、014 迁移及当前月份幂等键\n');
  process.exitCode = 1;
});
