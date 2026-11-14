import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { createAssetStore } from './asset-storage.js';
import { readPublicWebsite } from './website-access.js';
import { WEBSITE_CSP, WEBSITE_SANDBOX } from './website-html.js';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { ApiError } from './errors.js';
import { id } from './db.js';
import {
  cancelGuestReservation, createReservation, readPublicSite, readReservationByToken,
  type PublicSite, type ReservationRecord,
} from './reservation-access.js';

export function rewritePublicAssetReferences(html: string, urls: ReadonlyMap<string, string>): string {
  const doc = parse(html);
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) for (const attr of node.attrs) {
      if (!['src', 'href'].includes(attr.name)) continue;
      const placeholder = /^__SITE_ASSET_(ast_[A-Za-z0-9_-]{24})__$/.exec(attr.value);
      if (!placeholder) continue;
      const url = urls.get(placeholder[1]!);
      if (!url || !/^\/s\/[a-z0-9-]{3,50}\/media\/ast_[A-Za-z0-9_-]{24}\?version=wsv_[A-Za-z0-9_-]{24}$/.test(url)) throw new ApiError(503, 'WEBSITE_MANIFEST_INVALID');
      attr.value = url;
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(doc);
  return serialize(doc);
}

const RESERVATION_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; script-src 'none'";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#242820;font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif}main{max-width:560px;margin:0 auto;padding:44px 20px 72px}a{color:inherit}.back{font-size:13px;color:#6b7268;text-decoration:none}h1{font-size:24px;font-weight:500;margin:18px 0 8px}p{margin:0 0 14px}.notice{color:#5f6659;font-size:14px}form{display:grid;gap:14px;margin-top:24px}label{display:grid;gap:6px;font-size:13px}input,textarea,button{font:inherit}input,textarea{padding:10px 12px;border:1px solid #cfd4c9;border-radius:2px;background:#fff;color:inherit;width:100%}textarea{min-height:84px;resize:vertical}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:520px){.row{grid-template-columns:1fr}}.check{display:flex;gap:10px;align-items:flex-start;font-size:13px}.check input{width:auto;margin-top:4px}button{margin-top:6px;padding:13px 18px;border:1px solid #242820;background:#242820;color:#fff;border-radius:2px;cursor:pointer}.error{border-left:2px solid #b4472f;padding-left:12px;color:#8c3624;font-size:14px}.fine{color:#7a8176;font-size:12px;margin-top:18px}dl{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;margin:22px 0}dt{color:#7a8176;font-size:13px}dd{margin:0}.status{display:inline-block;padding:4px 10px;border:1px solid #cfd4c9;border-radius:2px;font-size:12px}</style></head><body><main>${body}</main></body></html>`;
}
function statusLabel(status: ReservationRecord['status']): string {
  return ({ pending: 'Awaiting restaurant confirmation', confirmed: 'Confirmed', declined: 'Not accepted', cancelled: 'Cancelled' })[status];
}
function sameOrigin(request: { headers: Record<string, unknown>; }, config: Config): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  const host = request.headers.host;
  try { if (typeof origin === 'string' && (new URL(origin).host === host || origin === config.website?.publicOrigin)) return; } catch { /* 拒绝无效Origin。 */ }
  throw new ApiError(403);
}
function formError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The request could not be completed. Please try again.';
  const messages: Record<string, string> = {
    RESERVATION_NOT_CONFIGURED: 'Online reservations are currently unavailable at this restaurant.',
    RESERVATION_CLOSED: 'The restaurant is not accepting requests at that date and time.',
    RESERVATION_TIME_INVALID: 'That local time is invalid. Please choose another time.',
    RESERVATION_TIME_AMBIGUOUS: 'That local time occurs twice because of daylight saving. Please choose another time.',
    RESERVATION_TIME_OUT_OF_RANGE: 'Please choose a time within the next 90 days.',
    PRIVACY_NOTICE_STALE: 'The privacy notice changed. Please reload this page and try again.',
    IDEMPOTENCY_CONFLICT: 'This form changed after it was opened. Reload and submit again.',
    RESERVATION_REVISION_CONFLICT: 'The reservation changed. Reload the page to see its current status.',
    RESERVATION_FINAL: 'This reservation can no longer be cancelled.',
  };
  return messages[error.code] ?? 'The request could not be completed. Please try again.';
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function parseForm(body: Record<string, unknown>, site: PublicSite) {
  const guestName = text(body.guest_name, 100);
  const email = text(body.guest_email, 254).toLowerCase();
  const phone = text(body.guest_phone, 32);
  const localDate = text(body.local_date, 10);
  const localTime = text(body.local_time, 5);
  const party = Number(text(body.party_size, 2));
  const note = text(body.note, 1000);
  const idempotencyKey = text(body.idempotency_key, 128);
  if (!guestName) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  if ((!email && !phone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || (phone && !/^[+0-9() .-]{6,32}$/.test(phone))) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !== localDate) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  if (!Number.isSafeInteger(party) || party < 1 || party > 20) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  if (body.privacy_consent !== 'true') throw new ApiError(422, 'RESERVATION_CONSENT_REQUIRED');
  if (body.privacy_notice_version !== site.privacy_notice_version) throw new ApiError(422, 'PRIVACY_NOTICE_STALE');
  if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(idempotencyKey)) throw new ApiError(422, 'RESERVATION_FORM_INVALID');
  return { input: { guest_name: guestName, guest_email: email || null, guest_phone: phone || null, party_size: party,
    local_date: localDate, local_time: localTime, note: note || null,
    privacy_notice_version: site.privacy_notice_version!, privacy_consent: true as const, utc_offset_minutes: null },
    idempotencyKey };
}
function formPage(site: PublicSite, slug: string, values: Record<string, string>, error?: string): string {
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone ?? 'UTC' }).format(new Date(Date.now() + 86400000));
  const value = (name: string, fallback = '') => escapeHtml(values[name] ?? fallback);
  const notice = site.notice ? escapeHtml(site.notice) : 'Requests are not confirmed automatically. The restaurant will confirm or decline, and submitting does not guarantee a table.';
  return page('Reserve a table', `<a class="back" href="/s/${escapeHtml(slug)}">← ${escapeHtml(site.restaurant_name)}</a><h1>Reserve a table</h1><p class="notice">${notice}</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<form method="post" action="/s/${escapeHtml(slug)}/reserve"><input type="hidden" name="privacy_notice_version" value="${escapeHtml(site.privacy_notice_version ?? '')}"><input type="hidden" name="idempotency_key" value="${escapeHtml(values.idempotency_key ?? id('form'))}"><label>Name<input name="guest_name" maxlength="100" autocomplete="name" required value="${value('guest_name')}"></label><div class="row"><label>Email<input type="email" name="guest_email" maxlength="254" autocomplete="email" value="${value('guest_email')}"></label><label>Phone<input type="tel" name="guest_phone" maxlength="32" autocomplete="tel" value="${value('guest_phone')}"></label></div><p class="fine">Email or phone is required.</p><div class="row"><label>Date<input type="date" name="local_date" required value="${value('local_date', tomorrow)}"></label><label>Time<input type="time" name="local_time" required value="${value('local_time', '18:00')}"></label></div><div class="row"><label>Party size<input type="number" name="party_size" min="1" max="20" required value="${value('party_size', '2')}"></label><label>Notes<textarea name="note" maxlength="1000">${value('note')}</textarea></label></div><label class="check"><input type="checkbox" name="privacy_consent" value="true" required><span>I understand this is a request and the restaurant must confirm. I agree to the privacy notice.</span></label><button type="submit">Send request</button></form><p class="fine">Your contact details are used only to handle this reservation request.</p>`);
}
function managePage(token: string, row: ReservationRecord, restaurant: string, error?: string): string {
  const cancellable = row.status === 'pending' || row.status === 'confirmed';
  return page(`Reservation ${row.public_reference}`, `<a class="back" href="/">Restaurant</a><h1>Reservation ${escapeHtml(row.public_reference)}</h1><p><span class="status">${escapeHtml(statusLabel(row.status))}</span></p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<dl><dt>Restaurant</dt><dd>${escapeHtml(restaurant)}</dd><dt>Date</dt><dd>${escapeHtml(row.local_date)}</dd><dt>Time</dt><dd>${escapeHtml(row.local_time)} (${escapeHtml(row.timezone_snapshot)})</dd><dt>Party</dt><dd>${row.party_size}</dd></dl>${row.decision_reason ? `<p class="notice">${escapeHtml(row.decision_reason)}</p>` : ''}${cancellable ? `<form method="post" action="/r/${escapeHtml(token)}/cancel"><input type="hidden" name="expected_revision" value="${row.revision}"><button type="submit">Cancel reservation</button></form>` : ''}<p class="fine">Keep this page link. A request is not a confirmed table until the restaurant accepts it.</p>`);
}
function successPage(row: ReservationRecord, token: string | null): string {
  return page('Request received', `<h1>Request received</h1><p>Reference <strong>${escapeHtml(row.public_reference)}</strong></p><p><span class="status">${escapeHtml(statusLabel(row.status))}</span></p><p class="notice">The restaurant will confirm or decline. Submitting a request does not guarantee a table.</p>${token ? `<p><a href="/r/${escapeHtml(token)}">View or cancel this request</a></p><p class="fine">Save this link. It is the only way to view this request.</p>` : '<p class="fine">You already submitted this request. Use the link from the first confirmation.</p>'}`);
}

