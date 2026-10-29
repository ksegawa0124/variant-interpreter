import { describe, expect, it } from 'vitest'
import {
  extractThresholdHints, parseCSpecDoc, parseCSpecIndex, parseCsv, parseDosageReleaseDate, parseDosageTsv, parseValidityCsv,
} from './convert.ts'
import { cspecForGene, dosageForGene, findOverlaps, overlapBp, validityForGene, loadDosageGenes, loadValidity, loadCSpec, loadDosageRegions } from './reference.ts'

const TSV = [
  '#ClinGen Gene Curation Results',
  '#29 Oct,2026',
  '#Gene Symbol\tGene ID\tcytoBand\tGenomic Location\tHaploinsufficiency Score\tHaploinsufficiency Description\tHaploinsufficiency PMID1\tHaploinsufficiency PMID2\tHaploinsufficiency PMID3\tHaploinsufficiency PMID4\tHaploinsufficiency PMID5\tHaploinsufficiency PMID6\tTriplosensitivity Score\tTriplosensitivity Description\tTriplosensitivity PMID1\tTriplosensitivity PMID2\tTriplosensitivity PMID3\tTriplosensitivity PMID4\tTriplosensitivity PMID5\tTriplosensitivity PMID6\tDate Last Evaluated\tHaploinsufficiency Disease ID\tTriplosensitivity Disease ID',
  'AAGAB\t79719\t15q23\tchr15:67200667-67255198\t3\tSufficient\t23064416\t23000146\t\t\t\t\t0\tNo evidence\t\t\t\t\t\t\t2013-02-28\tMONDO:0007858\t',
  'FOO\t1\t1p1\tchr1:100-200\tNot yet evaluated\t\t\t\t\t\t\t\t-1\tx\t\t\t\t\t\t\t2020-01-01\t\t',
  'NOLOC\t2\t-\tNot mapped\t0\t\t\t\t\t\t\t\t0\t\t\t\t\t\t\t\t\t\t',
].join('\n')

describe('Dosage TSV', () => {
  it('配布日を ISO へ', () => {
    expect(parseDosageReleaseDate(TSV)).toBe('2026-10-29')
    expect(parseDosageReleaseDate('no date')).toBeNull()
  })
  it('スコア・座標・PMID を解釈し、座標なし行は除外する', () => {
    const e = parseDosageTsv(TSV)
    expect(e).toHaveLength(2)
    expect(e[0]).toMatchObject({ id: 'AAGAB', chrom: '15', start: 67200667, end: 67255198, hi: 3, ts: 0, hiPmids: ['23064416', '23000146'], hiDisease: 'MONDO:0007858' })
    expect(e[1]).toMatchObject({ hi: null, ts: -1 }) // 未評価は null、負値は保持
  })
  it('ヘッダー不正は例外', () => {
    expect(() => parseDosageTsv('a\tb')).toThrow()
  })
})

describe('CSV / Gene-Disease Validity', () => {
  it('引用符・カンマ・改行を扱う', () => {
    expect(parseCsv('"a","b,c","d""e"\n"x","y\nz",w')).toEqual([['a', 'b,c', 'd"e'], ['x', 'y\nz', 'w']])
  })
  const CSV = [
    '"CLINGEN GENE DISEASE VALIDITY CURATIONS","",""',
    '"FILE CREATED: 2026-10-29","",""',
    '"GENE SYMBOL","GENE ID (HGNC)","DISEASE LABEL","DISEASE ID (MONDO)","MOI","SOP","CLASSIFICATION","ONLINE REPORT","CLASSIFICATION DATE","GCEP"',
    '"+++++++++++","++++","+++","+++","+++","+++","+++","+++","+++","+++"',
    '"PTEN","HGNC:9588","PTEN hamartoma tumor syndrome, with comma","MONDO:0017623","AD","SOP10","Definitive","https://search.clinicalgenome.org/kb/gene-validity/CGGV:abc","2024-03-14T16:00:00.000Z","Hereditary Cancer GCEP"',
    '"PTEN","HGNC:9588","Other","MONDO:1","AR","SOP10","Limited","https://search.clinicalgenome.org/kb/gene-validity/CGGV:def","2023-01-01T00:00:00.000Z","X"',
  ].join('\n')
  it('遺伝子ごとにまとめ、レポート URL を短縮する', () => {
    const { byGene, fileDate } = parseValidityCsv(CSV)
    expect(fileDate).toBe('2026-10-29')
    expect(byGene.PTEN).toHaveLength(2)
    expect(byGene.PTEN[0]).toMatchObject({ classification: 'Definitive', moi: 'AD', report: 'CGGV:abc', date: '2024-03-14' })
    expect(byGene.PTEN[0].disease).toContain('with comma')
  })
})

