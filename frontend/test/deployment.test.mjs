import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const backend = read('backend/Dockerfile');
const frontend = read('frontend/Dockerfile');
const caddy = read('frontend/Caddyfile');
const rootIgnore = read('.dockerignore');
const backendIgnore = read('backend/.dockerignore');
const lines = text => text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const stages = text => text.split(/(?=^FROM )/m).filter(stage => stage.trim());
const copies = text => lines(text).filter(line => line.startsWith('COPY '));
const command = text => JSON.parse(lines(text).find(line => line.startsWith('CMD ')).slice(4));

// 仅支持这两份白名单使用的字面路径、* 与 **，同时检查祖先目录是否被排除。
function ignoreRules(text) {
  return lines(text).map(line => {
    const included = line.startsWith('!');
    const path = (included ? line.slice(1) : line).replace(/^\/+|\/+$/g, '');
    const pattern = path.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/|\*\*|\*/g, token => token === '**/' ? '(?:.*/)?' : token === '**' ? '.*' : '[^/]*');
    return { included, pattern: new RegExp(`^${pattern}$`) };
  });
}
function ignored(path, rules) {
  const parts = path.replace(/\/$/, '').split('/');
  return parts.some((_, index) => {
    const ancestor = parts.slice(0, index + 1).join('/');
    let excluded = false;
    for (const rule of rules) if (rule.pattern.test(ancestor)) excluded = !rule.included;
    return excluded;
  });
}
function checkContext(text, included, excluded) {
  assert.equal(lines(text)[0], '**', '构建上下文必须默认拒绝');
  const rules = ignoreRules(text);
  const expected = [
    ...included.map(path => ({ path, ignored: false })),
    ...excluded.map(path => ({ path, ignored: true })),
  ];
  for (const entry of expected) assert.equal(ignored(entry.path, rules), entry.ignored, `忽略规则不符合预期：${entry.path}`);
}

const backendBuildCopies = [
  'COPY package.json package-lock.json ./',
  'COPY tsconfig.json tsconfig.build.json ./',
  'COPY src/ ./src/',
  'COPY scripts/ ./scripts/',
  'COPY contracts/ ./contracts/',
  'COPY migrations/ ./migrations/',
];
const frontendBuildCopies = [
  'COPY frontend/package.json frontend/package-lock.json ./',
  'COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./',
  'COPY frontend/src/ ./src/',
  'COPY frontend/public/ ./public/',
  'COPY backend/src/billing-types.ts backend/src/ai-usage-types.ts /workspace/backend/src/',
];

test('后端固定 Node 镜像，使用后端上下文完成生产编译与依赖裁剪', () => {
  const parts = stages(backend);
  assert.equal(parts.length, 2);
  assert.equal(lines(parts[0])[0], 'FROM node:22.22.2-bookworm-slim AS build');
  assert.equal(lines(parts[1])[0], 'FROM node:22.22.2-bookworm-slim AS runtime');
  assert.ok(lines(parts[0]).includes('WORKDIR /app'));
  assert.deepEqual(copies(parts[0]), backendBuildCopies);
  assert.deepEqual(lines(parts[0]).filter(line => line.startsWith('RUN ')), ['RUN npm ci', 'RUN npm run build && npm prune --omit=dev']);
  assert.ok(parts[0].indexOf(backendBuildCopies[0]) < parts[0].indexOf('RUN npm ci'));
  assert.ok(parts[0].indexOf('RUN npm ci') < parts[0].indexOf('COPY src/'));
  assert.ok(parts[0].indexOf('COPY migrations/') < parts[0].indexOf('RUN npm run build'));
  for (const copy of backendBuildCopies) for (const path of copy.split(/\s+/).slice(1, -1)) {
    assert.ok(existsSync(resolve(root, 'backend', path)), `后端构建输入不存在：${path}`);
  }
});

test('后端运行层仅保留生产产物与资源，以 node 用户直接启动编译后的 API', () => {
  const runtime = stages(backend)[1];
  assert.deepEqual(copies(runtime), [
    'COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./',
    'COPY --from=build --chown=node:node /app/node_modules/ ./node_modules/',
    'COPY --from=build --chown=node:node /app/dist/ ./dist/',
    'COPY --from=build --chown=node:node /app/contracts/ ./contracts/',
    'COPY --from=build --chown=node:node /app/migrations/ ./migrations/',
  ]);
  assert.ok(lines(runtime).includes('WORKDIR /app'));
  assert.deepEqual(lines(runtime).filter(line => line.startsWith('ENV ')), ['ENV NODE_ENV=production HOST=:: PORT=4000']);
  assert.deepEqual(lines(runtime).filter(line => line.startsWith('USER ')), ['USER node']);
  assert.ok(runtime.indexOf('USER node') < runtime.indexOf('CMD '));
  assert.deepEqual(command(runtime), ['node', 'dist/src/index.js']);
  assert.doesNotMatch(runtime, /^RUN |^ENTRYPOINT /m);
});

