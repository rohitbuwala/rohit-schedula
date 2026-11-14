import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/payments-webhook-http.integration.ts'],
    hookTimeout: 30_000,
    testTimeout: 45_000,
  },
});
