const connectionCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', '08000', '08001', '08003', '08004',
  '08006', '08007', '08P01', '53300', '57P01', '57P02', '57P03',
]);
const databaseCodes = new Set(['28P01', '28000', '3D000', '42501', '42703', '42P01']);

export function classifyDatabaseFailure(error: unknown) {
  const pending = [error];
  const seen = new Set<unknown>();
  let webSocketError = false;
  let connectionError = false;

  for (let i = 0; i < pending.length && i < 16; i++) {
    const entry = pending[i];
    if (typeof entry !== 'object' || entry === null || seen.has(entry)) continue;
    seen.add(entry);
    if ('code' in entry && typeof entry.code === 'string') {
      if (connectionCodes.has(entry.code)) return { connection: true, diagnostic: entry.code };
      if (databaseCodes.has(entry.code)) return { connection: false, diagnostic: entry.code };
    }
    if (entry instanceof Event && entry.type === 'error') {
      webSocketError = true;
      if ('error' in entry) pending.push(entry.error);
    }
    if (entry instanceof Error) {
      connectionError ||= [
        'Connection terminated',
        'Connection terminated unexpectedly',
        'Connection terminated due to connection timeout',
        'timeout exceeded when trying to connect',
      ].includes(entry.message);
      pending.push(entry.cause);
    }
    if (entry instanceof AggregateError) pending.push(...entry.errors.slice(0, 8));
  }

  if (webSocketError) return { connection: true, diagnostic: 'websocket_error' };
  if (connectionError) return { connection: true, diagnostic: 'connection_failed' };
  return { connection: false, diagnostic: 'unclassified' };
}
