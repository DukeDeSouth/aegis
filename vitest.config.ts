import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Security-контур требует Docker и работает минуты — отдельный конфиг
    // vitest.security.config.ts (npm run test:security).
    exclude: ['test/security/**', '**/node_modules/**'],
  },
});
