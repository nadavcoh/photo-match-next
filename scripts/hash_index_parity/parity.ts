/**
 * Parity test: the in-memory engine (src/lib/hashIndex.ts) against the real SQL
 * functions in 'exact' mode, on a local Postgres with pgvector.
 *
 *   see README.md in this directory for the setup, then:
 *   PGDATABASE=parity npx tsx scripts/hash_index_parity/parity.ts
 *
 * For every query it compares the row ids, their order, `hamming` and
 * `thumb_hamming` between match_{hashes,partner}_{image,video}(..., 'exact') and
 * the in-memory scan, plus the display columns of get_*_rows against the match
 * functions' output. It also loads the index in several chunks and checks that the
 * delta update picks up rows inserted afterwards.
 */

import { Client } from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  expireDeltaForTests, getIndex, indexSize, maintainIndex, parseBits64, resetIndexForTests,
  searchImage, searchVideo, setChunkRowsForTests,
} from '../../src/lib/hashIndex'

const THRESHOLD = Number(process.env.THRESHOLD ?? 10)
const N_QUERIES = Number(process.env.N_QUERIES ?? 400)

const db = new Client({ user: process.env.PGUSER ?? 'postgres', database: process.env.PGDATABASE ?? 'parity', host: process.env.PGHOST })

/** Just enough of the Supabase client: rpc() against the local database. */
const fakeSupabase = {
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      const keys = Object.keys(args)
      const params = keys.map((k, i) => (Array.isArray(args[k]) ? `$${i + 1}::int[]` : `$${i + 1}`)).join(', ')
      const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => ${Array.isArray(args[k]) ? `$${i + 1}::int[]` : `$${i + 1}`}`).join(', ')})`
      void params
      const r = await db.query(sql, keys.map((k) => args[k]))
      return { data: r.rows, error: null }
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
    }
  },
} as unknown as SupabaseClient

function rnd(n: number): number { return Math.floor(Math.random() * n) }
function randBits(): string { return Array.from({ length: 64 }, () => (Math.random() < 0.5 ? '0' : '1')).join('') }
function flip(bits: string, k: number): string {
  const a = bits.split('')
  for (let i = 0; i < k; i++) { const p = rnd(64); a[p] = a[p] === '0' ? '1' : '0' }
  return a.join('')
}

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail?: string): void {
  checks++
  if (!ok) { failures++; if (failures <= 15) console.error(`FAIL ${label}${detail ? ' ' + detail : ''}`) }
}

type Row = { id: number; hamming: number | null; thumb_hamming: number | null }
const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.hamming ?? '-'}:${r.thumb_hamming ?? '-'}`).join(' ')

async function main(): Promise<void> {
  await db.connect()

  // ── Load in small chunks so the multi-chunk path is exercised ──
  setChunkRowsForTests(7000)
  resetIndexForTests()
  await maintainIndex(fakeSupabase)
  const idx = getIndex()
  if (!idx) throw new Error('index did not load')
  const dbCounts = (await db.query('select (select count(*) from hashes)::int h, (select count(*) from partner)::int p')).rows[0]
  console.log('loaded', indexSize(), 'database', dbCounts)
  check('hashes row count', idx.hashes.length === dbCounts.h)
  check('partner row count', idx.partner.length === dbCounts.p)

  // Query material: real hashes, perturbed, plus pure random ones.
  const sample = (await db.query(
    `select hash_bit::text h, video_thumb_hash_bit::text t from (select * from hashes where hash_bit is not null order by random() limit ${N_QUERIES}) x`,
  )).rows as { h: string; t: string | null }[]

  for (let i = 0; i < N_QUERIES; i++) {
    const base = sample[i].h
    const q = i % 5 === 0 ? randBits() : flip(base, rnd(15))
    const qThumb = i % 3 === 0 ? flip(sample[(i + 1) % sample.length].t ?? base, rnd(10)) : flip(base, rnd(12))
    const qb = parseBits64(q)!
    const tb = parseBits64(qThumb)!

    for (const [name, tbl] of [['hashes', idx.hashes], ['partner', idx.partner]] as const) {
      // image
      const sqlImg = (await db.query(`select id, hamming, thumb_hamming from match_${name}_image($1, $2, 'exact')`, [q, THRESHOLD])).rows as Row[]
      const memImg = searchImage(tbl, qb, THRESHOLD).map((h) => ({ id: h.id, hamming: h.hamming, thumb_hamming: null }))
      check(`${name} image #${i}`, sig(sqlImg) === sig(memImg), `sql=[${sig(sqlImg).slice(0, 120)}] mem=[${sig(memImg).slice(0, 120)}]`)

      // video: all four combinations of known / unknown hash and thumb
      for (const [h, t] of [[q, qThumb], [null, qThumb], [q, null], [q, q]] as const) {
        const sqlVid = (await db.query(`select id, hamming, thumb_hamming from match_${name}_video($1, $2, $3, 'exact')`, [h, t, THRESHOLD])).rows as Row[]
        const memVid = searchVideo(tbl, h ? parseBits64(h) : null, t ? parseBits64(t) : null, THRESHOLD)
        check(`${name} video #${i} h=${h ? 'y' : 'n'} t=${t ? 'y' : 'n'}`, sig(sqlVid) === sig(memVid), `sql=[${sig(sqlVid).slice(0, 120)}] mem=[${sig(memVid).slice(0, 120)}]`)
      }
    }
  }
  console.log(`search parity: ${checks} checks, ${failures} failures`)

  // ── Display columns: get_*_rows vs the match functions' own output ──
  for (const name of ['hashes', 'partner'] as const) {
    const q = sample[0].h
    const match = (await db.query(`select * from match_${name}_image($1, 40, 'exact')`, [q])).rows as Record<string, unknown>[]
    const ids = match.map((r) => r.id as number)
    const got = (await db.query(`select * from get_${name}_rows($1::int[])`, [ids])).rows as Record<string, unknown>[]
    const byId = new Map(got.map((r) => [r.id, r]))
    let same = true
    for (const m of match) {
      const g = byId.get(m.id)
      if (!g) { same = false; break }
      for (const k of Object.keys(g)) if (JSON.stringify(g[k]) !== JSON.stringify(m[k])) { same = false; console.error('column differs', name, k, g[k], m[k]) }
    }
    check(`get_${name}_rows matches match_${name}_image columns (${ids.length} rows)`, same && got.length === ids.length)
  }

  // ── Delta: insert new rows, expire the clock, check they are found ──
  await db.query(`insert into hashes(id, filename, photo_id, width, height, hash_bit, video_thumb_hash_bit)
                  values (900001, 'new1.jpg', 'newpid1', 1, 1, $1::bit(64), null), (900002, 'new2.mp4', 'newpid2', 1, 1, $2::bit(64), $3::bit(64))`,
    [sample[1].h, sample[2].h, sample[3].h])
  expireDeltaForTests()
  await maintainIndex(fakeSupabase)
  check('delta: new rows loaded', idx.hashes.length === dbCounts.h + 2, `length=${idx.hashes.length}`)
  const found = searchImage(idx.hashes, parseBits64(sample[1].h)!, 0).map((h) => h.id)
  check('delta: new image row found at distance 0', found.includes(900001))
  const foundVid = searchVideo(idx.hashes, parseBits64(sample[2].h), parseBits64(sample[3].h), 0).map((h) => h.id)
  check('delta: new video row found at distance 0', foundVid.includes(900002))

  console.log(`done: ${checks} checks, ${failures} failures`)
  await db.end()
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
