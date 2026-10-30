import { describe, expect, it } from 'vitest'
import type { VepTranscriptConsequence } from '../api/vep.ts'
import { parseClinvarCodon } from '../api/clinvarCodon.ts'
import type { CSpecDoc } from '../data/convert.ts'
import { populationFrom } from './gather.ts'
import { classifyPoints } from './rules.ts'
import { autoEvaluate, evaluateSmall, parseProteinChange, scoreSmall, type SmallEvidence } from './small.ts'
import { selectTranscript } from './transcript.ts'

const ok = <T,>(source: string, data: T) => ({ status: 'ok' as const, source, url: '', fetchedAt: '2026-10-29T00:00:00Z', data })
const bad = (source: string) => ({ status: 'failed' as const, source, url: '', fetchedAt: '2026-10-29T00:00:00Z', error: 'timeout' })

const tc = (over: Partial<VepTranscriptConsequence> = {}): VepTranscriptConsequence => ({
  transcriptId: 'ENST1', geneSymbol: 'GENE', consequenceTerms: ['missense_variant'], canonical: true, domains: [], ...over,
})

function evidence(over: Partial<SmallEvidence> = {}): SmallEvidence {
  return {
    gene: 'GENE',
    transcript: tc({ hgvsp: 'ENSP1:p.Arg248Gln' }),
    selfId: 'self',
    population: ok('gnomAD', { present: false, dataset: 'gnomAD', version: '2.1.1' }),
    revel: ok('REVEL', undefined),
    splice: bad('SpliceAI'),
    clinvarCodon: ok('ClinVar', []),
    dosage: ok('Dosage', null),
    cspec: [],
    ...over,
  }
}
const state = (ev: SmallEvidence, id: string) => autoEvaluate(ev).find((e) => e.id === id)!

describe('分類境界（ClinGen SVI ポイント）', () => {
  it.each([
    [10, 'Pathogenic'], [9, 'Likely Pathogenic'], [6, 'Likely Pathogenic'], [5, 'VUS'], [0, 'VUS'],
    [-1, 'Likely Benign'], [-6, 'Likely Benign'], [-7, 'Benign'], [-20, 'Benign'], [25, 'Pathogenic'],
  ])('%i 点 → %s', (pts, label) => {
    expect(classifyPoints(pts)).toBe(label)
  })
})

describe('頻度コード', () => {
  const pop = (af: number, hom = 0) => evidence({ population: ok('gnomAD', { present: true, af, hom, dataset: 'gnomad_genome', version: '2.1.1' }) })
  it('BA1: 5% 以上で成立し、BS1 は重複計上しない。版を併記する', () => {
    const r = evaluateSmall(pop(0.06))
    expect(r.evaluations.find((e) => e.id === 'BA1')).toMatchObject({ state: 'met' })
    expect(r.evaluations.find((e) => e.id === 'BA1')!.notes[0]).toContain('v2.1.1')
    expect(r.evaluations.find((e) => e.id === 'BS1')!.state).toBe('not_applicable')
    expect(r.classification).toBe('Benign')
    expect(r.standaloneApplied).toBe(true)
  })
  it('BS1: 1% 以上 5% 未満', () => {
    expect(state(pop(0.02), 'BS1').state).toBe('met')
    expect(state(pop(0.02), 'BA1').state).toBe('not_met')
    expect(state(pop(0.005), 'BS1').state).toBe('not_met')
  })
  it('集団最大頻度が全体頻度より高ければ、BA1/BS1/PM2 は集団最大頻度で判定する', () => {
    const p = (popmaxAf: number) => evidence({ population: ok('gnomAD', { present: true, af: 0.00005, popmaxAf, popmaxPop: 'afr/gnomad_genome', dataset: 'gnomad_genome', version: '2.1.1' }) })
    expect(state(p(0.02), 'BS1')).toMatchObject({ state: 'met' })
    expect(state(p(0.02), 'BS1').reason).toContain('afr')
    expect(state(p(0.06), 'BA1').state).toBe('met')
    expect(state(p(0.001), 'PM2').state).toBe('not_met') // 全体は 0.00005 でも afr が 0.1%
    expect(state(p(0.00001), 'PM2').state).toBe('met')
  })
  it('PM2: 不在 or 低頻度で Supporting', () => {
    expect(state(evidence(), 'PM2')).toMatchObject({ state: 'met', strength: 'supporting' })
    expect(state(pop(0.00005), 'PM2').state).toBe('met')
    expect(state(pop(0.001), 'PM2').state).toBe('not_met')
  })
  it('BS2: ホモ接合数', () => {
    expect(state(pop(0.001, 5), 'BS2').state).toBe('met')
    expect(state(pop(0.001, 1), 'BS2').state).toBe('not_met')
  })
  it('取得失敗は「評価不可」で、不在(エビデンスなし)と区別される', () => {
    const ev = evidence({ population: bad('MyVariant.info') })
    for (const id of ['BA1', 'BS1', 'BS2', 'PM2']) expect(state(ev, id).state).toBe('not_evaluable')
    const r = evaluateSmall(ev)
    expect(r.notEvaluable).toEqual(expect.arrayContaining(['BA1', 'PM2']))
    expect(r.warnings.join()).toContain('暫定')
  })
  it('populationFrom: 404 は不在、それ以外の失敗は失敗のまま', () => {
    const f = (error: string) => ({ ...bad('MyVariant.info'), error })
    expect(populationFrom(f('HTTP 404'), '2.1.1')).toMatchObject({ status: 'ok', data: { present: false, version: '2.1.1' } })
    expect(populationFrom(f('timeout 30000ms'))).toMatchObject({ status: 'failed' })
  })
})

