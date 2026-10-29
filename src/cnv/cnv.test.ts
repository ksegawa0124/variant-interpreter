import { describe, expect, it } from 'vitest'
import type { DosageEntry } from '../data/convert.ts'
import { classifyCnv } from './rules.ts'
import { classifyPartial, evaluateCnv, relation, type CnvEvidence, type CnvRegion, type GeneInfo, type GeneStructure } from './engine.ts'
import { parseGenes, parseStructure, toCnvRegion } from './gather.ts'
import { parseVariantInput } from '../input/parseInput.ts'

const ok = <T,>(source: string, data: T) => ({ status: 'ok' as const, source, url: '', fetchedAt: '2026-10-29T00:00:00Z', data })
const bad = (source: string) => ({ status: 'failed' as const, source, url: '', fetchedAt: '2026-10-29T00:00:00Z', error: 'timeout' })
const meta = { source: 's', url: '', fetchedAt: '2026-10-29T00:00:00Z', version: '2026-10-29', count: 0 }

const dos = (id: string, start: number, end: number, hi: number | null, ts: number | null = null, chrom = '1'): DosageEntry =>
  ({ id, band: '', chrom, start, end, hi, ts, hiPmids: [], tsPmids: [], date: null, hiDisease: null, tsDisease: null })
const gene = (symbol: string, start: number, end: number, strand: 1 | -1 = 1): GeneInfo => ({ symbol, id: 'ENSG_' + symbol, start, end, strand })

function evidence(region: CnvRegion, over: { genes?: GeneInfo[] | null; dg?: DosageEntry[]; dr?: DosageEntry[]; structures?: CnvEvidence['structures'] } = {}): CnvEvidence {
  return {
    region,
    genes: over.genes === null ? bad('Ensembl overlap (genes)') : ok('Ensembl overlap (genes)', over.genes ?? []),
    dosageGenes: ok('Dosage', { meta, entries: over.dg ?? [] }),
    dosageRegions: ok('Dosage region', { meta, entries: over.dr ?? [] }),
    validity: ok('GDV', { meta, byGene: {} }),
    structures: over.structures ?? {},
  }
}
const loss = (start: number, end: number): CnvRegion => ({ chrom: '1', start, end, type: 'LOSS' })
const gain = (start: number, end: number): CnvRegion => ({ chrom: '1', start, end, type: 'GAIN' })
const genes = (n: number) => Array.from({ length: n }, (_, i) => gene('G' + i, 1000 + i * 10, 1005 + i * 10))

describe('分類境界（2019 技術標準）', () => {
  it.each([
    [100, 'Pathogenic'], [99, 'Pathogenic'], [98, 'Likely Pathogenic'], [90, 'Likely Pathogenic'], [89, 'VUS'], [0, 'VUS'], [-89, 'VUS'],
    [-90, 'Likely Benign'], [-98, 'Likely Benign'], [-99, 'Benign'], [-160, 'Benign'],
  ])('%i/100 点 → %s', (pts, label) => {
    expect(classifyCnv(pts)).toBe(label)
  })
})

