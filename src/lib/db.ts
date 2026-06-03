import { Pool, PoolClient, PoolConfig } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
}

/**
 * Parse the connection string into individual PoolConfig fields.
 *
 * We do NOT use `connectionString` directly because when the URL contains
 * `?sslmode=require`, the pg driver honours that over any `ssl` option we
 * pass in the config object, which causes "self-signed certificate in
 * certificate chain" on Supabase's PgBouncer pooler.
 *
 * By extracting each field ourselves we keep SSL encrypted but disable
 * certificate verification, which is correct for Supabase's infrastructure.
 */
function parseConnectionString(url: string): PoolConfig {
  const u = new URL(url)
  return {
    host:     u.hostname,
    port:     parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user:     decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl:      { rejectUnauthorized: false },
  }
}

function getConnectionString(): string {
  // Supabase Vercel integration sets POSTGRES_URL (pooled via PgBouncer).
  // Fall back to DATABASE_URL for local dev / manual configuration.
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'No database URL found. Set POSTGRES_URL (Supabase Vercel integration) ' +
      'or DATABASE_URL in your environment variables.'
    )
  }
  return url
}

export function getPool(): Pool {
  if (!global._pgPool) {
    global._pgPool = new Pool({
      ...parseConnectionString(getConnectionString()),
      max: 10,
      idleTimeoutMillis:    30_000,
      connectionTimeoutMillis: 5_000,
    })

    global._pgPool.on('error', (err) => {
      console.error('[pg] idle client error', err)
    })
  }
  return global._pgPool
}

/** Run a callback with a checked-out client, releasing it automatically. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
