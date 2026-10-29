// CNV エンジン：Section 1–3 は自動、Section 4–5 は手動入力。点数は 1/100 点の整数で扱う。
// 閾値・点数・分類境界は rules.ts の宣言を参照する。ネットワークに依存しない純粋関数。
import type { SourceResult } from '../api/http.ts'
import type { DosageEntry, ValidityEntry } from '../data/convert.ts'
import type { DosageFile, ValidityFile } from '../data/reference.ts'
import { overlapBp } from '../data/reference.ts'
import {
  CNV_ITEMS, CNV_TOTAL_CAP, ESTABLISHED_SCORE, GENE_COUNT_TIERS, INTRAGENIC_OPTIONS, SECTION1, classifyCnv, cnvItemsFor,
  type CnvClassTier, type CnvItem, type CnvType, type Section,
} from './rules.ts'

export interface CnvRegion {
  chrom: string
  start: number
  end: number
  type: CnvType
}

export interface GeneInfo {
  symbol: string
  id: string
  start: number
  end: number
  strand: 1 | -1
}

/** 正規転写産物の構造（ゲノム座標、昇順）。 */
export interface GeneStructure {
  symbol: string
  strand: 1 | -1
  start: number
  end: number
  exons: Array<{ start: number; end: number }>
  cdsStart?: number
  cdsEnd?: number
}

export interface CnvEvidence {
  region: CnvRegion
  genes: SourceResult<GeneInfo[]>
  dosageGenes: SourceResult<DosageFile>
  dosageRegions: SourceResult<DosageFile>
  validity: SourceResult<ValidityFile>
  /** 部分重複した確立 HI 遺伝子の構造（キーは大文字シンボル） */
  structures: Record<string, SourceResult<GeneStructure>>
}

export type CnvState = 'met' | 'not_met' | 'not_evaluable' | 'manual'

export interface CnvItemEval {
  id: string
  section: Section
  state: CnvState
  /** 自動判定時の点（1/100 点）。手動項目は既定値 */
  points: number
  reason: string
  notes: string[]
  /** 判定の元になった遺伝子/領域 */
  basis?: string
  /** 同一 ID の複数エントリ（例: 遺伝子ごとの 2C-1）を区別する鍵 */
  key: string
}

export interface CnvManualEntry {
  on?: boolean
  /** 1 件あたりの点（範囲内に丸める）。2E/2I は選択肢の点 */
  points?: number
  n?: number
}
export type CnvManualMap = Record<string, CnvManualEntry>

export interface GeneRow {
  symbol: string
  start: number
  end: number
  hi: number | null | undefined
  ts: number | null | undefined
  /** Gene-Disease Validity の最上位分類（なければ undefined） */
  gdv?: string
  gdvDiseases: number
  /** 領域に完全に含まれるか */
  contained: boolean
}

export interface CnvResult {
  items: CnvItemEval[]
  counted: Array<{ key: string; id: string; section: Section; points: number }>
  sectionPoints: Record<Section, number>
  total: number
  classification: CnvClassTier['label']
  geneCount: number | null
  genes: GeneRow[]
  warnings: string[]
  notEvaluable: string[]
}

// ---------- ヘルパ ----------

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b))
const failed = (r: SourceResult<unknown>) => (r.status === 'failed' ? `${r.source} 取得失敗: ${r.error}` : '')
const norm = (c: string) => c.replace(/^chr/i, '').toUpperCase()
const fmt = (p: number) => (p / 100).toFixed(2)

const GDV_RANK = ['Definitive', 'Strong', 'Moderate', 'Limited', 'Disputed', 'Refuted', 'No Known Disease Relationship']
export function bestGdv(entries: ValidityEntry[]): string | undefined {
  const ranks = entries.map((e) => GDV_RANK.indexOf(e.classification)).filter((i) => i >= 0)
  return ranks.length ? GDV_RANK[Math.min(...ranks)] : undefined
}

type Relation = 'contained' | 'intragenic' | 'left' | 'right'
/** 領域と遺伝子の位置関係。left/right は領域が遺伝子のゲノム上の左端/右端を含む部分重複。 */
export function relation(r: { start: number; end: number }, g: { start: number; end: number }): Relation | null {
  if (overlapBp(r.start, r.end, g.start, g.end) === 0) return null
  const covL = r.start <= g.start
  const covR = r.end >= g.end
  if (covL && covR) return 'contained'
  if (covL) return 'left'
  if (covR) return 'right'
  return 'intragenic'
}

