import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local tests/builds only. Never migrate, deploy, change Git, or connect to a live DB.
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(backend, '../frontend');
const unitFiles = readdirSync(join(frontend, 'tests')).filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => `tests/${name}`);
const checks = [
  ['Backend regression tests (includes queue integration)', backend, ['node_modules/vitest/vitest.mjs', 'run']],
  ['Backend production build', backend, ['node_modules/@nestjs/cli/bin/nest.js', 'build']],
  ['Backend lint', backend, ['node_modules/oxlint/bin/oxlint', 'src/', 'test/']],
  ['Frontend regression tests', frontend, ['--experimental-strip-types', '--test', ...unitFiles]],
  ['Frontend production build', frontend, ['node_modules/next/dist/bin/next', 'build', '--webpack']],
  ['Frontend lint', frontend, ['node_modules/eslint/bin/eslint.js', '.']],
  ['Browser workflow (isolated API/payment/voice fixtures)', frontend, ['--test', 'tests/e2e/assistant-browser.test.mjs']],
];

for (const [name, cwd, args] of checks) {
  console.log(`\nRelease check: ${name}`);
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    child.once('error', reject);
    child.once('exit', (status, signal) => done(signal ? 1 : status ?? 1));
  });
  if (code !== 0) {
    console.error(`Release check failed: ${name}. Remaining checks were not run.`);
    process.exitCode = code;
    break;
  }
}
if (!process.exitCode) {
  console.log('\nLocal release checks passed. Database migrations, PostgreSQL concurrency checks and live verification are still PENDING.');
}
