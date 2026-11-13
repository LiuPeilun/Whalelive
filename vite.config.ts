import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VITE_HMR_PATH } from './src/shared/protocol';

// P0 采用开发中间件模式:页面由本地服务同源提供,/control 与 /overlay 是两个纯 TS 页面。
// server.ws.path 显式固定热更新路径,服务端升级路由复用同一常量(PROJECT_STRUCTURE 约定)。
export default defineConfig({
  root: 'src/web',
  appType: 'mpa',
  publicDir: false,
  clearScreen: false,
  server: {
    middlewareMode: true,
    ws: {
      path: VITE_HMR_PATH,
    },
    fs: {
      // 页面文件服务仅允许源码目录与依赖;运行数据(data/ 含 access.json)显式排除,
      // 防止通过 /@fs/ 路径绕过 API 凭据检查读取本机凭据。
      allow: [
        fileURLToPath(new URL('./src/web', import.meta.url)),
        fileURLToPath(new URL('./src/shared', import.meta.url)),
        fileURLToPath(new URL('./node_modules', import.meta.url)),
      ],
      deny: ['data/**', '.env.local', '.env'],
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      // 相对 root(src/web)解析
      input: {
        control: 'control/index.html',
        overlay: 'overlay/index.html',
      },
    },
  },
});
