import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { id, transaction, type Database } from '../src/db.js';
import { websiteSnapshot, type WebsiteRestaurant, type WebsiteVersion } from '../src/website-access.js';
import { renderWebsite, type WebsiteSnapshot } from '../src/website-html.js';
import { insertWebsiteSource } from '../src/website-source.js';
import type { WebsiteRawSource } from '../src/website-content-types.js';

// 只接受已开启事务的隔离测试 owner；不需要 superuser，也不关闭 immutable 或其他触发器。
export async function insertPre012LegacyFixture(db: PoolClient, reason: string,
  insert: () => Promise<unknown>): Promise<void> {
  assert.ok(reason.trim(), '必须明确声明迁移前历史夹具意图');
  await db.query('SAVEPOINT pre012_legacy_fixture');
  try {
    const role = (await db.query('SELECT current_user AS role,current_database() AS database')).rows[0];
    assert.deepEqual(role, { role: 'restaurant_test_owner', database: 'restaurant_test' });
    const guard = (await db.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='website_versions'::regclass
      AND tgname='website_version_source_required'`)).rows[0];
    assert.equal(guard?.tgenabled, 'O', '进入 legacy 夹具前 guard 必须正常启用');
    await db.query('ALTER TABLE website_versions DISABLE TRIGGER website_version_source_required');
    await insert();
    // 成功需保留 INSERT，因此显式恢复 guard；错误则回滚 savepoint，同时恢复 DDL 与 INSERT。
    await db.query('ALTER TABLE website_versions ENABLE TRIGGER website_version_source_required');
    await db.query('RELEASE SAVEPOINT pre012_legacy_fixture');
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT pre012_legacy_fixture');
    await db.query('RELEASE SAVEPOINT pre012_legacy_fixture');
    throw error;
  }
}

export async function insertGeneratedWebsiteFixture(owner: Pool, rid: string, number: number,
  source: WebsiteRawSource = { html_body: '<main><restaurant-name/><restaurant-description/><restaurant-reservation/></main>', css: '', summary: '合法生成夹具' },
  options: { versionId?: string; assetIds?: string[]; snapshot?: WebsiteSnapshot; model?: string; usage?: unknown } = {}): Promise<WebsiteVersion> {
  return transaction(owner, async db => {
    const restaurant = (await db.query<WebsiteRestaurant>('SELECT * FROM restaurants WHERE id=$1 FOR UPDATE', [rid])).rows[0]!;
    const member = (await db.query(`SELECT user_id FROM restaurant_members WHERE restaurant_id=$1
      AND role='owner' AND status='active'`, [rid])).rows[0]!;
    const snapshot = options.snapshot ?? await websiteSnapshot(db, restaurant, options.assetIds ?? [], true);
    const version: WebsiteVersion = { id: options.versionId ?? id('wsv'), restaurant_id: rid, version_number: number,
      summary: source.summary, ...renderWebsite(source, snapshot), snapshot, asset_ids: snapshot.assets.map(a => a.id),
      model: options.model ?? 'fixture-original-model', usage: options.usage ?? null, created_at: new Date() };
    const jid = id('wsj');
    await db.query(`INSERT INTO website_jobs(id,restaurant_id,requesting_user_id,kind,idempotency_key,request_fingerprint,input,snapshot)
      VALUES($1,$2,$3,'generate',$4,$5,$6,$7)`, [jid, rid, member.user_id, id('fixture'), 'a'.repeat(64),
      JSON.stringify({ expected_restaurant_revision: restaurant.revision }), JSON.stringify(snapshot)]);
    for (const asset of snapshot.assets) await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id)
      VALUES($1,$2,$3,'website_job',$4)`, [id('ref'), rid, asset.id, jid]);
    await db.query(`UPDATE website_jobs SET status='running',lease_token=$2,lease_expires_at=clock_timestamp()+interval '180 seconds',agent_draft=$3 WHERE id=$1`,
      [jid, randomUUID(), JSON.stringify(source)]);
    await db.query(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,html,checksum,snapshot,asset_ids,model,usage)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [version.id, rid, number, version.summary, version.html, version.checksum,
      JSON.stringify(snapshot), version.asset_ids, version.model, version.usage === null ? null : JSON.stringify(version.usage)]);
    await insertWebsiteSource(db, version, source, { origin: 'generation', jobId: jid,
      restaurantRevision: restaurant.revision, menuRevision: snapshot.menu?.revision ?? null });
    await db.query("UPDATE website_jobs SET status='succeeded',result_version_id=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [jid, version.id]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    return version;
  });
}

export async function seedWebsiteQuotaFixture(owner: Pool, uid: string): Promise<void> {
  await transaction(owner, async db => {
    const accountId = id('bla'), periodId = id('aqp');
    await db.query('INSERT INTO billing_accounts(id,owner_user_id) VALUES($1,$2)', [accountId, uid]);
    await db.query(`INSERT INTO ai_quota_periods(id,billing_account_id,kind,starts_at,ends_at,grant_key)
      VALUES($1,$2,'paid',clock_timestamp(),clock_timestamp()+interval '30 days',$3)`, [periodId, accountId, id('grant')]);
    await db.query(`SELECT apply_ai_quota_entry($1,$2,NULL,'grant',$3,12345::bigint,0::bigint,0::bigint,'FIXTURE_GRANT',$4)`,
      [periodId, accountId, id('grant'), uid]);
  });
}

export async function websiteBillingFixtureState(db: Database, uid: string) {
  return {
    accounts: (await db.query('SELECT * FROM billing_accounts WHERE owner_user_id=$1 ORDER BY id', [uid])).rows,
    periods: (await db.query(`SELECT p.* FROM ai_quota_periods p JOIN billing_accounts b ON b.id=p.billing_account_id
      WHERE b.owner_user_id=$1 ORDER BY p.id`, [uid])).rows,
    ledger: (await db.query(`SELECT l.* FROM ai_quota_ledger l JOIN billing_accounts b ON b.id=l.billing_account_id
      WHERE b.owner_user_id=$1 ORDER BY l.id`, [uid])).rows,
  };
}

// 只在 owner 的最终回滚事务中用于迁移重演，显式拆除依赖，不用 SQL CASCADE。
export async function remove012ForMigrationReplay(db: PoolClient): Promise<void> {
  await db.query('SAVEPOINT remove012_replay');
  await db.query('DROP TRIGGER website_version_source_required ON website_versions');
  await db.query('DROP TABLE website_content_actions,website_version_sources');
  await db.query('DROP FUNCTION require_website_version_source(),guard_website_source_insert()');
  await db.query('ALTER TABLE website_jobs DROP CONSTRAINT website_jobs_source_identity');
  await db.query("DELETE FROM schema_migrations WHERE version='012_website_content'");
  await db.query('RELEASE SAVEPOINT remove012_replay');
}
