// コードカードの「出典」リンク。実際に取得した API の URL と、確認用の公開ページへのリンクを返す。
import type { SmallAnalysis } from './engine/gather.ts'
import { parseProteinChange, type CodeEvaluation } from './engine/small.ts'

export interface SourceLink { label: string; href: string }

const recordUrl = (a: SmallAnalysis, name: string) => a.sources.find((s) => s.name === name && s.url)?.url

export function sourceLinks(ev: CodeEvaluation, a: SmallAnalysis): SourceLink[] {
  const out: SourceLink[] = []
  const add = (label: string, href?: string) => { if (href && !out.some((l) => l.href === href)) out.push({ label, href }) }
  for (const s of ev.sources) {
    if (/MyVariant/.test(s) && !/ClinVar/.test(s)) add(`${s.split(' (')[0]} の取得元（MyVariant.info API）`, recordUrl(a, 'MyVariant.info'))
    else if (/^ClinVar/.test(s)) add('ClinVar 検索（MyVariant.info API）', recordUrl(a, 'ClinVar (MyVariant.info)'))
    else if (/^Ensembl VEP/.test(s)) add('Ensembl VEP の取得元（API）', recordUrl(a, 'Ensembl VEP'))
    else if (/^ClinGen Dosage/.test(s)) add('ClinGen Dosage Sensitivity', 'https://search.clinicalgenome.org/kb/gene-dosage')
    else if (/^SpliceAI/.test(s)) add('SpliceAI lookup（Broad）', 'https://spliceailookup.broadinstitute.org/')
  }
  if ((ev.id === 'PS1' || ev.id === 'PM5') && a.evidence?.clinvarCodon.status === 'ok') {
    // 根拠として引用した変異のみ: PS1 は同一置換、PM5 は別置換
    const alt = parseProteinChange(a.evidence.transcript?.hgvsp)?.alt
    const cited = a.evidence.clinvarCodon.data.filter((x) => x.plp && x.alt !== 'Ter' && x.id !== a.evidence?.selfId && x.clinvarId && (ev.id === 'PS1' ? x.alt === alt : x.alt !== alt))
    for (const v of cited.slice(0, 3)) add(`ClinVar VCV${v.clinvarId}`, `https://www.ncbi.nlm.nih.gov/clinvar/variation/${v.clinvarId}/`)
  }
  return out
}