// 表 1・2 から手計算した事例（論文補足の事例は未取得のため、ルール表から導出した期待値）
describe('rubric から手計算した事例', () => {
  it('LOSS: 確立 HI 遺伝子を完全に含む(2A=1.00) + 少数遺伝子(3A=0) + 1A=0 → 1.00 = Pathogenic', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: [gene('HIG', 1000, 1500)], dg: [dos('HIG', 1000, 1500, 3)] }))
    expect(r.sectionPoints).toMatchObject({ 1: 0, 2: 100, 3: 0 })
    expect(r.total).toBe(100)
    expect(r.classification).toBe('Pathogenic')
  })
  it('LOSS: 遺伝子 35 個以上のみ(3C=0.90) → 0.90 = Likely Pathogenic', () => {
    const r = evaluateCnv(evidence(loss(900, 5000), { genes: genes(35) }))
    expect(r.geneCount).toBe(35)
    expect(r.sectionPoints[3]).toBe(90)
    expect(r.classification).toBe('Likely Pathogenic')
  })
  it('LOSS: 遺伝子数の境界 24/25/34/35', () => {
    const pts = (n: number) => evaluateCnv(evidence(loss(900, 5000), { genes: genes(n) })).sectionPoints[3]
    expect([pts(24), pts(25), pts(34), pts(35)]).toEqual([0, 45, 45, 90])
  })
  it('GAIN: 遺伝子数の境界 34/35/49/50', () => {
    const pts = (n: number) => evaluateCnv(evidence(gain(900, 5000), { genes: genes(n) })).sectionPoints[3]
    expect([pts(34), pts(35), pts(49), pts(50)]).toEqual([0, 45, 45, 90])
  })
  it('LOSS: コード遺伝子も登録領域も含まない(1B=−0.60) → VUS', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: [] }))
    expect(r.sectionPoints[1]).toBe(-60)
    expect(r.classification).toBe('VUS')
  })
  it('GAIN: 確立 TS 遺伝子を完全に含む(2A=1.00) → Pathogenic', () => {
    const r = evaluateCnv(evidence(gain(900, 2000), { genes: [gene('TSG', 1000, 1500)], dg: [dos('TSG', 1000, 1500, null, 3)] }))
    expect(r.total).toBe(100)
    expect(r.classification).toBe('Pathogenic')
  })
  it('GAIN: HI 遺伝子を完全に含んでも 0 点（2H）', () => {
    const r = evaluateCnv(evidence(gain(900, 2000), { genes: [gene('HIG', 1000, 1500)], dg: [dos('HIG', 1000, 1500, 3)] }))
    expect(r.sectionPoints[2]).toBe(0)
    expect(r.items.find((i) => i.id === '2H')).toMatchObject({ state: 'met', points: 0 })
  })
  it('確立 HI 領域を完全に含む → 2A', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: genes(1), dr: [dos('ISCA-1', 1000, 1900, 3)] }))
    expect(r.sectionPoints[2]).toBe(100)
  })
  it('2A が複数該当しても二重計上しない（最も当てはまる 1 つ）', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: [gene('A', 1000, 1100), gene('B', 1200, 1300)], dg: [dos('A', 1000, 1100, 3), dos('B', 1200, 1300, 3)] }))
    expect(r.sectionPoints[2]).toBe(100)
  })
  it('Section 4 の手動入力で再計算される（4A: 確認済 de novo 2 例 = 0.90 上限）', () => {
    const e = evidence(loss(900, 5000), { genes: genes(26) }) // 1A 0 + 3B 0.45
    expect(evaluateCnv(e).total).toBe(45)
    const r = evaluateCnv(e, { '4A': { on: true, n: 2 } })
    expect(r.sectionPoints[4]).toBe(90)
    expect(r.total).toBe(135)
    expect(r.classification).toBe('Pathogenic')
    expect(evaluateCnv(e, { '4A': { on: true, n: 5 } }).sectionPoints[4]).toBe(90) // 合計上限
  })
  it('手動の良性項目（4O=−1.00）で Benign 側へ', () => {
    const r = evaluateCnv(evidence(gain(900, 2000), { genes: genes(2) }), { '4O': { on: true } })
    expect(r.total).toBe(-100)
    expect(r.classification).toBe('Benign')
  })
  it('点数は範囲内に丸める（5H LOSS は上限 0.30）', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: genes(1) }), { '5H': { on: true, points: 80 } })
    expect(r.sectionPoints[5]).toBe(30)
  })
  it('1/100 点単位の整数演算（浮動小数の誤差が出ない）', () => {
    const r = evaluateCnv(evidence(loss(900, 5000), { genes: genes(26) }), { '4F': { on: true }, '4L': { on: true } })
    expect(Number.isInteger(r.total)).toBe(true)
    expect(r.total).toBe(45 + 15 + 45)
  })
})

