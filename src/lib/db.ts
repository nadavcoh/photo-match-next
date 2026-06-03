import { Pool, PoolClient } from 'pg'

// Global singleton prevents exhausting connections on hot-reload in dev.
declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
}

function getConnectionString(): string {
  // Supabase Vercel integration sets POSTGRES_URL (pooled via PgBouncer).
  // Fall back to DATABASE_URL for local dev / manual configuration.
  const url =
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL

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
      connectionString: getConnectionString(),
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })

    global._pgPool.on('error', (err) => {
      console.error('[pg] idle client error', err)
    })
  }
  return global._pgPool
}

/** Run a query and release the client automatically. */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
