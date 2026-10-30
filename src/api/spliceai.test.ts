import { describe, expect, it } from 'vitest'
import { fetchSpliceAi, parseSpliceAi, spliceAiVariant } from './spliceai.ts'

const score = (ag: string, al: string, dg: string, dl: string) => ({ DS_AG: ag, DS_AL: al, DS_DG: dg, DS_DL: dl })

describe('SpliceAI', () => {
  it('最大 Δ スコアを全スコアから取り出す', () => {
    const r = parseSpliceAi({ distance: 500, source: 'computed', scores: [score('0.00', '0.04', '0.00', '0.01'), score('0.00', '0.00', '0.62', '0.00')] })
    expect(r).toEqual({ maxDelta: 0.62, distance: 500, source: 'computed' })
  })
  it('API のエラー応答・スコアなしは例外（= 取得失敗 → 評価不可）', () => {
    expect(() => parseSpliceAi({ error: 'rate limit exceeded' })).toThrow(/rate limit/)
    expect(() => parseSpliceAi({ scores: [] })).toThrow(/スコア/)
    expect(() => parseSpliceAi({ scores: [{ DS_AG: 'x' }] })).toThrow()
  })
  it('変異の組み立て: SNV のみ。染色体は呼び出し側から', () => {
    expect(spliceAiVariant('17', 'NC_000017.11:g.7674221G>A')).toBe('chr17-7674221-G-A')
    expect(spliceAiVariant('X', 'NC_000023.11:g.100T>C')).toBe('chrX-100-T-C')
    expect(spliceAiVariant('1', 'NC_000001.11:g.100_101del')).toBeNull()
    expect(spliceAiVariant('1', 'NC_000001.11:g.100delinsAT')).toBeNull()
  })
  it('通信失敗は failed を返す', async () => {
    const r = await fetchSpliceAi('GRCh38', 'chr1-1-A-C', { fetchImpl: (async () => { throw new Error('down') }) as typeof fetch, maxRetries: 0 })
    expect(r.status).toBe('failed')
  })
})