describe('取得失敗は評価不可（エビデンスなしと区別）', () => {
  it('遺伝子一覧が取れない → 1A/3 を評価不可、暫定', () => {
    const r = evaluateCnv(evidence(loss(900, 2000), { genes: null }))
    expect(r.notEvaluable).toEqual(expect.arrayContaining(['1A', '3A']))
    expect(r.geneCount).toBeNull()
    expect(r.warnings.join()).toContain('暫定')
  })
  it('部分重複 HI 遺伝子の構造が取れない → 評価不可', () => {
    const r = evaluateCnv(evidence(loss(900, 1200), { genes: [gene('HIG', 1000, 1500)], dg: [dos('HIG', 1000, 1500, 3)], structures: { HIG: bad('Ensembl lookup') } }))
    expect(r.notEvaluable).toContain('2C-1')
    expect(r.sectionPoints[2]).toBe(0)
  })
})

describe('部分重複（2C/2D）の幾何判定', () => {
  const plus: GeneStructure = {
    symbol: 'HIG', strand: 1, start: 1000, end: 2000, cdsStart: 1100, cdsEnd: 1900,
    exons: [{ start: 1000, end: 1200 }, { start: 1400, end: 1500 }, { start: 1800, end: 2000 }],
  }
  const minus: GeneStructure = { ...plus, strand: -1 }
  it('relation', () => {
    expect(relation({ start: 0, end: 5000 }, { start: 1000, end: 2000 })).toBe('contained')
    expect(relation({ start: 0, end: 1500 }, { start: 1000, end: 2000 })).toBe('left')
    expect(relation({ start: 1500, end: 5000 }, { start: 1000, end: 2000 })).toBe('right')
    expect(relation({ start: 1200, end: 1500 }, { start: 1000, end: 2000 })).toBe('intragenic')
    expect(relation({ start: 5000, end: 6000 }, { start: 1000, end: 2000 })).toBeNull()
  })
  it('+鎖の左端 = 5′: コード配列を含めば 2C-1、5′UTR のみなら 2C-2', () => {
    expect(classifyPartial('left', { start: 0, end: 1500 }, plus).primary).toBe('2C-1')
    expect(classifyPartial('left', { start: 0, end: 1050 }, plus).primary).toBe('2C-2')
  })
  it('−鎖では右端が 5′', () => {
    expect(classifyPartial('right', { start: 1500, end: 5000 }, minus).primary).toBe('2C-1')
    expect(classifyPartial('right', { start: 1950, end: 5000 }, minus).primary).toBe('2C-2')
    expect(classifyPartial('left', { start: 0, end: 1500 }, minus).primary).not.toMatch(/^2C/)
  })
  it('3′ 端: 最終エクソンのみ → 2D-3（2D-2 を代替提示）、他エクソンも → 2D-4', () => {
    const last = classifyPartial('right', { start: 1700, end: 5000 }, plus)
    expect(last.primary).toBe('2D-3')
    expect(last.ids).toEqual(['2D-3', '2D-2'])
    expect(classifyPartial('right', { start: 1300, end: 5000 }, plus).primary).toBe('2D-4')
    expect(classifyPartial('right', { start: 1950, end: 1990 }, { ...plus, exons: [{ start: 1000, end: 1200 }, { start: 1400, end: 1500 }, { start: 1800, end: 1900 }] }).primary).toBe('2D-1')
  })
  it('エンジン: 5′ 部分重複の HI 遺伝子 → 2C-1 = 0.90 → LP 以上', () => {
    const r = evaluateCnv(evidence(loss(900, 1500), { genes: [gene('HIG', 1000, 2000)], dg: [dos('HIG', 1000, 2000, 3)], structures: { HIG: ok('lookup', plus) } }))
    expect(r.items.find((i) => i.id === '2C-1')).toMatchObject({ state: 'met', points: 90 })
    expect(r.sectionPoints[2]).toBe(90)
    expect(r.classification).toBe('Likely Pathogenic')
  })
  it('エンジン: 最終エクソンのみ → 2D-3 = 0.30。2D-2 を手動採用に切替できる', () => {
    const e = evidence(loss(1700, 2500), { genes: [gene('HIG', 1000, 2000)], dg: [dos('HIG', 1000, 2000, 3)], structures: { HIG: ok('lookup', plus) } })
    expect(evaluateCnv(e).sectionPoints[2]).toBe(30)
    const r = evaluateCnv(e, { '2D-3:HIG': { on: false }, '2D-2:HIG': { on: true } })
    expect(r.sectionPoints[2]).toBe(90)
  })
  it('エンジン: 遺伝子内欠失は 2E（PVS1 選択）で、選択するまで点に入らない', () => {
    const e = evidence(loss(1200, 1500), { genes: [gene('HIG', 1000, 2000)], dg: [dos('HIG', 1000, 2000, 3)] })
    const base = evaluateCnv(e)
    expect(base.items.find((i) => i.id === '2E')).toMatchObject({ state: 'manual' })
    expect(base.sectionPoints[2]).toBe(0)
    expect(evaluateCnv(e, { '2E:HIG': { on: true, points: 90 } }).sectionPoints[2]).toBe(90)
  })
})