test('前端使用仓库根上下文，仅引入两份共享类型并在前端工作目录编译', () => {
  const parts = stages(frontend);
  assert.equal(parts.length, 2);
  const build = parts[0];
  assert.equal(lines(build)[0], 'FROM node:22.22.2-bookworm-slim AS build');
  assert.ok(lines(build).includes('WORKDIR /workspace/frontend'));
  assert.deepEqual(copies(build), frontendBuildCopies);
  assert.deepEqual(lines(build).filter(line => line.startsWith('RUN ')), ['RUN npm ci && npm run build']);
  assert.ok(build.indexOf('/workspace/backend/src/') < build.indexOf('RUN npm ci'));
  for (const copy of frontendBuildCopies) for (const path of copy.split(/\s+/).slice(1, -1)) {
    assert.ok(existsSync(resolve(root, path)), `前端构建输入不存在：${path}`);
    assert.equal(ignored(path, ignoreRules(rootIgnore)), false, `前端构建输入被忽略：${path}`);
  }
  assert.match(read('frontend/src/billing-client.ts'), /import type .*from ['"]\.\.\/\.\.\/backend\/src\/billing-types['"]/);
  assert.match(read('frontend/src/usage-client.ts'), /import type .*from ['"]\.\.\/\.\.\/backend\/src\/ai-usage-types['"]/);
});

test('前端运行层固定 Caddy，只复制静态产物与配置且端口可在运行时覆盖', () => {
  const runtime = stages(frontend)[1];
  assert.equal(lines(runtime)[0], 'FROM caddy:2.10.2-alpine AS runtime');
  assert.deepEqual(copies(runtime), [
    'COPY frontend/Caddyfile /etc/caddy/Caddyfile',
    'COPY --from=build /workspace/frontend/dist/ /srv/',
  ]);
  assert.deepEqual(lines(runtime).filter(line => line.startsWith('ENV ')), ['ENV PORT=8080']);
  assert.deepEqual(command(runtime), ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  assert.doesNotMatch(runtime, /^RUN |^ENTRYPOINT /m);
});

test('根上下文白名单仅开放前端构建输入与两份后端类型，拒绝测试及私密文件', () => {
  assert.deepEqual(lines(rootIgnore).filter(line => line.startsWith('!')), [
    '!frontend/', '!frontend/package.json', '!frontend/package-lock.json', '!frontend/index.html',
    '!frontend/tsconfig.json', '!frontend/vite.config.ts', '!frontend/Caddyfile',
    '!frontend/src/', '!frontend/src/**', '!frontend/public/', '!frontend/public/**',
    '!backend/', '!backend/src/', '!backend/src/billing-types.ts', '!backend/src/ai-usage-types.ts',
  ]);
  checkContext(rootIgnore, [
    'frontend/package.json', 'frontend/package-lock.json', 'frontend/index.html', 'frontend/tsconfig.json',
    'frontend/vite.config.ts', 'frontend/Caddyfile', 'frontend/src/nested/example.tsx', 'frontend/public/brand/logo.svg',
    'backend/src/billing-types.ts', 'backend/src/ai-usage-types.ts',
  ], [
    'package.json', '.git/config', '.workbuddy/private.env', '.env', '.env.production', 'railway.toml', 'railway.json',
    'frontend/test/deployment.test.mjs', 'frontend/playwright.config.ts', 'frontend/.env.local',
    'frontend/.workbuddy/private.env', 'frontend/node_modules/react/index.js', 'frontend/dist/index.html',
    'frontend/dist-saved-differences-final-20261119/index.html', 'frontend/demos/example.html', 'frontend/outputs/result.html',
    'frontend/src/test/fixture.ts', 'frontend/src/nested/.env.production', 'frontend/public/.workbuddy/private.env',
    'frontend/public/secrets/config.json', 'frontend/public/private/config.json', 'frontend/public/tls.pem',
    'frontend/public/tls.key', 'frontend/public/tls.crt', 'frontend/public/tls.p12', 'frontend/public/tls.pfx',
    'frontend/public/demos/example.html', 'frontend/src/outputs/result.json', 'frontend/src/dist-saved/result.js',
    'backend/package.json', 'backend/src/index.ts', 'backend/src/db.ts', 'backend/contracts/schema.json',
    'backend/migrations/001.sql', 'backend/scripts/migrate.ts',
  ]);
});

test('后端上下文只开放包锁、编译配置及源码资源，拒绝开发环境和秘密', () => {
  assert.deepEqual(lines(backendIgnore).filter(line => line.startsWith('!')), [
    '!package.json', '!package-lock.json', '!tsconfig.json', '!tsconfig.build.json',
    '!src/', '!src/**', '!scripts/', '!scripts/**', '!contracts/', '!contracts/**', '!migrations/', '!migrations/**',
  ]);
  checkContext(backendIgnore, [
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src/index.ts', 'src/mail-worker.ts',
    'src/nested/module.mjs', 'scripts/migrate.ts', 'contracts/schema.json', 'migrations/001.sql',
  ], [
    '.env.local', '.env.supabase.local', '.workbuddy/private.env', '.git/config', 'test/db.test.ts',
    'node_modules/typescript/index.js', 'dist/src/index.js', 'demos/example.html', 'outputs/result.json',
    'tsconfig.secret.json', 'railway.toml', 'railway.json', 'scripts/.env.local', 'src/.workbuddy/private.env',
    'src/test/fixture.ts', 'src/tests/fixture.ts', 'scripts/demos/example.mjs', 'scripts/outputs/result.json',
    'contracts/private/config.json', 'contracts/secrets/config.json', 'contracts/ca.pem', 'contracts/ca.key',
    'contracts/ca.crt', 'contracts/ca.p12', 'contracts/ca.pfx', 'src/dist-saved/result.js',
  ]);
});

test('Caddy 关闭自动 TLS 与管理接口，健康检查独立返回 200，API 原路径代理', () => {
  assert.match(caddy, /^\{\s*auto_https off\s*admin off\s*\}/);
  assert.match(caddy, /:\{\$PORT:8080\} \{/);
  assert.match(caddy, /root \* \/srv/);
  assert.match(caddy, /handle \/healthz \{\s*respond "ok" 200\s*\}/);
  assert.match(caddy, /handle \/api\/\* \{\s*reverse_proxy \{\$BACKEND_UPSTREAM\}\s*\}/);
  assert.equal((caddy.match(/reverse_proxy/g) ?? []).length, 1);
  assert.ok(caddy.indexOf('handle /healthz') < caddy.indexOf('handle /api/*'));
  assert.ok(caddy.indexOf('handle /api/*') < caddy.indexOf('handle {'));
  assert.doesNotMatch(caddy, /\b(?:handle_path|header_up|header_down|rewrite|uri|redir|tls|debug)\b|Access-Control-/i);
});

test('SPA 回退后设置首页不缓存，仅哈希静态资源使用 immutable 缓存', () => {
  const fallback = caddy.slice(caddy.indexOf('handle {'));
  assert.match(fallback, /handle \{\s*route \{/);
  const rewrite = fallback.indexOf('try_files {path} /index.html');
  const hashHeader = fallback.indexOf('header @hashedAssets Cache-Control "public, max-age=31536000, immutable"');
  const indexHeader = fallback.indexOf('header /index.html Cache-Control "no-cache"');
  const rootHeader = fallback.indexOf('header / Cache-Control "no-cache"');
  assert.ok(rewrite >= 0 && rewrite < hashHeader && hashHeader < indexHeader && indexHeader < rootHeader);
  assert.ok(rootHeader < fallback.indexOf('file_server'));
  assert.equal((caddy.match(/immutable/g) ?? []).length, 1);
  const matcher = fallback.match(/@hashedAssets path_regexp hashedAssets (.+)/);
  assert.ok(matcher);
  const pattern = new RegExp(matcher[1]);
  for (const path of ['/assets/index-Abc_1234.js', '/assets/index-ABcd-123.css']) assert.ok(pattern.test(path), path);
  for (const path of ['/index.html', '/', '/api/v1/health/ready', '/assets/logo.svg', '/assets/index-short.js',
    '/other/index-ABCDEFGH.js', '/assets/nested/index-ABCDEFGH.js']) assert.equal(pattern.test(path), false, path);
});

test('不引入秘密、构建时私网 DNS、启动迁移、TS loader 或旧式部署配置', () => {
  for (const dockerfile of [backend, frontend]) {
    assert.doesNotMatch(dockerfile, /^ARG |^HEALTHCHECK |^ADD /m);
    assert.doesNotMatch(dockerfile, /\.env|\.workbuddy|\.pem|\.key|railway\.internal|BACKEND_UPSTREAM|DATABASE_|SECRET|TOKEN|PASSWORD/i);
    for (const line of lines(dockerfile).filter(line => /^(?:RUN|CMD|ENTRYPOINT) /.test(line))) {
      assert.doesNotMatch(line, /migrat|pre.?deploy|tsx|ts-node|--import|--loader|--env-file|dotenv|tini|apt-get|\bapk\b|\bdev\b(?!$)/i);
    }
  }
  for (const directory of ['', 'backend', 'frontend']) for (const filename of [
    'railway.toml', 'railway.json', 'compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml',
  ]) assert.equal(existsSync(resolve(root, directory, filename)), false, `不应新增旧式或额外部署配置：${directory}/${filename}`);
});