/** 部分重複した HI 遺伝子について 5′/3′ と関与部位から 2C/2D のどれに当たるかを返す。 */
export function classifyPartial(rel: 'left' | 'right', r: { start: number; end: number }, s: GeneStructure): { ids: string[]; primary: string; detail: string } {
  const fivePrime = (rel === 'left') === (s.strand === 1)
  if (fivePrime) {
    const cdsEdge = s.strand === 1 ? s.cdsStart : s.cdsEnd
    const coding = cdsEdge === undefined ? true : s.strand === 1 ? r.end >= cdsEdge : r.start <= cdsEdge
    return coding
      ? { ids: ['2C-1'], primary: '2C-1', detail: '5′ 端の部分重複でコード配列を含む' }
      : { ids: ['2C-2'], primary: '2C-2', detail: '5′ 端の部分重複で 5′UTR のみ' }
  }
  // 3′ 端: 転写方向で並べたとき、重なるエクソンを調べる
  const ordered = s.strand === 1 ? s.exons : [...s.exons].reverse()
  const hit = ordered.map((e, i) => (overlapBp(r.start, r.end, e.start, e.end) > 0 ? i : -1)).filter((i) => i >= 0)
  const last = ordered.length - 1
  if (!hit.length) return { ids: ['2D-1'], primary: '2D-1', detail: '3′ 端の部分重複で 3′UTR のみ' }
  if (hit.every((i) => i === last)) return { ids: ['2D-3', '2D-2'], primary: '2D-3', detail: '最終エクソンのみを含む（同エクソンに既知の病的変異があれば 2D-2）' }
  return { ids: ['2D-4'], primary: '2D-4', detail: `最終エクソン以外（エクソン ${hit.map((i) => i + 1).join(',')}/${ordered.length}）を含み NMD が予想される` }
}

/** Section 1/3 の項目は CNV_ITEMS に無い（自動のみ）ため undefined になりうる。 */
const itemDef = (id: string, type: CnvType): CnvItem | undefined => CNV_ITEMS.find((i) => i.id === id && i.types.includes(type))

function mk(type: CnvType, id: string, p: Partial<CnvItemEval> & { state: CnvState; reason: string; basis?: string }): CnvItemEval {
  const def = itemDef(id, type)
  return { id, section: Number(id[0]) as Section, points: def?.points ?? 0, notes: [], key: p.basis ? `${id}:${p.basis}` : id, ...p }
}

// ---------- 自動判定 ----------

