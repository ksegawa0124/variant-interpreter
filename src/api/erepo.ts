// ClinGen Evidence Repository (ERepo): 専門家パネル（VCEP 等）による分類の照合。
// CORS: Access-Control-Allow-Origin: * を確認済み。caid で直接引ける。
import { wrapSource, type HttpOptions, type SourceResult } from './http.ts'

export const EREPO_BASE = 'https://erepo.genome.network/evrepo/api'

export type ErepoClass = 'Pathogenic' | 'Likely Pathogenic' | 'VUS' | 'Likely Benign' | 'Benign'

export interface ErepoEvidenceCode {
  label: string
  /** "Met" / "Not Met" / "Supporting" など ERepo の表記そのまま */
  status: string
}

export interface ErepoClassification {
  caid: string
  /** ERepo の分類表記そのまま（例: "Uncertain Significance"） */
  outcomeLabel: string
  /** 内部表記へ正規化した分類。解釈できなければ undefined */
  classification?: ErepoClass
  condition?: string
  /** 分類した専門家パネル（例: "TP53 VCEP"） */
  panel?: string
  guideline?: string
  guidelineVersion?: string
  cspecId?: string
  evidenceCodes: ErepoEvidenceCode[]
  publishedDate?: string
  /** ERepo 上の解釈レコード URL */
  url?: string
  /** ERepo 側が付けた警告（ClinVar との不一致など） */
  warnings: string[]
}

const OUTCOME: Record<string, ErepoClass> = {
  pathogenic: 'Pathogenic',
  'likely pathogenic': 'Likely Pathogenic',
  'uncertain significance': 'VUS',
  'likely benign': 'Likely Benign',
  benign: 'Benign',
}

export const normalizeOutcome = (label: string | undefined): ErepoClass | undefined => (label ? OUTCOME[label.trim().toLowerCase()] : undefined)

const stripCar = (s: string) => s.replace(/^CAR:/, '')

interface RawInterp {
  caid?: string
  condition?: { label?: string }
  publishedDate?: string
  '@id'?: string
  warnings?: Array<{ warningId?: { properties?: { msg?: { value?: string } } } }>
  guidelines?: Array<{
    label?: string
    version?: string
    cspecId?: string
    outcome?: { label?: string }
    agents?: Array<{ affiliation?: string; evidenceCodes?: Array<{ label?: string; status?: string }> }>
  }>
}

/** ERepo の応答から、指定 CAid の分類だけを取り出す（同一アレルに複数疾患・複数パネルがありうる）。 */
export function parseErepo(raw: unknown, caid: string): ErepoClassification[] {
  const list = (raw as { variantInterpretations?: RawInterp[] } | null)?.variantInterpretations
  if (!Array.isArray(list)) throw new Error('ERepo: 応答の形式が不正です')
  const out: ErepoClassification[] = []
  for (const v of list) {
    if (!v.caid || stripCar(v.caid) !== caid) continue
    for (const g of v.guidelines ?? []) {
      const agent = g.agents?.[0]
      const label = g.outcome?.label ?? ''
      out.push({
        caid,
        outcomeLabel: label,
        classification: normalizeOutcome(label),
        condition: v.condition?.label,
        panel: agent?.affiliation,
        guideline: g.label,
        guidelineVersion: g.version,
        cspecId: g.cspecId,
        evidenceCodes: (agent?.evidenceCodes ?? []).map((c) => ({ label: c.label ?? '', status: c.status ?? '' })),
        publishedDate: v.publishedDate,
        url: v['@id'],
        warnings: (v.warnings ?? []).map((w) => w.warningId?.properties?.msg?.value ?? '').filter(Boolean),
      })
    }
  }
  return out
}

/** 該当なしは空配列（= ERepo に専門家分類なし）。通信失敗は failed。 */
export function fetchErepo(caid: string, opts: HttpOptions = {}): Promise<SourceResult<ErepoClassification[]>> {
  const url = `${EREPO_BASE}/classifications?matchMode=exact&caid=${encodeURIComponent(caid)}`
  return wrapSource('ClinGen Evidence Repository', url, { timeoutMs: 30000, ...opts }, (raw) => parseErepo(raw, caid))
}

export interface ErepoComparison {
  match: boolean
  /** 一致/不一致の説明（日本語） */
  message: string
}

/** 3 段階（P/LP→病的側、B/LB→良性側、VUS）での方向一致も別に返す。 */
const side = (c: ErepoClass) => (c === 'Pathogenic' || c === 'Likely Pathogenic' ? 'P' : c === 'Benign' || c === 'Likely Benign' ? 'B' : 'V')

export function compareWithAuto(erepo: ErepoClass | undefined, auto: ErepoClass): ErepoComparison & { sameDirection: boolean } {
  if (!erepo) return { match: false, sameDirection: false, message: 'ERepo の分類を解釈できません' }
  if (erepo === auto) return { match: true, sameDirection: true, message: '専門家パネルの分類と一致しています' }
  const sameDirection = side(erepo) === side(auto)
  return {
    match: false,
    sameDirection,
    message: sameDirection
      ? '専門家パネルの分類と強さが異なります（方向は同じ）'
      : '専門家パネルの分類と自動判定が食い違っています。専門家パネルの分類を優先してください',
  }
}