export function createSiteApp({ pool, config }: { pool: Pool; config: Config }) {
  if (config.nodeEnv === 'production' || !config.website || !['localhost', '127.0.0.1'].includes(new URL(config.website.publicOrigin).hostname)) throw new Error('本地站点服务不是公网部署，不允许生产模式');
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 16384, requestTimeout: 15000 });
  const store = createAssetStore(config);
  const hostnames = new Set(['localhost', '127.0.0.1']);
  app.register(rateLimit, { max: 90, timeWindow: '1 minute' });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16384 }, (_request, body, done) => {
    const result: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(String(body))) if (!Object.hasOwn(result, key)) result[key] = value;
    done(null, result);
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const reservationPage = path.endsWith('/reserve') || /^\/r\/[A-Za-z0-9_-]{43}(?:\/cancel)?$/.test(path);
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow')
      .header('Content-Security-Policy', reservationPage ? RESERVATION_CSP : `${WEBSITE_CSP}; ${WEBSITE_SANDBOX}`);
    const host = request.headers.host ?? request.headers[':authority'];
    let hostname = '';
    try { hostname = new URL(`http://${host}`).hostname; } catch { /* 无效主机拒绝。 */ }
    if (!hostnames.has(hostname)) return reply.code(403).type('text/plain').send('Invalid local host');
    const writable = request.method === 'POST' && (path.endsWith('/reserve') || /^\/r\/[A-Za-z0-9_-]{43}\/cancel$/.test(path));
    if (!['GET', 'HEAD'].includes(request.method) && !writable) return reply.code(405).header('Allow', 'GET, HEAD').send('Read-only website service');
  });
  app.addHook('onClose', async () => store.close());
  app.setErrorHandler((_, __, reply) => reply.code(503).type('text/plain').send('Website temporarily unavailable'));
  app.setNotFoundHandler((_, reply) => reply.code(404).type('text/plain').send('Website not found'));
  app.get('/health/ready', async () => { await pool.query('SELECT 1'); return { status: 'ready', mode: 'local', production_acceptance_complete: false }; });
  app.get('/s/:slug', async (request, reply) => {
    if (Object.keys(request.query as object).length) return reply.code(404).send('Website not found');
    const { slug } = request.params as { slug: string };
    const site = await readPublicWebsite(pool, slug);
    if (!site) return reply.code(404).send('Website not found');
    const urls = new Map(site.assets.map(asset => [asset.id, `/s/${site.slug}/media/${asset.id}?version=${site.version_id}`]));
    const html = rewritePublicAssetReferences(site.html, urls).replaceAll('__SITE_RESERVE__', `/s/${site.slug}/reserve`);
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/s/:slug/reserve', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!SLUG.test(slug)) return reply.code(404).send('Website not found');
    const site = await readPublicSite(pool, slug);
    if (!site || !site.enabled) return reply.code(404).send('Website not found');
    return reply.type('text/html; charset=utf-8').send(formPage(site, slug, {}));
  });
  app.post('/s/:slug/reserve', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!SLUG.test(slug)) return reply.code(404).send('Website not found');
    sameOrigin(request, config);
    const site = await readPublicSite(pool, slug);
    if (!site || !site.enabled) return reply.code(404).send('Website not found');
    const values = (request.body ?? {}) as Record<string, string>;
    try {
      const { input, idempotencyKey } = parseForm(values, site);
      const result = await createReservation(pool, config, site, input, idempotencyKey, request.id);
      return reply.type('text/html; charset=utf-8').code(result.replay ? 200 : 201).send(successPage(result.reservation, result.token));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return reply.type('text/html; charset=utf-8').code(error.status).send(formPage(site, slug, values, formError(error)));
    }
  });
  app.get('/r/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!TOKEN.test(token)) return reply.code(404).send('Reservation not found');
    try {
      const row = await readReservationByToken(pool, config, token);
      const restaurant = (await pool.query<{ name: string }>('SELECT name FROM restaurants WHERE id=$1', [row.restaurant_id])).rows[0];
      return reply.type('text/html; charset=utf-8').send(managePage(token, row, restaurant?.name ?? 'Restaurant'));
    } catch (error) {
      if (error instanceof ApiError) return reply.code(error.status).type('text/plain').send('Reservation not found or link expired');
      throw error;
    }
  });
  app.post('/r/:token/cancel', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!TOKEN.test(token)) return reply.code(404).send('Reservation not found');
    sameOrigin(request, config);
    const values = (request.body ?? {}) as Record<string, string>;
    const expected = Number(values.expected_revision);
    if (!Number.isSafeInteger(expected) || expected < 1) return reply.code(422).type('text/plain').send('Invalid revision');
    try {
      await cancelGuestReservation(pool, config, token, expected, request.id, null);
      return reply.code(303).header('Location', `/r/${token}`).send();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const row = await readReservationByToken(pool, config, token).catch(() => null);
      if (!row) return reply.code(404).type('text/plain').send('Reservation not found');
      const restaurant = (await pool.query<{ name: string }>('SELECT name FROM restaurants WHERE id=$1', [row.restaurant_id])).rows[0];
      return reply.code(error.status).type('text/html; charset=utf-8').send(managePage(token, row, restaurant?.name ?? 'Restaurant', formError(error)));
    }
  });
  app.get('/s/:slug/media/:assetId', async (request, reply) => {
    const { slug, assetId } = request.params as { slug: string; assetId: string };
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== 'version') || typeof query.version !== 'string' || !/^wsv_[A-Za-z0-9_-]{24}$/.test(query.version) || !/^ast_[A-Za-z0-9_-]{24}$/.test(assetId)) return reply.code(404).send('Media not found');
    const site = await readPublicWebsite(pool, slug);
    const asset = site?.assets.find(item => item.id === assetId);
    if (!site || site.version_id !== query.version || !asset) return reply.code(404).send('Media not found');
    const bytes = await store.read(asset.storage_backend, asset.storage_key, asset.size_bytes, asset.checksum);
    const current = await readPublicWebsite(pool, slug);
    if (!current || current.version_id !== site.version_id || current.revision !== site.revision) return reply.code(404).send('Media not found');
    if (asset.mime_type === 'application/pdf') return reply.type('application/octet-stream').header('Content-Disposition', 'attachment; filename="menu.pdf"').send(bytes);
    return reply.type(asset.mime_type).header('Content-Disposition', 'inline').send(bytes);
  });
  return app;
}
