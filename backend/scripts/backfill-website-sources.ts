import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config.js';
import { assertAppDatabase, createPool, transaction } from '../src/db.js';
import { verifyWebsiteVersion, type WebsiteVersion } from '../src/website-access.js';
import { renderWebsite } from '../src/website-html.js';
import { insertWebsiteSource, websiteSourceBindingsAvailable } from '../src/website-source.js';
import type { WebsiteRawSource } from '../src/website-content-types.js';

export function assertWebsiteBackfillApply(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const url = new URL(config.databaseUrl);
  if (config.nodeEnv === 'production') throw new Error('禁止对生产环境回填');
  const development = config.nodeEnv === 'development' && url.pathname === '/restaurant_dev' && url.port !== '55440' &&
    decodeURIComponent(url.username) === 'restaurant_app' && ['localhost', '127.0.0.1'].includes(url.hostname);
  const port = env.TEST_PG_PORT ?? '55439', major = env.TEST_PG_MAJOR ?? '16';
  // 新端口仅对调用方明确提供的同一 TEST 连接对开放，不扩大 development/production 授权。
  const testEndpoint = (value: string | undefined, role: string): boolean => {
    if (!value || /[\s\\?#]/u.test(value)) return false;
    try {
      const endpoint = new URL(value);
      return ['postgres:', 'postgresql:'].includes(endpoint.protocol) && endpoint.hostname === '127.0.0.1' &&
        endpoint.port === port && endpoint.pathname === '/restaurant_test' && endpoint.username === role &&
        value.slice(value.lastIndexOf('@') + 1) === `127.0.0.1:${port}/restaurant_test` &&
        !!decodeURIComponent(endpoint.password) && !endpoint.search && !endpoint.hash;
    } catch { return false; }
  };
  const isolatedTest = config.nodeEnv === 'test' && env.WEBSITE_SOURCE_BACKFILL_ALLOW_TEST === 'restaurant_test' &&
    ['16', '17'].includes(major) && (port === '55439' || (port === '55440' && env.TEST_PG_MAJOR === '17')) &&
    env.TEST_DATABASE_URL === config.databaseUrl && env.TEST_MIGRATION_DATABASE_URL === config.migrationDatabaseUrl &&
    testEndpoint(env.TEST_DATABASE_URL, 'restaurant_test_app') && testEndpoint(env.TEST_MIGRATION_DATABASE_URL, 'restaurant_test_owner');
  if (!development && !isolatedTest) throw new Error('apply 仅允许 restaurant_dev；独立测试需显式环境授权');
}
type Candidate = WebsiteVersion & { source_job_id: string; agent_draft: unknown; source_restaurant_revision: unknown };
export type WebsiteBackfillEntry = { restaurant_id: string; version_id: string; source_job_id: string | null;
  state: 'no_successful_draft' | 'revision_unknown' | 'incompatible' | 'would_insert' | 'inserted' | 'already_inserted' };
function usableDraft(candidate: Candidate): { raw: WebsiteRawSource; restaurantRevision: number } | null {
  const value = candidate.agent_draft as Partial<WebsiteRawSource> | null;
  if (!value || typeof value.html_body !== 'string' || typeof value.css !== 'string' || typeof value.summary !== 'string') return null;
  return { raw: { html_body: value.html_body, css: value.css, summary: value.summary }, restaurantRevision: Number(candidate.source_restaurant_revision) };
}
export async function backfillWebsiteSources(pool: Pool, config: Config, apply = false, env: NodeJS.ProcessEnv = process.env): Promise<WebsiteBackfillEntry[]> {
  if (apply) assertWebsiteBackfillApply(config, env);
  // 只读取成功任务的实际 agent_draft；不得从编译 HTML 或当前菜单猜测原稿。
  const versions = (await pool.query<Candidate & { has_source: boolean }>(`SELECT v.*,s.version_id IS NOT NULL AS has_source,
    j.id AS source_job_id,j.agent_draft,j.input->'expected_restaurant_revision' AS source_restaurant_revision
    FROM website_versions v LEFT JOIN website_version_sources s ON s.restaurant_id=v.restaurant_id AND s.version_id=v.id
    LEFT JOIN LATERAL (SELECT j.* FROM website_jobs j WHERE j.restaurant_id=v.restaurant_id AND j.result_version_id=v.id
      AND j.kind='generate' AND j.status='succeeded' AND j.snapshot=v.snapshot AND j.agent_draft IS NOT NULL
      ORDER BY j.created_at,j.id LIMIT 1) j ON true ORDER BY v.restaurant_id,v.version_number,v.id`)).rows;
  const report: WebsiteBackfillEntry[] = [];
  for (const candidate of versions) {
    const entry: WebsiteBackfillEntry = { restaurant_id: candidate.restaurant_id, version_id: candidate.id,
      source_job_id: candidate.source_job_id ?? null, state: 'no_successful_draft' };
    report.push(entry);
    if (candidate.has_source) { entry.state = 'already_inserted'; continue; }
    const draft = usableDraft(candidate);
    if (!draft || !candidate.source_job_id) continue;
    if (candidate.source_restaurant_revision === null || typeof candidate.source_restaurant_revision !== 'number' ||
        !Number.isInteger(draft.restaurantRevision) || draft.restaurantRevision < 0 || draft.restaurantRevision > 2147483647) {
      entry.state = 'revision_unknown'; continue;
    }
    try {
      verifyWebsiteVersion(candidate);
      const rendered = renderWebsite(draft.raw, candidate.snapshot);
      if (rendered.html !== candidate.html || rendered.checksum !== candidate.checksum || !websiteSourceBindingsAvailable(draft.raw, candidate.snapshot)) {
        entry.state = 'incompatible'; continue;
      }
    } catch { entry.state = 'incompatible'; continue; }
    const manifest = (await pool.query(`SELECT NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements($2::jsonb) saved LEFT JOIN assets a ON a.restaurant_id=$1 AND a.id=saved->>'id'
        AND a.status='ready' AND a.safety_status='approved'
        AND saved=jsonb_build_object('id',a.id,'kind',a.kind,'mime_type',a.mime_type,'checksum',a.checksum,
          'width_px',a.width_px,'height_px',a.height_px) WHERE a.id IS NULL) AS ready`,
    [candidate.restaurant_id, JSON.stringify(candidate.snapshot.assets)])).rows[0];
    if (!manifest.ready) { entry.state = 'incompatible'; continue; }
    entry.state = 'would_insert';
    if (!apply) continue;
    entry.state = await transaction(pool, async db => {
      await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [candidate.restaurant_id]);
      const existing = (await db.query('SELECT version_id FROM website_version_sources WHERE restaurant_id=$1 AND version_id=$2',
        [candidate.restaurant_id, candidate.id])).rowCount;
      if (existing) return 'already_inserted';
      await insertWebsiteSource(db, candidate, draft.raw, { origin: 'generation', jobId: candidate.source_job_id,
        restaurantRevision: draft.restaurantRevision, menuRevision: candidate.snapshot.menu?.revision ?? null });
      return 'inserted';
    });
  }
  return report;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('仅接受 --apply；默认 dry-run');
  // .env.local 由 Node CLI --env-file 继承；本脚本不读取或打印配置文件、密钥或原稿。
  const config = loadConfig(), apply = args[0] === '--apply';
  if (apply) assertWebsiteBackfillApply(config);
  const pool = createPool(config.databaseUrl);
  try {
    await assertAppDatabase(pool);
    const entries = await backfillWebsiteSources(pool, config, apply);
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', entries })}\n`);
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('原稿回填失败；请核查授权环境、迁移、参数及素材状态\n'); process.exitCode = 1;
});
