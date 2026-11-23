import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction, type Database } from './db.js';
import { ApiError, invalid } from './errors.js';
import { lockAuthenticated, requireSession, requireWrite, type Session } from './security.js';
import { input } from './validation.js';
import { normalizeMenuData } from './menu-data.js';
import { readMenuDraft } from './menu-access.js';
import { applyReviewedMenu } from './menu-content.js';
import { applyRestaurantContent, editableRestaurant, normalizeOpeningHours, readRestaurantContent,
  requireContentIdle, type RestaurantContentRow } from './restaurant-content.js';
import { publicationView, readyWebsiteVersion, requireWebsiteRestaurant, websiteSettings, websiteSnapshot,
  type WebsiteVersion } from './website-access.js';
import { renderWebsite, WebsiteValidationError, type WebsiteSnapshot } from './website-html.js';
import { insertWebsiteSource, readWebsiteSource, websiteContentDifferences, websiteContentHash,
  websiteSourceStatus } from './website-source.js';
import type { WebsiteContentPreviewInput, WebsiteContentPreviewResult, WebsiteContentVersion,
  WebsiteEditableContent, WebsiteWorkbenchReport, WebsiteStoredSource } from './website-content-types.js';

const base = '/api/v1/restaurants/:restaurantId/website';
const contractPath = new URL('../contracts/website-content.openapi.json', import.meta.url);
const contentContract = JSON.parse(readFileSync(existsSync(contractPath) ? contractPath :
  new URL('../../contracts/website-content.openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false });
const addFormats = createRequire(import.meta.url)('ajv-formats') as typeof import('ajv-formats').default;
addFormats(ajv);
ajv.addKeyword({ keyword: 'components', valid: true });
ajv.addSchema({ $id: 'website-content', components: contentContract.components });
const validateInput = ajv.compile({ $ref: 'website-content#/components/schemas/WebsiteContentPreviewInput' });
const validateResult = ajv.compile({ $ref: 'website-content#/components/schemas/WebsiteContentPreviewResult' });
function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
}
function restaurantId(request: FastifyRequest): string {
  const rid = (request.params as { restaurantId: string }).restaurantId;
  if (typeof rid !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(rid)) throw new ApiError(400);
  return rid;
}
function previewInput(value: unknown): WebsiteContentPreviewInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body', 'OBJECT_REQUIRED');
  const body = value as Record<string, unknown>;
  if (Object.hasOwn(body, 'menu_data') && body.menu_review_confirmed !== true) throw new ApiError(422, 'MENU_CONFIRMATION_REQUIRED');
  if (Object.hasOwn(body, 'menu_review_confirmed') && !Object.hasOwn(body, 'menu_data')) invalid('menu_review_confirmed', 'MENU_DATA_REQUIRED');
  if (!validateInput(body)) throw new ApiError(422, undefined, (validateInput.errors ?? []).slice(0, 50)
    .map(e => ({ field: (e.instancePath || '$').slice(0, 128), code: e.keyword })));
  const normalized = { ...body } as unknown as WebsiteContentPreviewInput;
  if (Object.hasOwn(body, 'restaurant_patch')) normalized.restaurant_patch = input('RestaurantPatchInput', body.restaurant_patch);
  if (Object.hasOwn(body, 'opening_hours')) normalized.opening_hours = normalizeOpeningHours(body.opening_hours);
  if (Object.hasOwn(body, 'menu_data')) normalized.menu_data = normalizeMenuData(body.menu_data);
  return normalized;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, stable(child)]));
  return value;
}
function fingerprint(body: WebsiteContentPreviewInput): string {
  return createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
}
async function locked<T>(pool: Pool, config: Config, session: Session, rid: string,
  run: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await lockAuthenticated(db, config, session);
    const restaurant = (await db.query('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE', [rid])).rows[0];
    const member = (await db.query(`SELECT id FROM restaurant_members WHERE restaurant_id=$1 AND user_id=$2
      AND role='owner' AND status='active' FOR UPDATE`, [rid, session.user.id])).rows[0];
    if (!restaurant || !member) throw new ApiError(404);
    return run(db);
  });
}
async function readVersion(db: Database, rid: string, vid: string): Promise<WebsiteVersion> {
  const version = (await db.query<WebsiteVersion>('SELECT * FROM website_versions WHERE restaurant_id=$1 AND id=$2', [rid, vid])).rows[0];
  if (!version) throw new ApiError(404);
  return version;
}
async function contentVersion(db: Database, version: WebsiteVersion): Promise<WebsiteContentVersion> {
  const source = await readWebsiteSource(db, version.restaurant_id, version.id);
  return { id: version.id, restaurant_id: version.restaurant_id, version_number: version.version_number,
    summary: version.summary, created_at: version.created_at.toISOString(), checksum: version.checksum, asset_ids: version.asset_ids,
    source_status: await websiteSourceStatus(db, version), origin: source?.origin ?? 'legacy',
    base_version_id: source?.base_version_id ?? null, public_content_hash: source?.public_content_hash ?? null };
}
async function editableContent(db: Database, row: RestaurantContentRow): Promise<WebsiteEditableContent> {
  const menu = await readMenuDraft(db, row.id);
  return { restaurant: editableRestaurant(row), restaurant_revision: row.revision, opening_hours: row.intervals,
    menu: { revision: menu?.revision ?? 0, status: menu?.status ?? 'empty', data: menu?.data ?? { categories: [], warnings: [] } } };
}
function unconfirmedMenu(content: WebsiteEditableContent, version: WebsiteVersion | null, snapshot: WebsiteSnapshot): boolean {
  return content.menu.status === 'draft' || Boolean(version?.snapshot.menu && !snapshot.menu);
}
async function matchingCandidate(db: PoolClient, rid: string, version: WebsiteVersion, source: WebsiteStoredSource,
  snapshot: WebsiteSnapshot, hash: string): Promise<WebsiteVersion | null> {
  const candidates = (await db.query<WebsiteVersion>(`SELECT v.* FROM website_versions v JOIN website_version_sources s
    ON s.restaurant_id=v.restaurant_id AND s.version_id=v.id WHERE v.restaurant_id=$1 AND s.origin='content_refresh'
    AND s.base_version_id=$2 AND s.source_checksum=$3 AND s.renderer_version=$4 AND s.source_schema_version=$5
    AND s.public_content_hash=$6 AND v.asset_ids=$7::text[] AND v.snapshot->'assets'=$8::jsonb
    ORDER BY v.version_number DESC`, [rid, version.id, source.source_checksum, source.renderer_version,
    source.source_schema_version, hash, snapshot.assets.map(a => a.id), JSON.stringify(snapshot.assets)])).rows;
  // 渲染 HTML 含菜单修订标记；候选复用以公开事实为准，再用候选自身快照核验编译 checksum。
  for (const candidate of candidates) if (await websiteSourceStatus(db, candidate) === 'available') return candidate;
  return null;
}
export function registerWebsiteContent(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get(`${base}/workbench`, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), rid = restaurantId(request);
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== 'base_version_id') || (query.base_version_id !== undefined &&
        (typeof query.base_version_id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(query.base_version_id)))) throw new ApiError(400);
    return locked(pool, config, session, rid, async db => {
      const row = await readRestaurantContent(db, rid), content = await editableContent(db, row);
      const pub = (await db.query('SELECT revision,published_version_id,slug FROM website_publications WHERE restaurant_id=$1', [rid])).rows[0];
      const latest = (await db.query<WebsiteVersion>('SELECT * FROM website_versions WHERE restaurant_id=$1 ORDER BY version_number DESC LIMIT 1', [rid])).rows[0] ?? null;
      const published = pub?.published_version_id ? await readVersion(db, rid, pub.published_version_id) : null;
      const editing = query.base_version_id ? await readVersion(db, rid, query.base_version_id as string) : published ?? latest;
      const snapshot = await websiteSnapshot(db, row, editing?.asset_ids ?? []);
      const editingView = editing ? await contentVersion(db, editing) : null, blockers: string[] = [];
      if (!editing) blockers.push('WEBSITE_BASE_REQUIRED');
      else if (editingView?.source_status === 'missing') blockers.push('WEBSITE_SOURCE_MISSING');
      else if (editingView?.source_status === 'incompatible') blockers.push('WEBSITE_SOURCE_INCOMPATIBLE');
      if (unconfirmedMenu(content, editing, snapshot)) blockers.push('MENU_UNCONFIRMED');
      if (!['draft', 'active'].includes(row.status)) blockers.push('RESTAURANT_UNAVAILABLE');
      for (const [table, code] of [['website_jobs', 'WEBSITE_JOB_BUSY'], ['menu_jobs', 'MENU_JOB_BUSY']] as const) {
        if ((await db.query(`SELECT id FROM ${table} WHERE restaurant_id=$1 AND status IN ('queued','running') LIMIT 1`, [rid])).rowCount) blockers.push(code);
      }
      return { restaurant_id: rid, generated_at: new Date().toISOString(), publication: publicationView(config, pub),
        published_version: published ? await contentVersion(db, published) : null, editing_version: editingView,
        latest_version: latest ? await contentVersion(db, latest) : null, content,
        current_public_content_hash: websiteContentHash(snapshot), differences: editing ? websiteContentDifferences(editing.snapshot, snapshot) : [],
        saved_differences: editing && editingView?.origin === 'content_refresh' && editingView.base_version_id
          ? websiteContentDifferences((await readVersion(db, rid, editingView.base_version_id)).snapshot, editing.snapshot) : [],
        blockers, model_configured: Boolean(websiteSettings(config)?.apiKey?.trim()), ai_usage_mode: 'observation' } satisfies WebsiteWorkbenchReport;
    });
  });
  app.post(`${base}/content-previews`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    if (Object.keys(request.query as object).length) throw new ApiError(400);
    const body = previewInput(request.body), key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400);
    const digest = fingerprint(body);
    const output = await locked(pool, config, session, rid, async db => {
      const previous = (await db.query<{ request_fingerprint: string; result: unknown; base_version_id: string;
        result_version_id: string; base_publication_revision: number }>(`SELECT request_fingerprint,result,base_version_id,
        result_version_id,base_publication_revision FROM website_content_actions
        WHERE restaurant_id=$1 AND requesting_user_id=$2 AND idempotency_key=$3`, [rid, session.user.id, key])).rows[0];
      if (previous) {
        if (previous.request_fingerprint !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        if (!validateResult(previous.result)) throw new ApiError(503, 'WEBSITE_CONTENT_RESULT_INVALID');
        const result = previous.result as WebsiteContentPreviewResult;
        if (previous.base_version_id !== body.base_version_id || result.version.restaurant_id !== rid ||
            result.version.id !== previous.result_version_id || result.base_publication_revision !== previous.base_publication_revision) {
          throw new ApiError(503, 'WEBSITE_CONTENT_RESULT_INVALID');
        }
        return { result, replay: true };
      }
      const row = await readRestaurantContent(db, rid);
      requireWebsiteRestaurant(row);
      await requireContentIdle(db, rid);
      const version = await readVersion(db, rid, body.base_version_id), status = await websiteSourceStatus(db, version);
      if (status !== 'available') throw new ApiError(409, status === 'missing' ? 'WEBSITE_SOURCE_MISSING' : 'WEBSITE_SOURCE_INCOMPATIBLE');
      const source = (await readWebsiteSource(db, rid, version.id))!;
      await readyWebsiteVersion(db, rid, version.id);
      const before = await websiteSnapshot(db, row, version.asset_ids, true), current = await editableContent(db, row);
      // 锁住现有发布行；不存在时在餐厅锁内视为 revision=0，不初始化 agent 或发布指针。
      const pub = (await db.query('SELECT revision FROM website_publications WHERE restaurant_id=$1 FOR UPDATE', [rid])).rows[0];
      const publicationRevision: number = pub?.revision ?? 0;
      if (row.revision !== body.expected_restaurant_revision) throw new ApiError(412, 'RESTAURANT_REVISION_CONFLICT');
      if (current.menu.revision !== body.expected_menu_revision) throw new ApiError(409, 'MENU_REVISION_CONFLICT');
      if (publicationRevision !== body.expected_publication_revision) throw new ApiError(409, 'PUBLICATION_REVISION_CONFLICT');
      if (websiteContentHash(before) !== body.expected_public_content_hash) throw new ApiError(409, 'PUBLIC_CONTENT_HASH_CONFLICT');
      if (body.menu_data === undefined && unconfirmedMenu(current, version, before)) throw new ApiError(422, 'MENU_CONFIRMATION_REQUIRED');
      const saved = await applyRestaurantContent(db, rid, row, { patch: body.restaurant_patch, intervals: body.opening_hours }, request.id, session.user.id);
      if (body.menu_data !== undefined) await applyReviewedMenu(db, rid, body.menu_data, body.expected_menu_revision,
        { actorId: session.user.id, requestId: request.id });
      const snapshot = await websiteSnapshot(db, saved, version.asset_ids, true), content = await editableContent(db, saved);
      // 不允许借内容更新修改、丢弃或替换基版素材清单。
      if (JSON.stringify(stable(snapshot.assets)) !== JSON.stringify(stable(version.snapshot.assets))) throw new ApiError(409, 'WEBSITE_SOURCE_INCOMPATIBLE');
      const hash = websiteContentHash(snapshot), differences = websiteContentDifferences(version.snapshot, snapshot);
      const changed = hash !== source.public_content_hash;
      let resultVersion = version;
      if (changed) {
        const summary = `Updated ${differences.map(d => d.field === 'hours' ? 'opening hours' : d.field).join(', ') || 'website content'}`;
        const raw = { html_body: source.html_body, css: source.css, summary };
        let rendered: ReturnType<typeof renderWebsite>;
        try { rendered = renderWebsite(raw, snapshot); }
        catch (error) {
          if (error instanceof WebsiteValidationError) throw new ApiError(422, 'WEBSITE_CONTENT_INVALID');
          throw error;
        }
        const candidate = await matchingCandidate(db, rid, version, source, snapshot, hash);
        if (candidate) resultVersion = candidate;
        else {
          const max = (await db.query<{ n: number }>('SELECT COALESCE(max(version_number),0)::int AS n FROM website_versions WHERE restaurant_id=$1', [rid])).rows[0]!.n;
          if (!Number.isSafeInteger(max) || max >= 2147483647) throw new ApiError(409, 'WEBSITE_VERSION_LIMIT');
          resultVersion = (await db.query<WebsiteVersion>(`INSERT INTO website_versions(id,restaurant_id,version_number,summary,
            html,checksum,snapshot,asset_ids,model,usage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [id('wsv'), rid, max + 1, summary, rendered.html, rendered.checksum, JSON.stringify(snapshot), snapshot.assets.map(a => a.id), null, null])).rows[0]!;
          await insertWebsiteSource(db, resultVersion, raw, { origin: 'content_refresh', baseVersionId: version.id,
            restaurantRevision: saved.revision, menuRevision: content.menu.revision });
        }
      }
      const warnings = differences.some(d => d.field === 'menu') && snapshot.assets.some(a => a.kind === 'menu_source') ? ['MENU_FILE_MAY_BE_OUTDATED'] : [];
      const resultView = await contentVersion(db, resultVersion);
      if (resultView.source_status !== 'available') throw new ApiError(409, 'WEBSITE_SOURCE_INCOMPATIBLE');
      const result: WebsiteContentPreviewResult = { version: resultView, content,
        public_content_hash: hash, base_publication_revision: publicationRevision, differences, changed, ai_called: false, warnings };
      if (!validateResult(result)) throw new ApiError(503, 'WEBSITE_CONTENT_RESULT_INVALID');
      await db.query(`INSERT INTO website_content_actions(id,restaurant_id,requesting_user_id,idempotency_key,
        request_fingerprint,base_version_id,result_version_id,base_publication_revision,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id('wca'), rid, session.user.id, key, digest, version.id, resultVersion.id, publicationRevision, JSON.stringify(result)]);
      await db.query(`INSERT INTO audit_logs(id,restaurant_id,actor_type,actor_user_id,action,entity_type,entity_id,request_id,outcome,changed_fields)
        VALUES($1,$2,'merchant',$3,'website_content_refreshed','website',$4,$5,'success',$6)`,
      [id('aud'), rid, session.user.id, resultVersion.id, request.id, differences.map(d => d.field)]);
      return { result, replay: false };
    });
    return reply.header('Idempotency-Replayed', String(output.replay)).send(output.result);
  });
}
