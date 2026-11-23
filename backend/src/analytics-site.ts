import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { readPublicWebsite, type PublicWebsite } from './website-access.js';
import { digest, equal, SESSION_COOKIE } from './security.js';
import { ApiError } from './errors.js';
import { recordAnalyticsEvent, type AnalyticsContext, type AnalyticsEventType } from './analytics-access.js';

const eventContextLifetime = 15 * 60 * 1000;
const eventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ContextToken = AnalyticsContext & { nonce: string; expires_at: number };
type PendingEvent = { context: AnalyticsContext; event: AnalyticsEventType; at: Date };

export function analyticsRequestEligible(request: Pick<FastifyRequest, 'method' | 'headers'>, config: Config): boolean {
  const h = request.headers;
  if (!['GET', 'POST'].includes(request.method) || h.dnt === '1' || h['sec-gpc'] === '1'
    || h['x-analytics-test'] === '1' || /prefetch|prerender/i.test(String(h.purpose ?? h['sec-purpose'] ?? ''))
    || /(?:^|;\s*)__Host-restaurant_(?:session|authflow)=/.test(String(h.cookie ?? ''))
    || /bot|spider|crawler|headless|curl|wget|python|monitor|preview/i.test(String(h['user-agent'] ?? ''))
    || !h['user-agent']) return false;
  if (h.origin === config.appOrigin) return false;
  if (h.referer) {
    try { if (new URL(String(h.referer)).origin === config.appOrigin) return false; } catch { return false; }
  }
  // This is suppression only, not authentication. A spoofed value can opt out but cannot grant privileges.
  if (String(h.cookie ?? '').includes(`${SESSION_COOKIE}=`)) return false;
  return true;
}

export function siteAnalyticsContext(site: PublicWebsite, config: Config): AnalyticsContext {
  return { restaurant_id: site.restaurant_id, version_id: site.version_id, publication_revision: site.revision,
    slug: site.slug, timezone: site.timezone ?? 'UTC', timezone_fallback: site.timezone === null,
    namespace: config.nodeEnv === 'production' ? 'production' : 'local_test' };
}
export function issueAnalyticsContext(context: AnalyticsContext, config: Config, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...context, nonce: randomUUID(), expires_at: now + eventContextLifetime })).toString('base64url');
  return `${body}.${digest(config, body, 'site_analytics_context')}`;
}
export function verifyAnalyticsContext(token: unknown, slug: string, config: Config, now = Date.now()): ContextToken {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw new ApiError(403, 'ANALYTICS_CONTEXT_INVALID');
  const [body, signature] = token.split('.') as [string, string];
  if (!equal(digest(config, body, 'site_analytics_context'), signature)) throw new ApiError(403, 'ANALYTICS_CONTEXT_INVALID');
  let value: ContextToken;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ContextToken; } catch { throw new ApiError(403, 'ANALYTICS_CONTEXT_INVALID'); }
  if (!value || value.slug !== slug || value.namespace !== (config.nodeEnv === 'production' ? 'production' : 'local_test')
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce.replaceAll('-', '_'))
    || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + eventContextLifetime)
    throw new ApiError(403, 'ANALYTICS_CONTEXT_INVALID');
  return value;
}
export function analyticsDedupeKey(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function installSiteAnalytics(app: FastifyInstance, pool: Pool, config: Config) {
  const pending = new WeakMap<FastifyRequest, PendingEvent>();
  app.addHook('onResponse', async (request, reply) => {
    const event = pending.get(request);
    pending.delete(request);
    if (!event || !analyticsRequestEligible(request, config) || !(reply.statusCode === 200 || reply.statusCode === 303)) return;
    try { await recordAnalyticsEvent(pool, event.context, event.event, analyticsDedupeKey(`server:${request.id}`), event.at); }
    catch { process.stderr.write('站点统计写入失败，页面响应不受影响；该次访问未计入统计\n'); }
  });
  function track(request: FastifyRequest, reply: FastifyReply, site: PublicWebsite, event: AnalyticsEventType) {
    if (!analyticsRequestEligible(request, config)) return;
    const context = siteAnalyticsContext(site, config);
    pending.set(request, { context, event, at: new Date() });
    reply.header('X-Site-Analytics-Context', issueAnalyticsContext(context, config));
  }
  // Browser-navigation based click tracking. No script, no arbitrary redirect target, no personal data in URL.
  app.get('/s/:slug/go/reserve', async (request, reply) => {
    if (Object.keys(request.query as object).length) return reply.code(404).send('Website not found');
    const { slug } = request.params as { slug: string };
    const site = await readPublicWebsite(pool, slug);
    if (!site || !site.reservation_enabled) return reply.code(404).send('Website not found');
    track(request, reply, site, 'reservation_click');
    return reply.code(303).header('Location', `/s/${site.slug}/reserve`).send();
  });
  // A bounded first-party collection API for platform clients, never a model tool or arbitrary event payload.
  app.post('/s/:slug/events', { bodyLimit: 4096, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (Object.keys(request.query as object).length || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
      return reply.code(400).send({ code: 'ANALYTICS_EVENT_INVALID' });
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3
      || !Object.hasOwn(body, 'context') || body.event !== 'reservation_click'
      || typeof body.event_id !== 'string' || !eventIdPattern.test(body.event_id))
      return reply.code(422).send({ code: 'ANALYTICS_EVENT_INVALID' });
    // Only exact same-origin platform clients may submit. Host was checked by the site app onRequest hook.
    if (request.headers.origin !== config.website?.publicOrigin || request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ code: 'ANALYTICS_ORIGIN_INVALID' });
    try {
      const context = verifyAnalyticsContext(body.context, slug, config);
      const site = await readPublicWebsite(pool, slug);
      if (!site || site.version_id !== context.version_id || site.revision !== context.publication_revision
        || site.restaurant_id !== context.restaurant_id || !site.reservation_enabled)
        return reply.code(409).send({ code: 'ANALYTICS_CONTEXT_STALE' });
      if (!analyticsRequestEligible(request, config)) return reply.code(202).send({ recorded: false, reason: 'EXCLUDED_REQUEST' });
      const accepted = await recordAnalyticsEvent(pool, context, 'reservation_click', analyticsDedupeKey(`client:${context.nonce}:${body.event_id.toLowerCase()}`));
      return reply.code(202).send({ recorded: accepted, duplicate_or_stale: !accepted });
    } catch (error) {
      if (error instanceof ApiError) return reply.code(error.status).send({ code: error.code });
      return reply.code(503).send({ code: 'ANALYTICS_UNAVAILABLE' });
    }
  });
  return { track };
}