describe('in silico (REVEL, Pejaver 2022)', () => {
  const revel = (v?: number) => evidence({ revel: ok('REVEL', v) })
  it('PP3 の強度', () => {
    expect(state(revel(0.95), 'PP3')).toMatchObject({ state: 'met', strength: 'strong' })
    expect(state(revel(0.8), 'PP3')).toMatchObject({ state: 'met', strength: 'moderate' })
    expect(state(revel(0.7), 'PP3')).toMatchObject({ state: 'met', strength: 'supporting' })
    expect(state(revel(0.5), 'PP3').state).toBe('not_met')
  })
  it('BP4 の強度', () => {
    expect(state(revel(0.002), 'BP4')).toMatchObject({ state: 'met', strength: 'very_strong' })
    expect(state(revel(0.1), 'BP4')).toMatchObject({ state: 'met', strength: 'moderate' })
    expect(state(revel(0.25), 'BP4')).toMatchObject({ state: 'met', strength: 'supporting' })
    expect(state(revel(0.5), 'BP4').state).toBe('not_met')
  })
  it('スコア無し=エビデンスなし、失敗=評価不可、非ミスセンス=適用外', () => {
    expect(state(revel(undefined), 'PP3').state).toBe('no_evidence')
    expect(state(evidence({ revel: bad('REVEL') }), 'PP3').state).toBe('not_evaluable')
    expect(state(evidence({ transcript: tc({ consequenceTerms: ['stop_gained'] }) }), 'PP3').state).toBe('not_applicable')
  })
})

describe('PVS1 / PM4 / PM1 / BP7', () => {
  it('PVS1 は候補止まりで、採用するまで点に入らない', () => {
    const ev = evidence({ transcript: tc({ consequenceTerms: ['stop_gained'], exon: '5/11' }), dosage: ok('Dosage', { hi: 3 } as never) })
    const e = state(ev, 'PVS1')
    expect(e.state).toBe('candidate')
    expect(e.reason).toContain('要確認')
    expect(e.notes.join()).toContain('HI=3')
    expect(scoreSmall(autoEvaluate(ev)).scored.find((s) => s.id === 'PVS1')!.counted).toBe(false)
    expect(scoreSmall(autoEvaluate(ev), { PVS1: { met: true } }).scored.find((s) => s.id === 'PVS1')).toMatchObject({ counted: true, points: 8 })
  })
  it('最終エクソンの LoF は NMD 回避を注記する', () => {
    expect(state(evidence({ transcript: tc({ consequenceTerms: ['stop_gained'], exon: '11/11' }) }), 'PVS1').notes.join()).toContain('NMD')
  })
  it('PM4: インフレーム長変化のみ', () => {
    expect(state(evidence({ transcript: tc({ consequenceTerms: ['inframe_deletion'] }) }), 'PM4')).toMatchObject({ state: 'met', strength: 'moderate' })
    expect(state(evidence({ transcript: tc({ consequenceTerms: ['frameshift_variant'] }) }), 'PM4').state).toBe('not_applicable')
  })
  it('PM1: Pfam 等のドメイン内ミスセンスのみ Supporting', () => {
    const inDomain = evidence({ transcript: tc({ domains: [{ db: 'Pfam', name: 'PF00870' }] }) })
    expect(state(inDomain, 'PM1')).toMatchObject({ state: 'met', strength: 'supporting' })
    expect(state(evidence({ transcript: tc({ domains: [{ db: 'Gene3D', name: 'x' }] }) }), 'PM1').state).toBe('not_met')
  })
  it('BP7: スプライス予測が無ければ評価不可、あれば判定', () => {
    const syn = tc({ consequenceTerms: ['synonymous_variant'] })
    expect(state(evidence({ transcript: syn }), 'BP7').state).toBe('not_evaluable')
    expect(state(evidence({ transcript: syn, splice: ok('SpliceAI', { maxDelta: 0.02 }) }), 'BP7').state).toBe('met')
    expect(state(evidence({ transcript: syn, splice: ok('SpliceAI', { maxDelta: 0.5 }) }), 'BP7').state).toBe('not_met')
  })
})

