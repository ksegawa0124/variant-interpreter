// 手動検証スクリプト（CI では実行しない）: npm run validate:erepo -- [遺伝子,...] [遺伝子ごとの件数]
// ERepo に専門家分類のあるバリアントを実 API で解析し、自動判定との一致/不一致を報告する。
import { writeFileSync } from 'node:fs'
import { analyzeSmall } from '../src/engine/gather.ts'
import { autoEvaluate, scoreSmall } from '../src/engine/small.ts'
import { compareWithAuto, EREPO_BASE, parseErepo, type ErepoClassification } from '../src/api/erepo.ts'

const genes = (process.argv[2] ?? 'TP53,PTEN,MYH7,CDH1').split(',')
const perGene = Number(process.argv[3] ?? 3)

interface Row { gene: string; caid: string; hgvs: string; erepo: ErepoClassification; auto?: string; points?: number; codes?: string; note?: string }
const rows: Row[] = []

for (const gene of genes) {
  const raw = await (await fetch(`${EREPO_BASE}/classifications?matchMode=exact&gene=${gene}`)).json() as { variantInterpretations: Array<{ caid: string; hgvs?: string[] }> }
  const all = raw.variantInterpretations
  // 分類が偏らないよう、分類ごとに 1 件ずつ拾う
  const picked: typeof all = []
  const seen = new Set<string>()
  for (const v of all) {
    const c = parseErepo({ variantInterpretations: [v] }, v.caid.replace('CAR:', ''))[0]
    if (c && !seen.has(c.outcomeLabel) && picked.length < perGene) { seen.add(c.outcomeLabel); picked.push(v) }
  }
  for (const v of all) if (picked.length < perGene && !picked.includes(v)) picked.push(v)

  for (const v of picked) {
    const caid = v.caid.replace('CAR:', '')
    const erepo = parseErepo({ variantInterpretations: [v] }, caid)[0]
    const hgvs = v.hgvs?.find((h) => /^NM_.*:c\./.test(h) && !h.includes('(')) ?? v.hgvs?.find((h) => h.startsWith('NM_')) ?? caid
    const row: Row = { gene, caid, hgvs, erepo }
    try {
      const a = await analyzeSmall({ kind: 'caid', raw: caid, caid }, 'GRCh38', gene)
      if (!a.evidence) row.note = a.fatal ?? '解析できず'
      else {
        const r = scoreSmall(autoEvaluate(a.evidence), {})
        row.auto = r.classification
        row.points = r.total
        row.codes = r.scored.filter((s) => s.counted).map((s) => `${s.id}${s.points > 0 ? '+' : ''}${s.points}`).join(' ')
        if (r.notEvaluable.length) row.note = `評価不可: ${r.notEvaluable.join(',')}`
      }
    } catch (e) { row.note = `例外: ${e}` }
    rows.push(row)
    console.log(`${gene} ${caid} ERepo=${erepo.outcomeLabel} auto=${row.auto ?? '-'} (${row.points ?? '-'}) ${row.codes ?? ''} ${row.note ?? ''}`)
  }
}

const judged = rows.filter((r) => r.auto)
const cmp = (r: Row) => compareWithAuto(r.erepo.classification, r.auto as never)
const exact = judged.filter((r) => cmp(r).match).length
const direction = judged.filter((r) => !cmp(r).match && cmp(r).sameDirection).length
const mismatch = judged.filter((r) => !cmp(r).match && !cmp(r).sameDirection)

const lines = [
  `# ERepo 検証結果（${new Date().toISOString().slice(0, 10)}）`,
  '',
  `対象 ${rows.length} 件 / 解析できた ${judged.length} 件 / 完全一致 ${exact} / 方向のみ一致 ${direction} / 食い違い ${mismatch.length}`,
  '',
  '| 遺伝子 | CAid | HGVS | ERepo（パネル） | ERepo の該当コード | 自動判定（点） | 自動の採用コード | 判定 | 備考 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => {
    const c = r.auto ? compareWithAuto(r.erepo.classification, r.auto as never) : undefined
    const verdict = !c ? '—' : c.match ? '一致' : c.sameDirection ? '方向のみ一致' : '食い違い'
    const met = r.erepo.evidenceCodes.filter((e) => /^met$/i.test(e.status) || /^(supporting|moderate|strong|very strong|stand.?alone)$/i.test(e.status)).map((e) => e.label).join(' ')
    return `| ${r.gene} | ${r.caid} | ${r.hgvs} | ${r.erepo.outcomeLabel}（${r.erepo.panel ?? '?'}） | ${met} | ${r.auto ?? '—'}（${r.points ?? '—'}） | ${r.codes ?? ''} | ${verdict} | ${r.note ?? ''} |`
  }),
]
writeFileSync('docs/erepo-validation.md', lines.join('\n') + '\n', 'utf8')
console.log(`\n完全一致 ${exact} / 方向一致 ${direction} / 食い違い ${mismatch.length} / ${judged.length}件中`)
