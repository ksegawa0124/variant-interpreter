// レポート（JSON / テキスト）の組み立て。ネットワークや DOM には依存しない純粋関数。
// 再現性のため、各データソースの取得日時と版を必ず含める。版のない成功ソースがあれば出力しない。
import type { ErepoClassification } from '../api/erepo.ts'
import type { SourceRecord, SmallAnalysis } from '../engine/gather.ts'
import { SMALL_CODES } from '../engine/rules.ts'
import type { ManualMap, SmallResult } from '../engine/small.ts'
import type { CnvAnalysis } from '../cnv/gather.ts'
import { formatCnvPoints, type CnvManualMap, type CnvResult } from '../cnv/engine.ts'

export const REPORT_SCHEMA = 'variant-interpreter-report/1'
export const REPORT_DISCLAIMER = '本レポートは研究および解釈支援を目的とします。診断行為には用いず、最終判断は資格を持つ担当者が行ってください。'
export const REPORT_PRIVACY = '患者個人情報は含まれていません（入力された変異/座標のみ）。'

export interface ReportSource {
  name: string
  status: 'ok' | 'failed'
  fetchedAt: string
  version: string | null
  url: string
  error?: string
}

export interface ReportBase {
  schema: typeof REPORT_SCHEMA
  generatedAt: string
  app: { name: string; version: string; commit: string }
  disclaimer: string
  privacy: string
  kind: 'small' | 'cnv'
  sources: ReportSource[]
}

export interface SmallReport extends ReportBase {
  kind: 'small'
  variant: {
    input: string
    caid?: string
    gene?: string
    transcript?: string
    hgvsc?: string
    hgvsp?: string
    genomicHgvs?: string
    genome: string
    consequence?: string
  }
  expertPanel: Array<{ classification: string; panel?: string; condition?: string; guideline?: string; publishedDate?: string; url?: string; evidenceCodes: string[] }>
  expertPanelStatus: 'found' | 'none' | 'unavailable'
  automatic: {
    classification: string
    points: number
    provisional: boolean
    notEvaluable: string[]
    warnings: string[]
  }
  codes: Array<{
    id: string; direction: 'pathogenic' | 'benign'; state: string; strength: string; counted: boolean; points: number
    reason: string; notes: string[]; vcepOverride?: string; manualInput?: { met: boolean; strength?: string }
  }>
}

export interface CnvReport extends ReportBase {
  kind: 'cnv'
  region: { chrom: string; start: number; end: number; type: string; genome: string }
  automatic: { classification: string; total: number; sectionPoints: Record<string, number>; provisional: boolean; notEvaluable: string[]; warnings: string[]; geneCount: number | null }
  items: Array<{ key: string; id: string; section: number; state: string; basis?: string; counted: boolean; points: number; reason: string; notes: string[]; manualInput?: { on?: boolean; points?: number; n?: number } }>
  genes: Array<{ symbol: string; start: number; end: number; hi: unknown; ts: unknown; gdv?: string; contained: boolean }>
}

const appInfo = () => ({
  name: 'Variant Interpreter',
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
  commit: typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'unknown',
})

const toSources = (s: SourceRecord[]): ReportSource[] =>
  s.map((x) => ({ name: x.name, status: x.status, fetchedAt: x.fetchedAt, version: x.version, url: x.url, ...(x.error ? { error: x.error } : {}) }))

/** 取得に成功したのに版が空のソース（= 再現性を担保できない）。1 件でもあれば出力しない。 */
export function missingVersions(sources: ReportSource[]): string[] {
  return sources.filter((s) => s.status === 'ok' && !s.version?.trim()).map((s) => s.name)
}

export class ReportBlockedError extends Error {
  missing: string[]
  constructor(missing: string[]) {
    super(`版情報のないデータソースがあるため、レポートを出力できません: ${missing.join(', ')}`)
    this.missing = missing
  }
}

const erepoRows = (c: ErepoClassification[]) =>
  c.map((x) => ({
    classification: x.classification ?? x.outcomeLabel, panel: x.panel, condition: x.condition, guideline: x.guideline ? `${x.guideline}${x.guidelineVersion ? ` v${x.guidelineVersion}` : ''}` : undefined,
    publishedDate: x.publishedDate, url: x.url, evidenceCodes: x.evidenceCodes.map((e) => `${e.label}:${e.status}`),
  }))

