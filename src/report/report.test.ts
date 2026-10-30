import { describe, expect, it } from 'vitest'
import type { CnvAnalysis } from '../cnv/gather.ts'
import { autoEvaluateCnv, scoreCnv } from '../cnv/engine.ts'
import type { SmallAnalysis, SourceRecord } from '../engine/gather.ts'
import { autoEvaluate, scoreSmall, type SmallEvidence } from '../engine/small.ts'
import { buildCnvReport, buildSmallReport, missingVersions, ReportBlockedError, toJson, toText } from './report.ts'

const ok = <T,>(source: string, data: T) => ({ status: 'ok' as const, source, url: '', fetchedAt: '2026-10-30T00:00:00Z', data })
const src = (name: string, version: string | null, status: 'ok' | 'failed' = 'ok'): SourceRecord => ({ name, status, fetchedAt: '2026-10-30T01:02:03.000Z', url: 'https://example.org', version, ...(status === 'failed' ? { error: 'timeout' } : {}) })
const NOW = new Date('2026-10-30T04:00:00Z')

const evidence: SmallEvidence = {
  gene: 'GENE', transcript: { transcriptId: 'ENST1', consequenceTerms: ['missense_variant'], canonical: true, hgvsc: 'ENST1:c.1A>G', hgvsp: 'ENSP1:p.Met1Val', domains: [] },
  population: ok('gnomAD', { present: false, dataset: 'gnomAD', version: '2.1.1' }), revel: ok('REVEL', 0.95),
  splice: { status: 'failed', source: 'SpliceAI', url: '', fetchedAt: '', error: '未接続' }, clinvarCodon: ok('ClinVar', []), dosage: ok('Dosage', null), cspec: [],
}
const small = (sources: SourceRecord[]): SmallAnalysis => ({
  genome: 'GRCh38', allele: { caid: 'CA1', genomicAlleles: [], transcriptAlleles: [], rsIds: [] }, alleleCandidates: 1, vep: null, choice: null, evidence, sources, genomicHgvs: 'NC_1:g.1A>G',
  erepo: ok('ERepo', [{ caid: 'CA1', outcomeLabel: 'Pathogenic', classification: 'Pathogenic', panel: 'X VCEP', condition: 'Disease', evidenceCodes: [{ label: 'PS3', status: 'Met' }, { label: 'BA1', status: 'Not Met' }], publishedDate: '2024-01-01', warnings: [] }]),
})
const goodSources = [src('ClinGen Allele Registry', 'API（版情報の提供なし・取得時刻で特定）'), src('MyVariant.info', 'gnomAD 2.1.1 / ClinVar 2026-01 / dbNSFP 4.4'), src('Ensembl VEP', 'Ensembl release 115')]

describe('版情報の検査', () => {
  it('取得成功なのに版が空のソースを検出する（失敗ソースは対象外）', () => {
    expect(missingVersions([src('A', null), src('B', '  '), src('C', '1'), src('D', null, 'failed')])).toEqual(['A', 'B'])
  })
})

