import type { PoolClient } from 'pg';
import { ApiError } from './errors.js';
import { normalizeMenuData } from './menu-data.js';
import { lockMenuDraft, menuAudit, menuDraftColumns, menuDraftView, menuItemCount, requireMenuRevision,
  type MenuDraft, type MenuDraftRecord } from './menu-access.js';
import { requireContentIdle } from './restaurant-content.js';

type ActorRequest = { actorId: string; requestId: string };
function reviewedData(value: unknown) {
  const data = normalizeMenuData(value);
  if (menuItemCount(data) < 1) throw new ApiError(422, 'MENU_EMPTY');
  return data;
}
async function currentDraft(db: PoolClient, rid: string, expected: number): Promise<MenuDraftRecord> {
  await requireContentIdle(db, rid);
  const current = await lockMenuDraft(db, rid);
  requireMenuRevision(current, expected);
  return current;
}
// 保留识别来源与永久引用；手工写入不改变 source_asset_ids。
export async function applyMenuDraft(db: PoolClient, rid: string, value: unknown, expected: number, actor: ActorRequest): Promise<MenuDraft> {
  const data = normalizeMenuData(value), current = await currentDraft(db, rid, expected);
  const updated = (await db.query<MenuDraftRecord>(`UPDATE menu_drafts SET data=$2,revision=revision+1,status='draft',
    confirmed_at=NULL,updated_at=clock_timestamp() WHERE restaurant_id=$1 RETURNING ${menuDraftColumns}`, [rid, JSON.stringify(data)])).rows[0]!;
  await menuAudit(db, actor.actorId, rid, current.id, 'menu_updated', actor.requestId);
  return menuDraftView(updated);
}
export async function confirmMenu(db: PoolClient, rid: string, expected: number, actor: ActorRequest): Promise<MenuDraft> {
  const current = await currentDraft(db, rid, expected);
  reviewedData(current.data);
  if (current.status === 'confirmed') return menuDraftView(current);
  const updated = (await db.query<MenuDraftRecord>(`UPDATE menu_drafts SET status='confirmed',revision=revision+1,
    confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE restaurant_id=$1 RETURNING ${menuDraftColumns}`, [rid])).rows[0]!;
  await menuAudit(db, actor.actorId, rid, current.id, 'menu_confirmed', actor.requestId);
  return menuDraftView(updated);
}
export async function applyReviewedMenu(db: PoolClient, rid: string, value: unknown, expected: number, actor: ActorRequest): Promise<MenuDraft> {
  const data = reviewedData(value), current = await currentDraft(db, rid, expected);
  const updated = (await db.query<MenuDraftRecord>(`UPDATE menu_drafts SET data=$2,status='confirmed',revision=revision+1,
    confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE restaurant_id=$1 RETURNING ${menuDraftColumns}`, [rid, JSON.stringify(data)])).rows[0]!;
  await menuAudit(db, actor.actorId, rid, current.id, 'menu_updated', actor.requestId);
  await menuAudit(db, actor.actorId, rid, current.id, 'menu_confirmed', actor.requestId);
  return menuDraftView(updated);
}