describe('PS1 / PM5', () => {
  const codon = (alt: string, id = 'other', plp = true) => ({ alt, plp, blb: false, id, clinvarId: 1 })
  it('同一置換の別塩基変化 → PS1（PM5 は不適用）', () => {
    const ev = evidence({ clinvarCodon: ok('ClinVar', [codon('Gln')]) })
    expect(state(ev, 'PS1').state).toBe('met')
    expect(state(ev, 'PM5').state).toBe('not_applicable')
  })
  it('同一残基の別置換 → PM5', () => {
    const ev = evidence({ clinvarCodon: ok('ClinVar', [codon('Trp')]) })
    expect(state(ev, 'PS1').state).toBe('not_met')
    expect(state(ev, 'PM5').state).toBe('met')
  })
  it('入力自身と非 P/LP は数えない', () => {
    const ev = evidence({ clinvarCodon: ok('ClinVar', [codon('Gln', 'self'), codon('Trp', 'o2', false)]) })
    expect(state(ev, 'PS1').state).toBe('not_met')
    expect(state(ev, 'PM5').state).toBe('not_met')
  })
  it('該当データ無し=エビデンスなし、失敗=評価不可', () => {
    expect(state(evidence(), 'PM5').state).toBe('no_evidence')
    expect(state(evidence({ clinvarCodon: bad('ClinVar') }), 'PS1').state).toBe('not_evaluable')
  })
  it('parseProteinChange', () => {
    expect(parseProteinChange('ENSP00000269305.4:p.Arg248Gln')).toEqual({ ref: 'Arg', pos: 248, alt: 'Gln' })
    expect(parseProteinChange('ENSP1:p.Arg248Ter')).toBeNull()
    expect(parseProteinChange('ENSP1:p.Arg248=')).toBeNull()
    expect(parseProteinChange(undefined)).toBeNull()
  })
  it('parseClinvarCodon: 審査基準なしを除外し、位置の一致のみ採用', () => {
    const raw = { hits: [
      { _id: 'a', clinvar: { variant_id: 1, hgvs: { protein: ['NP_1:p.Arg248Gln'] }, rcv: [{ clinical_significance: 'Pathogenic', review_status: 'criteria provided, single submitter' }] } },
      { _id: 'b', clinvar: { variant_id: 2, hgvs: { protein: ['NP_1:p.Arg248Trp'] }, rcv: { clinical_significance: 'Pathogenic', review_status: 'no assertion criteria provided' } } },
      { _id: 'c', clinvar: { variant_id: 3, hgvs: { protein: ['NP_1:p.Arg24Trp'] }, rcv: { clinical_significance: 'Pathogenic', review_status: 'reviewed by expert panel' } } },
      { _id: 'd', clinvar: { variant_id: 4, hgvs: { protein: ['NP_1:p.Arg248fs'] }, rcv: { clinical_significance: 'Pathogenic', review_status: 'reviewed by expert panel' } } },
    ] }
    const r = parseClinvarCodon(raw, 'Arg', 248)
    expect(r.map((v) => [v.id, v.alt, v.plp])).toEqual([['a', 'Gln', true], ['b', 'Trp', false]])
  })
})