export function buildSmallReport(a: SmallAnalysis, result: SmallResult, manual: ManualMap, input: string, now = new Date()): SmallReport {
  const sources = toSources(a.sources)
  const missing = missingVersions(sources)
  if (missing.length) throw new ReportBlockedError(missing)
  const tc = a.evidence?.transcript
  return {
    schema: REPORT_SCHEMA, generatedAt: now.toISOString(), app: appInfo(), disclaimer: REPORT_DISCLAIMER, privacy: REPORT_PRIVACY, kind: 'small', sources,
    variant: {
      input, caid: a.allele?.caid, gene: a.evidence?.gene, transcript: tc?.transcriptId, hgvsc: tc?.hgvsc, hgvsp: tc?.hgvsp,
      genomicHgvs: a.genomicHgvs, genome: a.genome, consequence: tc?.consequenceTerms.join(', '),
    },
    expertPanelStatus: a.erepo?.status !== 'ok' ? 'unavailable' : a.erepo.data.length ? 'found' : 'none',
    expertPanel: a.erepo?.status === 'ok' ? erepoRows(a.erepo.data) : [],
    automatic: {
      classification: result.classification, points: result.total, provisional: result.notEvaluable.length > 0,
      notEvaluable: result.notEvaluable, warnings: result.warnings,
    },
    codes: result.evaluations.map((ev) => {
      const s = result.scored.find((x) => x.id === ev.id)
      const m = manual[ev.id]
      return {
        id: ev.id, direction: SMALL_CODES.find((c) => c.id === ev.id)?.direction ?? 'pathogenic', state: ev.vcepNotApplicable ? 'vcep_not_applicable' : ev.state,
        strength: s?.strength ?? ev.strength, counted: s?.counted ?? false, points: s?.points ?? 0, reason: ev.reason, notes: ev.notes,
        ...(ev.override ? { vcepOverride: ev.override.message } : {}),
        ...(m ? { manualInput: { met: m.met, strength: m.strength } } : {}),
      }
    }),
  }
}

export function buildCnvReport(a: CnvAnalysis, r: CnvResult, manual: CnvManualMap, now = new Date()): CnvReport {
  const sources = toSources(a.sources)
  const missing = missingVersions(sources)
  if (missing.length) throw new ReportBlockedError(missing)
  const { region } = a.evidence
  return {
    schema: REPORT_SCHEMA, generatedAt: now.toISOString(), app: appInfo(), disclaimer: REPORT_DISCLAIMER, privacy: REPORT_PRIVACY, kind: 'cnv', sources,
    region: { chrom: region.chrom, start: region.start, end: region.end, type: region.type, genome: a.genome },
    automatic: {
      classification: r.classification, total: r.total / 100, sectionPoints: Object.fromEntries(Object.entries(r.sectionPoints).map(([k, v]) => [`S${k}`, v / 100])),
      provisional: r.notEvaluable.length > 0, notEvaluable: r.notEvaluable, warnings: r.warnings, geneCount: r.geneCount,
    },
    items: r.items.map((it) => {
      const c = r.counted.find((x) => x.key === it.key)
      const m = manual[it.key]
      return {
        key: it.key, id: it.id, section: it.section, state: it.state, basis: it.basis, counted: !!c, points: (c?.points ?? 0) / 100,
        reason: it.reason, notes: it.notes, ...(m ? { manualInput: { on: m.on, points: m.points !== undefined ? m.points / 100 : undefined, n: m.n } } : {}),
      }
    }),
    genes: r.genes.map((g) => ({ symbol: g.symbol, start: g.start, end: g.end, hi: g.hi, ts: g.ts, gdv: g.gdv, contained: g.contained })),
  }
}

export const toJson = (r: ReportBase) => JSON.stringify(r, null, 2)

const sgn = (n: number) => (n > 0 ? `+${n}` : String(n))

function sourceLines(sources: ReportSource[]): string[] {
  return [
    '■ データソースと版（取得日時は UTC）',
    ...sources.map((s) => `- ${s.name}: ${s.status === 'ok' ? '取得済み' : `取得失敗（${s.error ?? '理由不明'}）`} / 取得 ${s.fetchedAt.replace('T', ' ').slice(0, 19)} / 版 ${s.version ?? '（取得失敗のため無し）'}`),
  ]
}

