import { defineConfig } from 'vitest/config';

// Security-контур (V1/V2/V3/V4/V8): V2/V3 требуют Docker; V1/V4/V8 — без Docker.
// глобальный exclude в vitest.config.ts не позволил бы запустить папку явно.
export default defineConfig({
  test: {
    include: ['test/security/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