describe('小変異レポート', () => {
  const run = (a: SmallAnalysis) => {
    const result = scoreSmall(autoEvaluate(a.evidence!), {})
    return buildSmallReport(a, result, {}, 'NM_1:c.1A>G', NOW)
  }
  it('JSON: 全データソースの取得日時と版・専門家分類・自動判定・コード別判定を含む', () => {
    const r = run(small(goodSources))
    const j = JSON.parse(toJson(r))
    expect(j.schema).toBe('variant-interpreter-report/1')
    expect(j.sources).toHaveLength(3)
    expect(j.sources.every((s: { fetchedAt: string; version: string }) => s.fetchedAt && s.version)).toBe(true)
    expect(j.expertPanelStatus).toBe('found')
    expect(j.expertPanel[0]).toMatchObject({ classification: 'Pathogenic', panel: 'X VCEP' })
    expect(j.automatic.classification).toBeTruthy()
    expect(j.codes.find((c: { id: string }) => c.id === 'PP3')).toMatchObject({ state: 'met', counted: true })
    expect(j.disclaimer).toContain('診断行為には用いず')
    expect(j.variant).toMatchObject({ caid: 'CA1', gene: 'GENE', input: 'NM_1:c.1A>G' })
  })
  it('版情報のないソースがあれば出力しない', () => {
    expect(() => run(small([...goodSources, src('Dosage', null)]))).toThrow(ReportBlockedError)
    try { run(small([src('Dosage', null)])) } catch (e) { expect((e as ReportBlockedError).missing).toEqual(['Dosage']) }
  })
  it('取得失敗のソースは「取得失敗」と理由を残して出力できる', () => {
    const r = run(small([...goodSources, src('Ensembl lookup', null, 'failed')]))
    const t = toText(r)
    expect(t).toContain('取得失敗（timeout）')
    expect(t).toContain('版 ClinVar'.slice(0, 0) + '版 gnomAD 2.1.1 / ClinVar 2026-01')
  })
  it('テキスト: 専門家パネルが自動判定より前、データソース節に取得日時(UTC)と版', () => {
    const t = toText(run(small(goodSources)))
    expect(t.indexOf('専門家パネルによる分類')).toBeLessThan(t.indexOf('自動判定'))
    expect(t).toContain('取得 2026-10-30 01:02:03')
    expect(t).toContain('版 Ensembl release 115')
    expect(t).toContain('PS3:Met')
    expect(t).not.toContain('BA1:Not Met')
  })
  it('ERepo 取得失敗は「該当なし」と区別する', () => {
    const a = small(goodSources)
    a.erepo = { status: 'failed', source: 'ERepo', url: '', fetchedAt: '', error: 'timeout' }
    const r = run(a)
    expect(r.expertPanelStatus).toBe('unavailable')
    expect(toText(r)).toContain('「該当なし」ではありません')
  })
})

describe('CNV レポート', () => {
  const evidenceCnv = {
    region: { chrom: '1', start: 1000, end: 2000, type: 'LOSS' as const }, genes: ok('Ensembl', [{ symbol: 'G1', id: 'E1', start: 1100, end: 1200, strand: 1 as const }]),
    dosageGenes: { status: 'failed' as const, source: 'Dosage', url: '', fetchedAt: '', error: 'x' }, dosageRegions: { status: 'failed' as const, source: 'Dosage', url: '', fetchedAt: '', error: 'x' },
    validity: { status: 'failed' as const, source: 'GDV', url: '', fetchedAt: '', error: 'x' }, structures: {},
  }
  const cnv = (sources: SourceRecord[]): CnvAnalysis => ({ genome: 'GRCh38', chromosome: { status: 'failed', source: 'c', url: '', fetchedAt: '', error: 'x' }, evidence: evidenceCnv, sources })
  const run = (a: CnvAnalysis) => {
    const auto = autoEvaluateCnv(a.evidence)
    return buildCnvReport(a, scoreCnv(a.evidence, auto, {}), {}, NOW)
  }
  it('JSON/テキストに領域・分類・点数・データソースの版を含み、点は 1 点単位で出力する', () => {
    const r = run(cnv([src('Ensembl overlap (genes)', 'Ensembl release 115')]))
    const j = JSON.parse(toJson(r))
    expect(j.kind).toBe('cnv')
    expect(j.region).toMatchObject({ chrom: '1', start: 1000, end: 2000, type: 'LOSS', genome: 'GRCh38' })
    expect(typeof j.automatic.total).toBe('number')
    expect(Math.abs(j.automatic.total)).toBeLessThan(10) // 1/100 点の整数ではなく点で出す
    expect(j.automatic.provisional).toBe(true) // 評価不可あり
    expect(j.sources[0].version).toBe('Ensembl release 115')
    expect(toText(r)).toContain('ACMG/ClinGen CNV 技術標準 2019')
  })
  it('版のないソースがあれば出力しない', () => {
    expect(() => run(cnv([src('Ensembl overlap (genes)', null)]))).toThrow(ReportBlockedError)
  })
})
