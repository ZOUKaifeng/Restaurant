import { loadConfig } from './config.js';
import { assertAppDatabase, createPool } from './db.js';
import { createSiteApp } from './sites.js';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = createSiteApp({ pool, config });
  app.addHook('onClose', async () => { await pool.end(); });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  try {
    await assertAppDatabase(pool);
    await pool.query('SELECT restaurant_id FROM website_publications LIMIT 0');
    await pool.query('SELECT id FROM analytics_events LIMIT 0');
    await app.listen({ host: config.website!.host, port: config.website!.port });
    process.stdout.write(`本地只读站点服务：${config.website!.publicOrigin}（非公网部署）\n`);
  } catch { await close(); throw new Error('本地站点启动失败'); }
}
main().catch(() => { process.stderr.write('站点配置或数据库无效，拒绝启动\n'); process.exitCode = 1; });
