import { Pool, PoolClient } from 'pg'

// Global singleton prevents exhausting connections on hot-reload in dev.
declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
}

export function getPool(): Pool {
  if (!global._pgPool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL environment variable is not set')

    global._pgPool = new Pool({
      connectionString: url,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
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