describe('CSpec', () => {
  it('svis 一覧から遺伝子を抽出', () => {
    const idx = parseCSpecIndex({
      data: [{ '@id': 'https://x/id/GN003', affiliation: { label: 'PTEN VCEP' }, status: 'Released', version: '3.2', url: 'u',
        ruleSets: [{ genes: [{ label: 'PTEN' }] }, { genes: [{ label: 'PTEN' }, { label: 'AAA' }] }] }],
    })
    expect(idx[0]).toMatchObject({ id: 'GN003', version: '3.2', genes: ['PTEN', 'AAA'] })
  })
  const doc = {
    '@id': 'https://x/id/GN999', label: ' Spec  label ', version: '1.0', currentStatus: 'Released', lastUpdated: '2026-07-20T14:00:00Z',
    affiliation: { label: 'Test VCEP' },
    ruleSets: [{
      genes: [{ label: 'TP53' }],
      criteriaCodes: [
        { label: 'BA1', description: 'AF above 5%', evidenceStrengths: [
          { label: 'Stand Alone', applicability: 'Applicable', description: 'MAF > 0.1%' },
          { label: 'Strong', applicability: 'Not Applicable' }] },
        { label: 'PS4', description: 'x', evidenceStrengths: [{ label: 'Strong', applicability: 'Not Applicable for this VCEP' }] },
      ],
    }],
  }
  it('適用可能な強度だけを残し、適用不可は空にする', () => {
    const d = parseCSpecDoc(doc)
    expect(d).toMatchObject({ id: 'GN999', label: 'Spec label', status: 'Released', affiliation: 'Test VCEP' })
    const codes = d.ruleSets[0].codes
    expect(codes.BA1.strengths.map((s) => s.label)).toEqual(['Stand Alone'])
    expect(codes.PS4.strengths).toEqual([]) // = この VCEP では適用不可
    expect(codes.BA1.thresholdHints).toEqual(expect.arrayContaining(['5%', '0.1%']))
  })
  it('不正な ID は例外', () => {
    expect(() => parseCSpecDoc({ '@id': 'x' })).toThrow()
  })
  it('数値の手掛かり抽出', () => {
    expect(extractThresholdHints('MAF 0.00003, 1e-5 or 4 x 10-5, 0.1%')).toEqual(expect.arrayContaining(['0.00003', '1e-5', '0.1%']))
  })
})

describe('検索ヘルパ', () => {
  const f = { meta: {} as never, entries: [
    { id: 'A', chrom: '7', start: 100, end: 200 }, { id: 'B', chrom: '7', start: 150, end: 400 }, { id: 'C', chrom: '8', start: 100, end: 200 },
  ] as never }
  it('overlapBp は両端含み', () => {
    expect(overlapBp(100, 200, 200, 300)).toBe(1)
    expect(overlapBp(100, 200, 201, 300)).toBe(0)
  })
  it('区間と重なるエントリを返す（chr 接頭辞可）', () => {
    const r = findOverlaps(f, 'chr7', 120, 300)
    expect(r.map((x) => x.entry.id)).toEqual(['A', 'B'])
    expect(r[0]).toMatchObject({ overlap: 81, contained: false })
    expect(findOverlaps(f, '7', 50, 500).every((x) => x.contained)).toBe(true)
  })
  it('遺伝子検索は大文字小文字を区別しない', () => {
    expect(dosageForGene({ meta: {} as never, entries: [{ id: 'TP53' } as never] }, 'tp53')?.id).toBe('TP53')
    expect(validityForGene({ meta: {} as never, byGene: { TP53: [1 as never] } }, 'tp53')).toHaveLength(1)
    expect(validityForGene({ meta: {} as never, byGene: {} }, 'X')).toEqual([])
    expect(cspecForGene({ meta: {} as never, byGene: { TP53: ['GN1'] }, specs: [{ id: 'GN1' } as never, { id: 'GN2' } as never] }, 'TP53')).toHaveLength(1)
  })
})

// 同梱された生成 JSON の形と版情報を検査する（再生成後も崩れないよう、値ではなく構造と安定した事実のみ）
describe('同梱データ', () => {
  it('Dosage: 版・取得日時があり、BRCA1 が HI=3 で GRCh38/37 の座標が異なる', async () => {
    const [a, b] = await Promise.all([loadDosageGenes('GRCh38'), loadDosageGenes('GRCh37')])
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    if (a.status !== 'ok' || b.status !== 'ok') return
    expect(a.data.meta.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Date.parse(a.data.meta.fetchedAt)).not.toBeNaN()
    expect(a.data.meta.assembly).toBe('GRCh38')
    const x = dosageForGene(a.data, 'BRCA1')
    const y = dosageForGene(b.data, 'BRCA1')
    expect(x?.hi).toBe(3)
    expect(x?.start).not.toBe(y?.start)
  })
  it('Dosage 領域・GDV・CSpec が読めて版情報を持つ', async () => {
    const [r, v, c] = await Promise.all([loadDosageRegions('GRCh38'), loadValidity(), loadCSpec()])
    for (const s of [r, v, c]) {
      expect(s.status).toBe('ok')
      if (s.status === 'ok') {
        expect(s.data.meta.count).toBeGreaterThan(50)
        expect(s.data.meta.fetchedAt).toBeTruthy()
        expect(s.data.meta.version).toBeTruthy()
      }
    }
    if (v.status === 'ok') expect(validityForGene(v.data, 'PTEN').some((e) => e.classification === 'Definitive')).toBe(true)
    if (c.status === 'ok') {
      const docs = cspecForGene(c.data, 'TP53')
      expect(docs.length).toBeGreaterThan(0)
      expect(Object.keys(docs[0].ruleSets[0].codes)).toEqual(expect.arrayContaining(['BA1', 'PM2', 'PVS1']))
    }
  })
})
