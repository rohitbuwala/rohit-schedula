import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { parse } from 'dotenv';

export function validateTestTarget(env) {
  const { ASSISTANT_TEST_DATABASE_URL: connectionString, ASSISTANT_TEST_DATABASE_HOST: host,
    ASSISTANT_TEST_DATABASE_NAME: database } = env;
  if (!connectionString || !host || !database) {
    throw new Error('Set the assistant test URL, expected host, and expected database name.');
  }
  let url;
  let urlDatabase;
  try {
    url = new URL(connectionString);
    urlDatabase = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('Invalid assistant test database URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^[a-z0-9][a-z0-9.-]*\.neon\.tech$/.test(host) ||
      !/^[a-zA-Z0-9_-]+$/.test(database) ||
      url.hostname !== host || urlDatabase !== database || !url.username || !url.password ||
      url.hash || (url.port && url.port !== '5432')) {
    throw new Error('Assistant test URL does not match the expected Neon host and database.');
  }
  const parameters = [...url.searchParams.keys()];
  if (new Set(parameters).size !== parameters.length ||
      parameters.some((key) => key !== 'sslmode' && key !== 'channel_binding') ||
      !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')) ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Assistant test URL contains unsupported connection options or unsafe TLS settings.');
  }
  // Compare endpoint names only. The application URL is never used to connect.
  if (env.DATABASE_URL) {
    let applicationHost;
    try { applicationHost = new URL(env.DATABASE_URL).hostname; }
    catch { throw new Error('Could not compare the test endpoint with the application endpoint.'); }
    const endpoint = (hostname) => hostname.replace(/-pooler(?=\.)/, '');
    if (endpoint(applicationHost) === endpoint(host)) {
      throw new Error('The assistant test URL shares the application database endpoint.');
    }
  }
  return { connectionString: url.href, host, database };
}

function connectionFailure(error) {
  const codes = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPERM',
    '28P01', '28000', '3D000', '42501', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  ]);
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const item = pending.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (codes.has(item.code)) return item.code;
    if (item.name === 'TimeoutError' || /timeout|timed out/i.test(item.message ?? '')) return 'timeout';
    if (item.type === 'error' && item.target?.constructor?.name === 'WebSocket') return 'WebSocket transport error';
    pending.push(item.cause, item.error);
    if (Array.isArray(item.errors)) pending.push(...item.errors);
  }
  return 'driver did not expose a recognized error code';
}

export async function verifyTestDatabase(env, createPool = (options) => new Pool(options)) {
  const { connectionString, host, database } = validateTestTarget(env);
  let pool;
  let result;
  let queryFailure;
  let cleanupFailed = false;
  try {
    pool = createPool({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
    // Driver idle errors can arrive after a rejected query. Keep diagnostics
    // sanitized rather than letting an unhandled event print driver internals.
    pool.on?.('error', () => {});
    result = await pool.query('SELECT current_database()');
  } catch (error) {
    queryFailure = `Read-only assistant database check failed (${connectionFailure(error)}).`;
  } finally {
    if (pool) {
      try { await pool.end(); }
      catch { cleanupFailed = true; }
    }
  }
  if (queryFailure) throw new Error(queryFailure);
  if (cleanupFailed) throw new Error('Assistant test database connection could not be closed cleanly.');
  if (result?.rows?.length !== 1 || result.rows[0]?.current_database !== database) {
    throw new Error('Connected database does not match the expected assistant test database.');
  }
  return { host, database };
}

export function loadAssistantTestEnvironment() {
  try {
    return { ...parse(readFileSync(new URL('../.env', import.meta.url))), ...process.env };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read backend/.env.');
    return { ...process.env };
  }
}

async function main() {
  try {
    const { host, database } = await verifyTestDatabase(loadAssistantTestEnvironment());
    console.log(`Verified assistant test database ${database} at ${host}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
