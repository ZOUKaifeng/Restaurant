import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { createAssetStore } from './asset-storage.js';
import { readPublicWebsite } from './website-access.js';
import { assetPlaceholder, WEBSITE_CSP, WEBSITE_SANDBOX } from './website-html.js';

export function createSiteApp({ pool, config }: { pool: Pool; config: Config }) {
  if (config.nodeEnv === 'production' || !config.website || !['localhost', '127.0.0.1'].includes(new URL(config.website.publicOrigin).hostname)) throw new Error('本地站点服务不是公网部署，不允许生产模式');
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1024, requestTimeout: 15000 });
  const store = createAssetStore(config);
  const hostnames = new Set(['localhost', '127.0.0.1']);
  app.register(rateLimit, { max: 90, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow').header('Content-Security-Policy', `${WEBSITE_CSP}; ${WEBSITE_SANDBOX}`);
    const host = request.headers.host ?? request.headers[':authority'];
    let hostname = '';
    try { hostname = new URL(`http://${host}`).hostname; } catch { /* 无效主机拒绝。 */ }
    if (!hostnames.has(hostname)) return reply.code(403).type('text/plain').send('Invalid local host');
    if (!['GET', 'HEAD'].includes(request.method)) return reply.code(405).header('Allow', 'GET, HEAD').send('Read-only website service');
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
    let html = site.html;
    for (const asset of site.assets) html = html.replaceAll(assetPlaceholder(asset.id), `/s/${site.slug}/media/${asset.id}?version=${site.version_id}`);
    if (/__SITE_ASSET_/.test(html)) return reply.code(503).send('Invalid website manifest');
    return reply.type('text/html; charset=utf-8').send(html);
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