describe('CSpec(VCEP) による上書き', () => {
  const doc = (codes: Record<string, string[]>): CSpecDoc => ({
    id: 'GN999', label: 'Test spec', version: '1.0', status: 'Released', lastUpdated: '', affiliation: 'Test VCEP', url: '',
    ruleSets: [{ genes: ['GENE'], codes: Object.fromEntries(Object.entries(codes).map(([k, labels]) => [k, {
      description: '', strengths: labels.map((label) => ({ label, applicability: 'Applicable' })), thresholdHints: k === 'BA1' ? ['0.1%'] : [],
    }])) }],
  })
  it('PM2 の強度を VCEP の指定へ上書きし、画面用の説明を残す', () => {
    const e = state(evidence({ cspec: [doc({ PM2: ['Moderate'] })] }), 'PM2')
    expect(e.strength).toBe('moderate')
    expect(e.override).toMatchObject({ kind: 'strength', from: 'supporting', to: 'moderate' })
    expect(e.override!.message).toContain('Test VCEP')
  })
  it('VCEP で適用不可のコードは採点しない', () => {
    const ev = evidence({ cspec: [doc({ PM2: [] })] })
    const r = scoreSmall(autoEvaluate(ev))
    expect(r.evaluations.find((e) => e.id === 'PM2')).toMatchObject({ vcepNotApplicable: true, override: { kind: 'not_applicable' } })
    expect(r.scored.find((s) => s.id === 'PM2')).toMatchObject({ counted: false, points: 0 })
  })
  it('頻度閾値の記載があるコードは「要確認」を示し、自動では置換しない', () => {
    const e = state(evidence({ cspec: [doc({ BA1: ['Stand Alone'] })] }), 'BA1')
    expect(e.override).toMatchObject({ kind: 'threshold_unverified' })
    expect(e.notes.join()).toContain('0.1%')
  })
  it('VCEP がある遺伝子の PM1 はドメイン内でも自動採点せず候補にする', () => {
    const ev = evidence({ transcript: tc({ domains: [{ db: 'Pfam', name: 'PF1' }] }), cspec: [doc({ PM2: ['Supporting'] })] })
    expect(state(ev, 'PM1').state).toBe('candidate')
    const r = scoreSmall(autoEvaluate(ev))
    expect(r.scored.find((s) => s.id === 'PM1')).toMatchObject({ counted: false })
  })
  it('許容強度のうち元の強度に最も近いものへ寄せる（強くしすぎない）', () => {
    const ev = (revel: number) => evidence({ revel: ok('REVEL', revel), cspec: [doc({ PP3: ['Supporting', 'Moderate'] })] })
    expect(state(ev(0.95), 'PP3').strength).toBe('moderate') // 較正 Strong → VCEP 上限 Moderate
    expect(state(ev(0.7), 'PP3')).toMatchObject({ strength: 'supporting' })
    expect(state(ev(0.7), 'PP3').override).toBeUndefined()
    const only = evidence({ cspec: [doc({ PM2: ['Moderate', 'Strong'] })] })
    expect(state(only, 'PM2').strength).toBe('moderate') // 元が Supporting のとき Strong まで飛ばさない
  })
  it('既定と同じ強度なら上書きなし', () => {
    expect(state(evidence({ cspec: [doc({ PM2: ['Supporting'] })] }), 'PM2').override).toBeUndefined()
  })
})

describe('採点と手動コード', () => {
  it('手動コードをトグルすると即座に再計算される', () => {
    const evals = autoEvaluate(evidence()) // PM2 のみ該当 = 1 点
    expect(scoreSmall(evals).total).toBe(1)
    const r = scoreSmall(evals, { PS2: { met: true }, PM6: { met: false }, PS3: { met: true, strength: 'moderate' } })
    expect(r.total).toBe(1 + 4 + 2)
    expect(r.classification).toBe('Likely Pathogenic')
  })
  it('強度を変えた手動コードの点数、良性は負', () => {
    const r = scoreSmall(autoEvaluate(evidence()), { BS3: { met: true, strength: 'supporting' } })
    expect(r.benignPoints).toBe(-1)
    expect(r.total).toBe(0)
    expect(r.warnings.join()).toContain('矛盾')
  })
  it('P 判定: PVS1(8)+PM2(1)+PP3 など 10 点以上', () => {
    const ev = evidence({ transcript: tc({ consequenceTerms: ['stop_gained'] }) })
    const r = scoreSmall(autoEvaluate(ev), { PVS1: { met: true }, PS4: { met: true, strength: 'supporting' } })
    expect(r.total).toBe(8 + 1 + 1)
    expect(r.classification).toBe('Pathogenic')
  })
})

describe('転写産物の選択順', () => {
  const list = [
    tc({ transcriptId: 'ENST_A', canonical: true }),
    tc({ transcriptId: 'ENST_B', canonical: false, maneSelect: 'NM_000001.1' }),
    tc({ transcriptId: 'ENST_C', canonical: false, geneSymbol: 'OTHER' }),
  ]
  it('MANE Select → canonical', () => {
    expect(selectTranscript(list, { gene: 'GENE' })).toMatchObject({ basis: 'mane', tc: { transcriptId: 'ENST_B' } })
    expect(selectTranscript(list.filter((t) => !t.maneSelect))).toMatchObject({ basis: 'canonical' })
  })
  it('CSpec 指定 > MANE、利用者指定 > CSpec 指定', () => {
    expect(selectTranscript(list, { vcepTranscript: 'ENST_A' })).toMatchObject({ basis: 'vcep', tc: { transcriptId: 'ENST_A' } })
    expect(selectTranscript(list, { vcepTranscript: 'ENST_A', userTranscript: 'NM_000001.2' })).toMatchObject({ basis: 'user', tc: { transcriptId: 'ENST_B' } })
  })
  it('空なら null', () => {
    expect(selectTranscript([])).toBeNull()
  })
})