export function autoEvaluateCnv(ev: CnvEvidence): { items: CnvItemEval[]; genes: GeneRow[]; geneCount: number | null } {
  const { region } = ev
  const type = region.type
  const items: CnvItemEval[] = []
  const chrom = norm(region.chrom)

  const dosG = ev.dosageGenes.status === 'ok' ? ev.dosageGenes.data.entries.filter((e) => e.chrom === chrom && overlapBp(e.start, e.end, region.start, region.end) > 0) : null
  const dosR = ev.dosageRegions.status === 'ok' ? ev.dosageRegions.data.entries.filter((e) => e.chrom === chrom && overlapBp(e.start, e.end, region.start, region.end) > 0) : null
  const score = (e: DosageEntry) => (type === 'LOSS' ? e.hi : e.ts)
  const established = (e: DosageEntry) => score(e) === ESTABLISHED_SCORE

  // ---- 遺伝子表 ----
  const genesOk = ev.genes.status === 'ok' ? ev.genes.data : null
  const dosBySym = new Map((ev.dosageGenes.status === 'ok' ? ev.dosageGenes.data.entries : []).map((e) => [e.id.toUpperCase(), e]))
  const rows: GeneRow[] = (genesOk ?? []).map((g) => {
    const d = dosBySym.get(g.symbol.toUpperCase())
    const v = ev.validity.status === 'ok' ? ev.validity.data.byGene[g.symbol.toUpperCase()] ?? [] : []
    return {
      symbol: g.symbol, start: g.start, end: g.end, hi: d ? d.hi : undefined, ts: d ? d.ts : undefined,
      gdv: bestGdv(v), gdvDiseases: v.length, contained: g.start >= region.start && g.end <= region.end,
    }
  })
  const geneCount = genesOk ? new Set(genesOk.map((g) => g.symbol.toUpperCase())).size : null

  // ---- Section 1 ----
  const hasElements = (geneCount ?? 0) > 0 || (dosG?.length ?? 0) > 0 || (dosR?.length ?? 0) > 0
  if (geneCount === null && !dosG?.length && !dosR?.length) {
    items.push(mk(type, SECTION1.has.id, { state: 'not_evaluable', reason: `${failed(ev.genes)}。遺伝子内容を確認できないため 1A/1B を判定できません`, points: 0, key: '1' }))
  } else if (hasElements) {
    items.push(mk(type, SECTION1.has.id, { state: 'met', reason: `タンパク質コード遺伝子/ClinGen 登録領域を含む（遺伝子 ${geneCount ?? '不明'}）`, points: SECTION1.has.points, key: '1' }))
  } else {
    items.push(mk(type, SECTION1.none.id, { state: 'met', reason: 'タンパク質コード遺伝子・ClinGen 登録領域を含まない', points: SECTION1.none.points, key: '1' }))
  }

  // ---- Section 2：領域 ----
  const regSrc = ev.dosageRegions.status === 'ok' ? `ClinGen Dosage 領域 ${ev.dosageRegions.data.meta.version ?? ''}` : undefined
  if (!dosR) {
    items.push(mk(type, '2A', { state: 'not_evaluable', reason: failed(ev.dosageRegions), points: 0, basis: 'region' }))
  } else {
    for (const e of dosR.filter(established)) {
      const contained = e.start >= region.start && e.end <= region.end
      const label = `${e.id} ${e.name ?? ''} (${e.band})`
      items.push(contained
        ? mk(type, '2A', { state: 'met', reason: `確立した${type === 'LOSS' ? 'HI' : 'TS'}領域を完全に含む: ${label}`, basis: e.id, notes: regSrc ? [regSrc] : [] })
        : mk(type, '2B', { state: 'met', reason: `確立した領域に部分的に重なる: ${label}（原因遺伝子が含まれるかは遺伝子単位の結果を参照）`, basis: e.id, points: 0 }))
    }
  }

  // ---- Section 2：遺伝子 ----
  const geneSrc = ev.dosageGenes.status === 'ok' ? `ClinGen Dosage 遺伝子 ${ev.dosageGenes.data.meta.version ?? ''}` : undefined
  if (!dosG) {
    items.push(mk(type, '2A', { state: 'not_evaluable', reason: failed(ev.dosageGenes), points: 0, basis: 'gene' }))
  } else {
    const hiGenes = dosG.filter(established)
    for (const g of hiGenes) {
      const rel = relation(region, g)!
      const sym = g.id
      if (rel === 'contained') {
        items.push(mk(type, '2A', { state: 'met', reason: `確立した${type === 'LOSS' ? 'HI' : 'TS'}遺伝子 ${sym} を完全に含む`, basis: sym, notes: geneSrc ? [geneSrc] : [] }))
        continue
      }
      if (type === 'GAIN') {
        // GAIN の TS 遺伝子の部分重複は 2B（0 点）
        items.push(mk(type, '2B', { state: 'met', reason: `TS 遺伝子 ${sym} と部分的に重なる`, basis: sym, points: 0 }))
        continue
      }
      if (rel === 'intragenic') {
        items.push(mk(type, '2E', { state: 'manual', reason: `HI 遺伝子 ${sym} の遺伝子内欠失（両切断点が遺伝子内）。PVS1 の仕様で採点してください`, basis: sym, notes: ['読み枠・NMD・影響エクソンの重要性を確認し、下の選択肢から選択'] }))
        continue
      }
      const st = ev.structures[sym.toUpperCase()]
      if (!st || st.status === 'failed') {
        items.push(mk(type, '2C-1', { state: 'not_evaluable', reason: `HI 遺伝子 ${sym} に部分重複しますが、${st ? failed(st) : '遺伝子構造を取得していない'}ため 2C/2D を判定できません`, points: 0, basis: sym }))
        continue
      }
      const c = classifyPartial(rel, region, st.data)
      for (const id of c.ids) {
        const primary = id === c.primary
        items.push(mk(type, id, {
          state: primary ? 'met' : 'not_met', basis: sym, reason: `${sym}: ${c.detail}`,
          notes: [primary ? '座標からの自動判定。正規転写産物で判定しているため、他の転写産物・既知の病的変異の有無は要確認' : '代替の選択肢（該当する場合は手動で採用）'],
        }))
      }
    }
    // HI 遺伝子の 2H / 2J / 2K （GAIN）
    if (type === 'GAIN') {
      const hi = dosG.filter((e) => e.hi === ESTABLISHED_SCORE)
      for (const g of hi) {
        const rel = relation(region, g)!
        const sym = g.id
        if (rel === 'contained') items.push(mk(type, '2H', { state: 'met', reason: `HI 遺伝子 ${sym} を完全に含む（増幅では 0 点）`, basis: sym, points: 0 }))
        else if (rel === 'intragenic') items.push(mk(type, '2I', { state: 'manual', reason: `${sym} の遺伝子内重複（両切断点が遺伝子内）。PVS1 の仕様で採点してください`, basis: sym }))
        else {
          items.push(mk(type, '2J', { state: 'met', reason: `切断点の 1 つが HI 遺伝子 ${sym} 内。表現型が LoF と不整合/不明なら 0 点`, basis: sym, points: 0 }))
          items.push(mk(type, '2K', { state: 'manual', reason: `${sym}: 表現型が高度に特異的で LoF と整合する場合は 0.45`, basis: sym }))
        }
      }
    }
  }

  // ---- Section 3 ----
  if (geneCount === null) {
    items.push(mk(type, '3A', { state: 'not_evaluable', reason: `${failed(ev.genes)}。遺伝子数を数えられません`, points: 0, key: '3' }))
  } else {
    const tier = GENE_COUNT_TIERS[type].find((t) => geneCount >= t.min)!
    items.push(mk(type, tier.id, { state: 'met', reason: `タンパク質コード遺伝子 ${geneCount} 個`, points: tier.points, key: '3', notes: ['Ensembl の protein_coding 遺伝子を数えています（論文は RefSeq 遺伝子。差が出る場合があります）'] }))
  }

  return { items, genes: rows, geneCount }
}

