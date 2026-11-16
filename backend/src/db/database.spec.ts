import { Logger } from '@nestjs/common';
import { pool } from './database.js';

vi.mock('../config/env.js', () => ({
  loadDatabaseUrl: () => 'postgresql://fixture@localhost/fixture',
}));

it('handles an idle Neon client error without leaking the raw error', () => {
  const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  try {
    const error = Object.assign(new Error('private database details'), { code: 'ECONNRESET' });
    expect(() => pool.emit('error', error)).not.toThrow();
    expect(log.mock.calls).toEqual([[
      'Idle database client disconnected. Database diagnostic: ECONNRESET',
    ]]);
  } finally {
    log.mockRestore();
  }
});
