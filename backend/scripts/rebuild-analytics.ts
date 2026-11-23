import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, createPool } from '../src/db.js';
import { rebuildAnalyticsDays, type AnalyticsNamespace } from '../src/analytics-access.js';

// Explicit one-shot maintenance action: never schedules itself or deletes raw events.
async function main(): Promise<void> {
  const [rid, namespace, from, to, ...extra] = process.argv.slice(2);
  if (!rid || !/^[A-Za-z0-9_-]{16,64}$/.test(rid) || !['local_test', 'production'].includes(namespace ?? '') || !from || !to || extra.length)
    throw new Error('需要餐厅ID、local_test|production、起始日期和结束日期');
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await assertAppDatabase(pool);
    await rebuildAnalyticsDays(pool, rid, namespace as AnalyticsNamespace, from, to);
    process.stdout.write('指定餐厅与日期范围的统计已从原始事件重算，不重复累加\n');
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('统计重算失败；请核对参数、权限与数据库配置\n'); process.exitCode = 1;
});