// ---------- 採点 ----------

/** 常に入力欄を出す手動項目。2K は遺伝子ごとに自動側から生成するため除く。 */
const MANUAL_DEFAULT_EVALS = (type: CnvType): CnvItemEval[] =>
  cnvItemsFor(type).filter((i) => i.mode === 'manual' && i.id !== '2K')
    .map((i) => ({ id: i.id, section: i.section, state: 'manual' as const, points: i.points, reason: '', notes: [], key: i.id }))

export function allManualItems(type: CnvType): CnvItemEval[] {
  return MANUAL_DEFAULT_EVALS(type)
}

export function scoreCnv(ev: CnvEvidence, auto: { items: CnvItemEval[]; genes: GeneRow[]; geneCount: number | null }, manual: CnvManualMap = {}): CnvResult {
  const type = ev.region.type
  const items = [...auto.items, ...MANUAL_DEFAULT_EVALS(type).filter((m) => !auto.items.some((a) => a.key === m.key))]
  const counted: CnvResult['counted'] = []
  const sec: Record<Section, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const warnings: string[] = []

  let s2Positive = 0
  let s2Other = 0
  for (const it of items) {
    const def = itemDef(it.id, type)
    const m = manual[it.key]
    const on = m?.on ?? it.state === 'met'
    if (!on || it.state === 'not_evaluable') continue
    let p = def ? clamp(m?.points ?? it.points, def.min, def.max) : it.points
    if (def?.perUnit) {
      const n = Math.max(0, Math.floor(m?.n ?? 1))
      const cap = CNV_TOTAL_CAP[it.id]
      p = p * n
      if (cap !== undefined) p = Math.sign(p) * Math.min(Math.abs(p), cap)
    }
    counted.push({ key: it.key, id: it.id, section: it.section, points: p })
    if (it.section === 2) {
      // 病的方向の Section 2 は最も当てはまる 1 つ（最大）を採用。良性・2H は加算
      const exclusivePositive = ['2A', '2C-1', '2C-2', '2D-1', '2D-2', '2D-3', '2D-4', '2E', '2I', '2K'].includes(it.id)
      if (exclusivePositive) s2Positive = Math.max(s2Positive, p)
      else s2Other += p
    } else sec[it.section] += p
  }
  sec[2] = s2Positive + s2Other
  const total = sec[1] + sec[2] + sec[3] + sec[4] + sec[5]
  const notEvaluable = [...new Set(items.filter((i) => i.state === 'not_evaluable').map((i) => i.id))]
  if (notEvaluable.length) warnings.push(`評価不可の項目（${notEvaluable.join(', ')}）があるため、この分類は暫定です`)
  if (sec[4] !== 0 && sec[5] !== 0) warnings.push('Section 4 と Section 5 の両方に点が入っています。論文では同一症例の二重計上に注意が必要です')
  if (counted.some((c) => c.points > 0 && c.section === 2) && counted.some((c) => c.points < 0 && c.section === 2)) warnings.push('Section 2 に病的方向と良性方向の項目が併存しています。内容を確認してください')
  if (auto.geneCount === null) warnings.push('遺伝子数を取得できていません（Section 1/3 は評価不可）')
  return {
    items, counted, sectionPoints: sec, total, classification: classifyCnv(total), geneCount: auto.geneCount, genes: auto.genes, warnings, notEvaluable,
  }
}

export function evaluateCnv(ev: CnvEvidence, manual: CnvManualMap = {}): CnvResult {
  return scoreCnv(ev, autoEvaluateCnv(ev), manual)
}

export { fmt as formatCnvPoints, INTRAGENIC_OPTIONS }