export function toText(r: SmallReport | CnvReport): string {
  const head = [
    `${r.app.name} レポート（v${r.app.version} / ${r.app.commit}）`,
    `作成日時(UTC): ${r.generatedAt.replace('T', ' ').slice(0, 19)}`,
    `※ ${r.disclaimer}`, `※ ${r.privacy}`, '',
  ]
  if (r.kind === 'small') {
    const v = r.variant
    const out = [
      ...head,
      '■ バリアント',
      `入力: ${v.input}`, `CAid: ${v.caid ?? '—'}　遺伝子: ${v.gene ?? '—'}　ゲノム: ${v.genome}`,
      `転写産物: ${v.transcript ?? '—'}　HGVS.c: ${v.hgvsc ?? '—'}　HGVS.p: ${v.hgvsp ?? '—'}`,
      `ゲノム座標: ${v.genomicHgvs ?? '—'}　consequence: ${v.consequence ?? '—'}`, '',
      '■ 専門家パネルによる分類（ClinGen Evidence Repository）',
    ]
    if (r.expertPanelStatus === 'unavailable') out.push('取得失敗のため有無は不明（「該当なし」ではありません）')
    else if (r.expertPanelStatus === 'none') out.push('専門家パネルによる分類は見つかりませんでした')
    else for (const e of r.expertPanel) out.push(`- ${e.classification}（${e.panel ?? '専門家パネル'}、公開日 ${e.publishedDate ?? '—'}）疾患: ${e.condition ?? '—'} / 仕様: ${e.guideline ?? '—'}`, `  該当コード: ${e.evidenceCodes.filter((c) => !/not met/i.test(c)).join(', ') || '—'}`)
    out.push('', '■ 自動判定（参考。専門家パネルの分類が優先）',
      `${r.automatic.classification}　合計 ${sgn(r.automatic.points)} 点${r.automatic.provisional ? '（暫定: 評価不可のコードあり）' : ''}`)
    if (r.automatic.notEvaluable.length) out.push(`評価不可: ${r.automatic.notEvaluable.join(', ')}`)
    for (const w of r.automatic.warnings) out.push(`注意: ${w}`)
    out.push('', '■ コードごとの判定')
    for (const c of r.codes) {
      out.push(`- ${c.id}（${c.direction === 'pathogenic' ? '病的' : '良性'}）: ${c.state}${c.counted ? ` / ${c.strength} / ${sgn(c.points)} 点` : ''} — ${c.reason}`)
      if (c.vcepOverride) out.push(`    VCEP: ${c.vcepOverride}`)
      if (c.manualInput) out.push(`    手動入力: ${c.manualInput.met ? '採用' : '不採用'}${c.manualInput.strength ? `（${c.manualInput.strength}）` : ''}`)
      for (const n of c.notes) out.push(`    ${n}`)
    }
    return [...out, '', ...sourceLines(r.sources), ''].join('\n')
  }
  const g = r.region
  const out = [
    ...head,
    '■ CNV',
    `${g.type === 'LOSS' ? '欠失' : '重複'}　chr${g.chrom}:${g.start}-${g.end}（${g.genome}、${(g.end - g.start + 1).toLocaleString()} bp）　コード遺伝子数: ${r.automatic.geneCount ?? '取得失敗'}`, '',
    '■ 自動判定（ACMG/ClinGen CNV 技術標準 2019）',
    `${r.automatic.classification}　合計 ${r.automatic.total} 点${r.automatic.provisional ? '（暫定: 評価不可の項目あり）' : ''}　` + Object.entries(r.automatic.sectionPoints).map(([k, v]) => `${k} ${v}`).join(' / '),
  ]
  if (r.automatic.notEvaluable.length) out.push(`評価不可: ${r.automatic.notEvaluable.join(', ')}`)
  for (const w of r.automatic.warnings) out.push(`注意: ${w}`)
  out.push('', '■ 項目ごとの判定')
  for (const it of r.items) {
    if (!it.counted && it.state === 'manual' && !it.manualInput) continue
    out.push(`- ${it.id}${it.basis ? `（${it.basis}）` : ''}: ${it.state}${it.counted ? ` / ${formatCnvPoints(Math.round(it.points * 100))} 点` : ''} — ${it.reason}`)
    for (const n of it.notes) out.push(`    ${n}`)
  }
  out.push('', `■ 重複する遺伝子（${r.genes.length}）`)
  for (const x of r.genes.filter((y) => y.hi != null || y.ts != null || y.gdv)) out.push(`- ${x.symbol}: HI=${String(x.hi ?? '—')} TS=${String(x.ts ?? '—')} GDV=${x.gdv ?? '—'}`)
  return [...out, '', ...sourceLines(r.sources), ''].join('\n')
}
