import { loadConfig } from './config.js';
import { assertAppDatabase, createPool } from './db.js';
import { createApp } from './app.js';
import { runWebsiteJobs } from './website-worker.js';
import { runMenuJobs } from './menu-worker.js';
import { closeInterruptedAiCalls } from './ai-metering.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = createApp({ pool, config });
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let flight: Promise<void> | undefined;
  app.addHook('onClose', async () => {
    stopping = true;
    if (timer) clearInterval(timer);
    if (flight) await flight;
    await pool.end();
  });
  const work = () => {
    if (stopping || flight) return;
    flight = (async () => { await closeInterruptedAiCalls(pool); await runMenuJobs(pool, config); await runWebsiteJobs(pool, config); })().catch(() => {
      process.stderr.write('网页任务处理异常；持久任务将按租约核查，不自动重复计费\n');
    }).finally(() => { flight = undefined; });
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await app.close(); } catch { process.stderr.write('后端关闭失败\n'); process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await assertAppDatabase(pool);
    await pool.query('SELECT id FROM website_jobs LIMIT 0');
    await pool.query('SELECT id FROM menu_jobs LIMIT 0');
    await pool.query('SELECT id FROM ai_model_calls LIMIT 0');
    await pool.query('SELECT id FROM analytics_events LIMIT 0');
    await pool.query('SELECT id FROM billing_plan_versions LIMIT 0');
    await pool.query('SELECT id FROM billing_subscriptions LIMIT 0');
    await pool.query('SELECT version_id FROM website_version_sources LIMIT 0');
    await pool.query('SELECT id FROM website_content_actions LIMIT 0');
    await app.listen({ host: config.host, port: config.port });
    timer = setInterval(work, 1500);
    timer.unref();
    work();
  } catch {
    process.stderr.write('配置、数据库或监听失败；拒绝启动\n');
    await shutdown();
    process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write('后端配置无效；拒绝启动\n'); process.exitCode = 1; });
