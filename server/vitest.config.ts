import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    // windowsHome: os.homedir() follows HOME on Windows, so suites that sandbox
    // HOME never touch the real ~/.pixel-agents (see the file).
    setupFiles: ['allure-vitest/setup', './__tests__/setup/windowsHome.ts'],
    reporters: [
      'default',
      [
        'allure-vitest/reporter',
        {
          resultsDir: '../allure-results/server',
        },
      ],
    ],
  },
});
