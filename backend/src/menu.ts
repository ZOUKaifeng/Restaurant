import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from './config.js';
import { id, transaction } from './db.js';
import { ApiError, invalid } from './errors.js';
import { lockAuthenticated, requireSession, requireWrite, type Session } from './security.js';
import { normalizeMenuData } from './menu-data.js';
import { applyMenuDraft, confirmMenu } from './menu-content.js';
import {
  lockMenuDraft, lockMenuRestaurant, lockMenuSources, menuAudit, menuFingerprint,
  menuJobColumns, menuJobView, menuModelConfigured, readMenuDraft, requireMenuAI,
  requireMenuRecognitionQuota, requireMenuRevision, type MenuJobRecord,
  type MenuRecognitionInput, type MenuState,
} from './menu-access.js';

const base = '/api/v1/restaurants/:restaurantId/menu';
function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
}
function restaurantId(request: FastifyRequest): string {
  const rid = (request.params as { restaurantId: string }).restaurantId;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(rid) || Object.keys(request.query as object).length) throw new ApiError(400);
  return rid;
}
function body(request: FastifyRequest, required: string[], optional: string[] = []): Record<string, unknown> {
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(result, key))) invalid('body', 'UNKNOWN_OR_MISSING_FIELDS');
  return result;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483646) invalid('expected_revision');
  return value as number;
}
function idem(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) throw new ApiError(400);
  return key;
}
async function locked<T>(pool: Pool, config: Config, session: Session, rid: string, run: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async db => {
    await lockAuthenticated(db, config, session);
    await lockMenuRestaurant(db, session.user.id, rid);
    return run(db);
  });
}
export function registerMenus(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get(base, async (request, reply) => {
    privateHeaders(reply);
    const session = await requireSession(pool, config, request), rid = restaurantId(request);
    return locked(pool, config, session, rid, async db => {
      const jobs = (await db.query<MenuJobRecord>(`SELECT ${menuJobColumns} FROM menu_jobs WHERE restaurant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`, [rid])).rows;
      return { draft: await readMenuDraft(db, rid), jobs: jobs.map(menuJobView), model: 'deepseek-flash',
        model_configured: menuModelConfigured(config), input_mode: 'vision', pdf_supported: false } satisfies MenuState;
    });
  });
  app.post(`${base}/recognitions`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const value = body(request, ['asset_ids', 'consent_to_ai_processing'], ['expected_revision']);
    if (value.consent_to_ai_processing !== true) invalid('consent_to_ai_processing', 'CONSENT_REQUIRED');
    if (!Array.isArray(value.asset_ids) || value.asset_ids.length < 1 || value.asset_ids.length > 4 ||
      value.asset_ids.some(aid => typeof aid !== 'string' || !/^ast_[A-Za-z0-9_-]{24}$/.test(aid)) || new Set(value.asset_ids).size !== value.asset_ids.length) invalid('asset_ids');
    const input: MenuRecognitionInput = { asset_ids: value.asset_ids as string[], consent_to_ai_processing: true,
      expected_revision: Object.hasOwn(value, 'expected_revision') ? revision(value.expected_revision) : 0 };
    const key = idem(request), fingerprint = menuFingerprint(rid, input);
    const job = await locked(pool, config, session, rid, async db => {
      const previous = (await db.query<MenuJobRecord & { request_fingerprint: string }>(`SELECT ${menuJobColumns},request_fingerprint
        FROM menu_jobs WHERE requesting_user_id=$1 AND idempotency_key=$2`, [session.user.id, key])).rows[0];
      if (previous) {
        if (previous.request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        return previous;
      }
      requireMenuAI(config);
      const current = await lockMenuDraft(db, rid);
      requireMenuRevision(current, input.expected_revision);
      await requireMenuRecognitionQuota(db, session.user.id, rid);
      const sources = await lockMenuSources(db, rid, input.asset_ids), jid = id('mnj');
      const inserted = (await db.query<MenuJobRecord>(`INSERT INTO menu_jobs(id,restaurant_id,requesting_user_id,idempotency_key,request_fingerprint,input,sources,expected_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${menuJobColumns}`, [jid, rid, session.user.id, key, fingerprint,
        JSON.stringify(input), JSON.stringify(sources), input.expected_revision])).rows[0]!;
      for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
        await db.query(`INSERT INTO asset_references(id,restaurant_id,asset_id,purpose,resource_id) VALUES($1,$2,$3,'menu_job',$4)`, [id('ref'), rid, source.id, jid]);
      }
      await menuAudit(db, session.user.id, rid, jid, 'menu_recognition_requested', request.id);
      return inserted;
    });
    return reply.code(202).send({ job_id: job.id, status: job.status });
  });
  app.patch(base, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const value = body(request, ['data', 'expected_revision']);
    const expected = revision(value.expected_revision), data = normalizeMenuData(value.data);
    return locked(pool, config, session, rid, db => applyMenuDraft(db, rid, data, expected,
      { actorId: session.user.id, requestId: request.id }));
  });
  app.post(`${base}/confirm`, async (request, reply) => {
    privateHeaders(reply);
    const session = (await requireWrite(pool, config, request))!, rid = restaurantId(request);
    const value = body(request, ['expected_revision', 'confirmed']);
    if (value.confirmed !== true) invalid('confirmed', 'CONFIRMATION_REQUIRED');
    const expected = revision(value.expected_revision);
    return locked(pool, config, session, rid, db => confirmMenu(db, rid, expected,
      { actorId: session.user.id, requestId: request.id }));
  });
}
