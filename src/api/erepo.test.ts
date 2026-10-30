import { describe, expect, it } from 'vitest'
import { compareWithAuto, fetchErepo, normalizeOutcome, parseErepo } from './erepo.ts'

const record = (caid: string, outcome: string, extra: object = {}) => ({
  caid,
  condition: { label: 'Li-Fraumeni syndrome' },
  publishedDate: '2024-08-05',
  '@id': `https://erepo.genome.network/evrepo/api/interpretation/${caid}`,
  warnings: [{ warningId: { properties: { msg: { value: 'ClinVar disagreement' } } } }],
  guidelines: [{
    label: 'ClinGen TP53 Expert Panel Specifications v2.0.0', version: '2.0.0', cspecId: 'https://cspec/1', outcome: { label: outcome },
    agents: [{ affiliation: 'TP53 VCEP', evidenceCodes: [{ label: 'BP4', status: 'Met' }, { label: 'PS1', status: 'Not Met' }] }],
  }],
  ...extra,
})

describe('ERepo', () => {
  it('分類表記を内部表記へ正規化する', () => {
    expect(normalizeOutcome('Uncertain Significance')).toBe('VUS')
    expect(normalizeOutcome('Likely Pathogenic')).toBe('Likely Pathogenic')
    expect(normalizeOutcome('Pathogenic ')).toBe('Pathogenic')
    expect(normalizeOutcome('Something else')).toBeUndefined()
    expect(normalizeOutcome(undefined)).toBeUndefined()
  })

  it('指定した CAid の分類だけを取り出し、パネル・版・証拠コード・警告を保持する', () => {
    const raw = { variantInterpretations: [record('CAR:CA000080', 'Likely Benign'), record('CAR:CA000076', 'Benign')] }
    const r = parseErepo(raw, 'CA000080')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ classification: 'Likely Benign', panel: 'TP53 VCEP', guidelineVersion: '2.0.0', publishedDate: '2024-08-05', condition: 'Li-Fraumeni syndrome' })
    expect(r[0].evidenceCodes).toEqual([{ label: 'BP4', status: 'Met' }, { label: 'PS1', status: 'Not Met' }])
    expect(r[0].warnings).toEqual(['ClinVar disagreement'])
  })

  it('該当なしは空配列（失敗ではない）', () => {
    expect(parseErepo({ variantInterpretations: [] }, 'CA1')).toEqual([])
    expect(parseErepo({ variantInterpretations: [record('CAR:CA2', 'Pathogenic')] }, 'CA1')).toEqual([])
  })

  it('形式が不正なら例外', () => {
    expect(() => parseErepo({}, 'CA1')).toThrow(/形式/)
  })

  it('同一アレルに複数の疾患・パネルの分類があればすべて返す', () => {
    const second = record('CAR:CA1', 'Pathogenic', { condition: { label: 'Other disease' } })
    expect(parseErepo({ variantInterpretations: [record('CAR:CA1', 'VUS'), second] }, 'CA1')).toHaveLength(2)
  })

  it('通信失敗はアプリを落とさず failed を返す', async () => {
    const r = await fetchErepo('CA1', { fetchImpl: (async () => { throw new Error('network down') }) as typeof fetch, maxRetries: 0 })
    expect(r.status).toBe('failed')
  })

  it('自動判定との比較: 一致 / 方向は同じ / 食い違い', () => {
    expect(compareWithAuto('Pathogenic', 'Pathogenic')).toMatchObject({ match: true })
    expect(compareWithAuto('Pathogenic', 'Likely Pathogenic')).toMatchObject({ match: false, sameDirection: true })
    expect(compareWithAuto('Benign', 'Likely Benign')).toMatchObject({ match: false, sameDirection: true })
    expect(compareWithAuto('Pathogenic', 'VUS')).toMatchObject({ match: false, sameDirection: false })
    expect(compareWithAuto('Likely Benign', 'Likely Pathogenic')).toMatchObject({ match: false, sameDirection: false })
    expect(compareWithAuto(undefined, 'VUS').match).toBe(false)
  })
})
