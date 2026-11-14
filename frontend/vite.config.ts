import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const localHostOnly: Plugin = {
  name: 'local-host-only',
  apply: 'serve',
  configureServer(server) {
    // Vite 的 HTTPS 模式跳过 allowedHosts 检查，补充严格 Host 白名单。
    server.middlewares.use((request, response, next) => {
      const authority = request.headers.host ?? request.headers[':authority'];
      if (typeof authority !== 'string' || !/^(?:localhost|127\.0\.0\.1)(?::5173)?$/.test(authority)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('本地开发仅允许 localhost 或 127.0.0.1。');
        return;
      }
      next();
    });
  },
};

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, root, 'DEV_TLS_'), ...process.env };
  let https: { cert: Buffer; key: Buffer } | undefined;
  if (command === 'serve') {
    if (!env.DEV_TLS_CERT || !env.DEV_TLS_KEY) {
      throw new Error('本地开发需要 DEV_TLS_CERT 和 DEV_TLS_KEY，路径可相对 frontend/；请使用已信任的开发证书。');
    }
    https = {
      cert: readFileSync(resolve(root, env.DEV_TLS_CERT)),
      key: readFileSync(resolve(root, env.DEV_TLS_KEY)),
    };
  }

  return {
    root,
    plugins: [localHostOnly],
    esbuild: { jsx: 'automatic' },
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      allowedHosts: ['localhost', '127.0.0.1'],
      https,
      headers: { 'Referrer-Policy': 'no-referrer' },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4000',
          changeOrigin: false,
          xfwd: false,
        },
      },
    },
    build: { outDir: 'dist' },
  };
});
