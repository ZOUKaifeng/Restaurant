import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { randomUUID } from 'node:crypto';
import { ApiError, errorBody } from './errors.js';
import { registerAuth } from './auth.js';
import { registerRestaurants } from './restaurant.js';
import { registerAssets } from './assets.js';
import { registerWebsites } from './website.js';
import { registerMenus } from './menu.js';

export function createApp({ pool, config }: { pool: Pool; config: Config }) {
  const app = Fastify({
    bodyLimit: 32768, requestTimeout: 30000, connectionTimeout: 60000,
    trustProxy: false, requestIdHeader: false, genReqId: () => randomUUID(),
    logger: config.nodeEnv === 'test' ? false : {
      level: 'info',
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', 'password', 'token', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TOKEN_PEPPER', 'CURSOR_SECRET', 'OUTBOX_ENCRYPTION_KEY', 'SMTP_PASS', 'DEEPSEEK_API_KEY'], censor: '[已脱敏]' },
      serializers: { req: req => ({ method: req.method, id: req.id }), res: res => ({ statusCode: res.statusCode }) },
    },
  });
  app.register(cookie);
  app.register(helmet, { global: true, contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:'] } } });
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.addHook('onRoute', options => {
    if (options.url.startsWith('/api/v1/auth/') && options.method === 'POST') options.config = { ...options.config, rateLimit: { max: 20, timeWindow: '1 minute' } };
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Request-Id', request.id);
    const path = request.url.split('?')[0] ?? '';
    const rawUpload = request.method === 'POST' && /^\/api\/v1\/restaurants\/[A-Za-z0-9_-]{16,64}\/assets$/.test(path);
    const hasBody = ['POST', 'PATCH', 'PUT'].includes(request.method) && !path.endsWith('/auth/logout') && !rawUpload;
    if (hasBody && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415);
  });
  app.addHook('preHandler', async () => { await pool.query('SELECT 1'); });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    let status = 503;
    if (error instanceof ApiError) status = error.status;
    else if (error.statusCode === 429) status = 429;
    else if (error.statusCode === 415) status = 415;
    else if (error.statusCode === 413) status = 413;
    else if (error.statusCode === 400) status = 400;
    if (status === 401) reply.header('WWW-Authenticate', 'Session realm="restaurant-platform"');
    if (status === 429 && !reply.hasHeader('Retry-After')) reply.header('Retry-After', '60');
    if (status === 503) request.log.error({ request_id: request.id }, '后端服务请求失败');
    const body = error instanceof ApiError ? { code: error.code, message: error.message, request_id: request.id, details: error.details } : errorBody(status, request.id);
    reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(404, request.id)));
  app.get('/api/v1/health/ready', async () => ({
    status: 'ready', database: 'postgresql', email_mode: config.emailMode,
    scope: 'merchant-core-assets-websites', storage_mode: config.storageMode,
    website_model: config.website?.model ?? 'deepseek-flash', website_model_configured: Boolean(config.website?.apiKey), menu_recognition_enabled: true,
    production_acceptance_complete: false,
  }));
  app.register(async routes => {
    registerAuth(routes, pool, config);
    registerRestaurants(routes, pool, config);
    registerAssets(routes, pool, config);
    registerWebsites(routes, pool, config);
    registerMenus(routes, pool, config);
  });
  return app;
}
