import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { assertAppDatabase, createPool } from '../src/db.js';
import { createAssetStore } from '../src/asset-storage.js';
import { cleanupAssetUploadIntents, cleanupDeletedAssets } from '../src/assets.js';

export async function cleanupAssets(): Promise<{ deleted_processed: number; deleted_failed: number; intents_processed: number; intents_cleaned: number; intents_failed: number; intents_blocked: number }> {
  const config = loadConfig(), pool = createPool(config.databaseUrl);
  let store: ReturnType<typeof createAssetStore> | undefined;
  const counts = { deleted_processed: 0, deleted_failed: 0, intents_processed: 0, intents_cleaned: 0, intents_failed: 0, intents_blocked: 0 };
  try {
    await assertAppDatabase(pool);
    store = createAssetStore(config);
    let cursor: string | undefined;
    do {
      const page = await cleanupDeletedAssets(pool, store, 100, cursor);
      counts.deleted_processed += page.processed;
      counts.deleted_failed += page.failed;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    do {
      const page = await cleanupAssetUploadIntents(pool, store, 100, cursor);
      counts.intents_processed += page.processed;
      counts.intents_cleaned += page.cleaned;
      counts.intents_failed += page.failed;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    counts.intents_blocked = (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM asset_upload_intents WHERE state='blocked'")).rows[0]!.count;
    return counts;
  } finally { store?.close(); await pool.end(); }
}
async function main(): Promise<void> {
  const counts = await cleanupAssets();
  // 只输出聚合计数，绝不记录 key、marker、数据库地址、个人信息或凭据。
  process.stdout.write(`${JSON.stringify(counts)}\n`);
  if (counts.deleted_failed || counts.intents_failed || counts.intents_blocked) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('素材清理失败，请检查数据库及存储配置\n'); process.exitCode = 1; });
}
