import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTestDatabase } from './verify-assistant-test-db.mjs';

const host = 'ep-assistant-example.neon.tech';
const database = 'assistant_test';
const config = {
  ASSISTANT_TEST_DATABASE_URL: `postgresql://user:fixture-secret@${host}/${database}?sslmode=require`,
  ASSISTANT_TEST_DATABASE_HOST: host,
  ASSISTANT_TEST_DATABASE_NAME: database,
};

test('uses the isolated URL and executes exactly one read-only identity query', async () => {
  const calls = [];
  const result = await verifyTestDatabase(config, (options) => {
    assert.equal(options.connectionString, config.ASSISTANT_TEST_DATABASE_URL);
    return {
      async query(statement) {
        calls.push(statement);
        return { rows: [{ current_database: database }] };
      },
      async end() { calls.push('closed'); },
    };
  });
  assert.deepEqual(result, { host, database });
  assert.deepEqual(calls, ['SELECT current_database()', 'closed']);
});

test('rejects unsafe or missing configuration before creating a pool', async () => {
  const rejected = [
    { ...config, ASSISTANT_TEST_DATABASE_URL: undefined, DATABASE_URL: config.ASSISTANT_TEST_DATABASE_URL },
    { ...config, ASSISTANT_TEST_DATABASE_HOST: 'wrong.neon.tech' },
    { ...config, ASSISTANT_TEST_DATABASE_NAME: 'wrong' },
    { ...config, ASSISTANT_TEST_DATABASE_URL: config.ASSISTANT_TEST_DATABASE_URL + '&host=other.neon.tech' },
    { ...config, ASSISTANT_TEST_DATABASE_URL: config.ASSISTANT_TEST_DATABASE_URL + '&sslmode=disable' },
    { ...config, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { ...config, DATABASE_URL: config.ASSISTANT_TEST_DATABASE_URL.replace('example.', 'example-pooler.') },
  ];
  let poolsCreated = 0;
  for (const env of rejected) {
    await assert.rejects(verifyTestDatabase(env, () => { poolsCreated++; }));
  }
  assert.equal(poolsCreated, 0);
});

test('closes the pool and rejects a connected database mismatch', async () => {
  let closed = false;
  await assert.rejects(verifyTestDatabase(config, () => ({
    async query() { return { rows: [{ current_database: 'wrong' }] }; },
    async end() { closed = true; },
  })), /does not match/);
  assert.equal(closed, true);
});

test('closes the pool and suppresses raw driver errors', async () => {
  let closed = false;
  await assert.rejects(verifyTestDatabase(config, () => ({
    async query() {
      throw new Error(config.ASSISTANT_TEST_DATABASE_URL, {
        cause: Object.assign(new Error('fixture-secret'), { code: 'ENOTFOUND' }),
      });
    },
    async end() { closed = true; },
  })), { message: 'Read-only assistant database check failed (ENOTFOUND).' });
  assert.equal(closed, true);
});
