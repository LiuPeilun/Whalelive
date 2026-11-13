import { defineConfig } from 'vitest/config';

// 回归检查聚焦服务端确定性状态机(队列、去重、礼物增量、播放终态),统一 Node 环境。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/server/**/*.test.ts'],
  },
});
