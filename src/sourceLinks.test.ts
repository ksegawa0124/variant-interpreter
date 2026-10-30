import { describe, expect, it } from 'vitest'
import type { SmallAnalysis } from './engine/gather.ts'
import type { CodeEvaluation, SmallEvidence } from './engine/small.ts'
import { sourceLinks } from './sourceLinks.ts'

const rec = (name: string, url: string) => ({ name, status: 'ok' as const, fetchedAt: '', url, version: 'v' })
const ev = (id: string, sources: string[]): CodeEvaluation => ({ id, state: 'met', strength: 'supporting', reason: '', notes: [], vcepNotApplicable: false, sources })
const analysis = (codon: Array<{ alt: string; plp: boolean; id: string; clinvarId?: number }>): SmallAnalysis => ({
  genome: 'GRCh38', alleleCandidates: 1, vep: null, choice: null, allele: { caid: 'CA1', genomicAlleles: [], transcriptAlleles: [], rsIds: [] },
  evidence: { selfId: 'self', transcript: { hgvsp: 'ENSP1:p.Arg248Gln' }, clinvarCodon: { status: 'ok', source: '', url: '', fetchedAt: '', data: codon.map((c) => ({ blb: false, ...c })) } } as unknown as SmallEvidence,
  sources: [rec('MyVariant.info', 'https://myvariant.info/v1/variant/x'), rec('Ensembl VEP', 'https://rest.ensembl.org/vep/x'), rec('ClinVar (MyVariant.info)', 'https://myvariant.info/v1/query?q=y')],
})

describe('出典リンク', () => {
  it('頻度/in silico は取得した MyVariant API の URL、VEP は VEP の URL', () => {
    const a = analysis([])
    expect(sourceLinks(ev('BA1', ['gnomAD (MyVariant.info)']), a).map((l) => l.href)).toContain('https://myvariant.info/v1/variant/x')
    expect(sourceLinks(ev('PM4', ['Ensembl VEP']), a).map((l) => l.href)).toContain('https://rest.ensembl.org/vep/x')
  })
  it('PS1/PM5 は ClinVar の VCV ページへ（入力自身・Ter・非 P/LP を除く）', () => {
    const a = analysis([{ alt: 'Trp', plp: true, id: 'a', clinvarId: 11 }, { alt: 'Ter', plp: true, id: 'b', clinvarId: 12 }, { alt: 'Gln', plp: true, id: 'self', clinvarId: 13 }, { alt: 'Leu', plp: false, id: 'c', clinvarId: 14 }])
    const hrefs = sourceLinks(ev('PM5', ['ClinVar (MyVariant.info)']), a).map((l) => l.href)
    expect(hrefs).toContain('https://www.ncbi.nlm.nih.gov/clinvar/variation/11/')
    expect(hrefs.join()).not.toMatch(/variation\/(12|13|14)\//)
  })
  it('PS1 は同一置換、PM5 は別置換の VCV だけをリンクする', () => {
    const a = analysis([{ alt: 'Gln', plp: true, id: 'a', clinvarId: 21 }, { alt: 'Trp', plp: true, id: 'b', clinvarId: 22 }])
    expect(sourceLinks(ev('PS1', ['ClinVar (MyVariant.info)']), a).map((l) => l.href).join()).toMatch(/variation\/21\//)
    expect(sourceLinks(ev('PS1', ['ClinVar (MyVariant.info)']), a).map((l) => l.href).join()).not.toMatch(/variation\/22\//)
    expect(sourceLinks(ev('PM5', ['ClinVar (MyVariant.info)']), a).map((l) => l.href).join()).toMatch(/variation\/22\//)
  })
  it('取得 URL が空（失敗）のソースはリンクにしない。重複しない', () => {
    const a = analysis([])
    a.sources = [rec('MyVariant.info', '')]
    expect(sourceLinks(ev('BS1', ['gnomAD (MyVariant.info)', 'gnomAD (MyVariant.info)']), a).filter((l) => /MyVariant/.test(l.label))).toHaveLength(0)
  })
})