describe('遺伝子表', () => {
  it('HI/TS と完全包含を付与する', () => {
    const r = evaluateCnv(evidence(loss(900, 1600), { genes: [gene('IN', 1000, 1500), gene('EDGE', 1500, 2500)], dg: [dos('IN', 1000, 1500, 3, 0)] }))
    expect(r.genes.find((g) => g.symbol === 'IN')).toMatchObject({ hi: 3, ts: 0, contained: true })
    expect(r.genes.find((g) => g.symbol === 'EDGE')).toMatchObject({ hi: undefined, contained: false })
  })
})

describe('入力 → 領域・Ensembl 応答の変換', () => {
  it('toCnvRegion: 座標・ISCN・HGVS.g', () => {
    const c = toCnvRegion(parseVariantInput('chr7:72663000-74133000 DEL'), 'GRCh38')
    expect(c).toMatchObject({ region: { chrom: '7', start: 72663000, end: 74133000, type: 'LOSS' }, genome: 'GRCh38' })
    const g = toCnvRegion(parseVariantInput('NC_000017.11:g.1000_900000dup'), 'GRCh37')
    expect(g).toMatchObject({ region: { chrom: '17', type: 'GAIN' }, genome: 'GRCh38' })
    expect(toCnvRegion(parseVariantInput('rs123'), 'GRCh38')).toHaveProperty('error')
  })
  it('parseGenes: タンパク質コード遺伝子のみ・名前なしは除外', () => {
    const g = parseGenes([
      { id: 'E1', external_name: 'PTEN', start: 1, end: 2, strand: 1, biotype: 'protein_coding' },
      { id: 'E2', external_name: 'LNC', start: 1, end: 2, strand: 1, biotype: 'lncRNA' },
      { id: 'E3', start: 1, end: 2, strand: -1, biotype: 'protein_coding' },
      { id: 'E4', external_name: 'AC006547.14', start: 1, end: 2, strand: 1, biotype: 'protein_coding' },
      { id: 'E5', external_name: 'FAM230A', start: 1, end: 2, strand: 1, biotype: 'protein_coding' },
    ])
    expect(g.map((x) => x.symbol)).toEqual(['PTEN', 'FAM230A'])
  })
  it('parseStructure: canonical 転写産物のエクソンと CDS', () => {
    const s = parseStructure({ display_name: 'PTEN', start: 1, end: 100, strand: -1, Transcript: [
      { is_canonical: 0, Exon: [{ start: 1, end: 2 }] },
      { is_canonical: 1, Exon: [{ start: 50, end: 100 }, { start: 1, end: 20 }], Translation: { start: 5, end: 90 } },
    ] })
    expect(s).toMatchObject({ strand: -1, cdsStart: 5, cdsEnd: 90 })
    expect(s.exons[0].start).toBe(1)
    expect(() => parseStructure({ start: 1, end: 2, strand: 1, Transcript: [] })).toThrow()
  })
})
