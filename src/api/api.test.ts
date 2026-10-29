import { describe, expect, it, vi } from 'vitest'
import { backoffDelay, createRateLimiter, fetchJson, parseRetryAfter, wrapSource } from './http.ts'
import { parseAllele, parseAlleleList, genomicHgvs } from './alleleRegistry.ts'
import { parseVep } from './vep.ts'
import { parseMyVariant } from './myvariant.ts'

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

describe('parseRetryAfter / backoffDelay', () => {
  it('秒数と HTTP 日付を解釈する', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('abc')).toBeNull()
  })
  it('指数的に増え上限で止まる', () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, 500, 1500))).toEqual([500, 1000, 1500, 1500])
  })
})

describe('fetchJson', () => {
  it('429 の Retry-After を尊重して再試行する', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, {}, { 'Retry-After': '4' }))
      .mockResolvedValueOnce(res(200, { ok: 1 }))
    const out = await fetchJson<{ ok: number }>('http://x', { fetchImpl, sleep })
    expect(out.ok).toBe(1)
    expect(sleep).toHaveBeenCalledWith(4000) // バックオフ 500ms より Retry-After が優先
  })
  it('Retry-After が無ければ指数バックオフ', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, {}))
    await fetchJson('http://x', { fetchImpl, sleep, baseDelayMs: 100 })
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200])
  })
  it('404 などは再試行しない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404))
    await expect(fetchJson('http://x', { fetchImpl, sleep: async () => {} })).rejects.toThrow('HTTP 404')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('上限回数で諦める', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500))
    await expect(
      fetchJson('http://x', { fetchImpl, sleep: async () => {}, maxRetries: 2 }),
    ).rejects.toThrow('HTTP 500')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('ネットワークエラーも再試行する', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(res(200, { a: 1 }))
    expect(await fetchJson('http://x', { fetchImpl, sleep: async () => {} })).toEqual({ a: 1 })
  })
})

describe('wrapSource', () => {
  it('失敗は例外ではなく failed で返る', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404))
    const r = await wrapSource('S', 'http://x', { fetchImpl, sleep: async () => {} })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toBe('HTTP 404')
  })
  it('成功時は取得日時を持つ', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { v: 1 }))
    const r = await wrapSource('S', 'http://x', { fetchImpl })
    expect(r.status).toBe('ok')
    expect(Date.parse(r.fetchedAt)).not.toBeNaN()
  })
  it('transform が例外でも failed になる', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, {}))
    const r = await wrapSource('S', 'http://x', { fetchImpl }, () => {
      throw new Error('bad shape')
    })
    expect(r.status).toBe('failed')
  })
})

describe('createRateLimiter', () => {
  it('最小間隔で直列化する', async () => {
    let t = 0
    const waits: number[] = []
    const acquire = createRateLimiter(100, async (ms) => { waits.push(ms); t += ms }, () => t)
    await acquire()
    await acquire()
    await acquire()
    expect(waits).toEqual([100, 100]) // 1 回目は即時、以降 100ms 間隔
  })
})

describe('parseAllele', () => {
  const raw = {
    '@id': 'http://reg.genome.network/allele/CA16602537',
    genomicAlleles: [
      { referenceGenome: 'GRCh38', chromosome: '17', coordinates: [{ start: 7674219, end: 7674220, referenceAllele: 'G', allele: 'A' }], hgvs: ['NC_000017.11:g.7674220G>A'] },
      { referenceGenome: 'GRCh37', chromosome: '17', coordinates: [{ start: 7577537, end: 7577538, referenceAllele: 'G', allele: 'A' }], hgvs: ['NC_000017.10:g.7577538G>A'] },
    ],
    transcriptAlleles: [{ hgvs: ['NM_000546.6:c.743G>A'], geneSymbol: 'TP53', MANE: { maneStatus: 'MANE Select' } }],
    externalRecords: { dbSNP: [{ rs: 11540652 }] },
  }
  it('CAid・座標・MANE・rsID を抽出する', () => {
    const a = parseAllele(raw)
    expect(a.caid).toBe('CA16602537')
    expect(a.transcriptAlleles[0]).toMatchObject({ geneSymbol: 'TP53', maneSelect: true })
    expect(a.rsIds).toEqual(['rs11540652'])
    expect(genomicHgvs(a, 'GRCh37')).toBe('NC_000017.10:g.7577538G>A')
  })
  it('rsID 応答（配列）を複数アレルとして扱う', () => {
    expect(parseAlleleList([raw, raw]).length).toBe(2)
    expect(() => parseAlleleList([])).toThrow()
  })
  it('CAid が無ければ例外', () => {
    expect(() => parseAllele({})).toThrow()
  })
})

describe('parseVep', () => {
  it('転写産物ごとの影響を正規化する', () => {
    const v = parseVep([
      {
        input: 'x',
        most_severe_consequence: 'missense_variant',
        transcript_consequences: [
          { transcript_id: 'ENST1', gene_symbol: 'TP53', consequence_terms: ['missense_variant'], canonical: 1, mane_select: 'NM_000546.6', hgvsp: 'p.Arg248Gln', domains: [{ db: 'Pfam', name: 'P53' }] },
        ],
      },
    ])
    expect(v.transcripts[0]).toMatchObject({ canonical: true, maneSelect: 'NM_000546.6' })
    expect(v.transcripts[0].domains[0].name).toBe('P53')
  })
  it('空配列は例外', () => {
    expect(() => parseVep([])).toThrow()
  })
})

describe('parseMyVariant', () => {
  it('genome を優先し、無ければ exome、どちらも無ければ none', () => {
    expect(parseMyVariant({ _id: 'a', gnomad_genome: { af: { af: 0.01 } } }).gnomad.source).toBe('gnomad_genome')
    expect(parseMyVariant({ _id: 'a', gnomad_exome: { af: { af: 0.02 } } }).gnomad.source).toBe('gnomad_exome')
    expect(parseMyVariant({ _id: 'a' }).gnomad.source).toBe('none')
  })
  it('notfound は例外', () => {
    expect(() => parseMyVariant({ notfound: true })).toThrow()
  })
})
