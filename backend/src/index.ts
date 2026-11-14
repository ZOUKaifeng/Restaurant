import { loadConfig } from './config.js';
import { assertAppDatabase, createPool } from './db.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = createApp({ pool, config });
  app.addHook('onClose', async () => { await pool.end(); });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await app.close(); } catch { process.stderr.write('后端关闭失败\n'); process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await assertAppDatabase(pool);
    await app.listen({ host: config.host, port: config.port });
  } catch {
    process.stderr.write('配置、数据库或监听失败；拒绝启动\n');
    await shutdown();
    process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write('后端配置无效；拒绝启动\n'); process.exitCode = 1; });
