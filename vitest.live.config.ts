import { defineConfig } from 'vitest/config';

/** Live LLM (Groq и др.): вне CI, требует ключи в .env.aegis */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    sequence: { concurrent: false },
  },
});
