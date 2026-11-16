import { defineConfig } from 'vitest/config';

// 回归检查聚焦服务端确定性状态机(队列、去重、礼物增量、播放终态),统一 Node 环境。
export default defineConfig({
  test: {
    environment: 'node',
    // 页面共享逻辑(ws-client 重连状态机)使用浏览器替身在 Node 环境做确定性回归
    include: ['src/server/**/*.test.ts', 'src/web/**/*.test.ts'],
  },
});
