// ClinGen 参照データ（TSV / CSV / CSpec JSON）→ アプリ同梱用 JSON への変換。
// ネットワークに依存しない純粋関数。取得は scripts/build-reference-data.ts が担う。

export interface DataMeta {
  source: string
  url: string
  /** 取得日時（ISO）。レポートに必ず記録する。 */
  fetchedAt: string
  /** 配布元が示す版・日付（例: Dosage の "2026-10-29"）。不明なら null。 */
  version: string | null
  assembly?: 'GRCh38' | 'GRCh37'
  count: number
}

// ---------- Dosage Sensitivity (gene / region) ----------

export interface DosageEntry {
  /** 遺伝子: HGNC シンボル。領域: ISCA ID */
  id: string
  /** 領域のみ */
  name?: string
  /** 遺伝子のみ（NCBI Gene ID） */
  geneId?: string
  band: string
  chrom: string
  start: number
  end: number
  /** 0,1,2,3 / 30(AR) / 40(unlikely)。未評価は null */
  hi: number | null
  ts: number | null
  hiPmids: string[]
  tsPmids: string[]
  /** 最終評価日 */
  date: string | null
  hiDisease: string | null
  tsDisease: string | null
}

const ROW_ID_COLUMNS = ['Gene Symbol', 'ISCA ID']

function score(v: string | undefined): number | null {
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null // "Not yet evaluated" は null
}

/** "#29 Oct,2026" 形式の配布日を ISO 日付へ。 */
export function parseDosageReleaseDate(text: string): string | null {
  const m = /^#\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*,\s*(\d{4})/m.exec(text)
  if (!m) return null
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase())
  if (mon < 0) return null
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

export function parseDosageTsv(text: string): DosageEntry[] {
  const lines = text.split(/\r?\n/)
  const headerLine = lines.find((l) => l.startsWith('#') && l.includes('Haploinsufficiency Score'))
  if (!headerLine) throw new Error('Dosage TSV: ヘッダー行が見つかりません')
  const cols = headerLine.replace(/^#/, '').split('\t')
  const idx = (name: string) => cols.indexOf(name)
  const iId = cols.findIndex((c) => ROW_ID_COLUMNS.includes(c))
  const iHi = idx('Haploinsufficiency Score')
  const iTs = idx('Triplosensitivity Score')
  if (iId < 0 || iHi < 0 || iTs < 0) throw new Error('Dosage TSV: 必須列がありません')
  const pmids = (f: string[], first: string) => {
    const s = idx(first)
    return s < 0 ? [] : f.slice(s, s + 6).filter(Boolean)
  }
  const out: DosageEntry[] = []
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const f = line.split('\t')
    const loc = /^chr([0-9XYM]+):(\d+)-(\d+)$/i.exec(f[idx('Genomic Location')] ?? '')
    if (!loc) continue // 座標が無い行（未マップ）は CNV 重複判定に使えないため除外
    out.push({
      id: f[iId],
      name: idx('ISCA Region Name') >= 0 ? f[idx('ISCA Region Name')] : undefined,
      geneId: idx('Gene ID') >= 0 ? f[idx('Gene ID')] : undefined,
      band: f[idx('cytoBand')] ?? '',
      chrom: loc[1].toUpperCase(),
      start: Number(loc[2]),
      end: Number(loc[3]),
      hi: score(f[iHi]),
      ts: score(f[iTs]),
      hiPmids: pmids(f, 'Haploinsufficiency PMID1'),
      tsPmids: pmids(f, 'Triplosensitivity PMID1'),
      date: f[idx('Date Last Evaluated')] || null,
      hiDisease: f[idx('Haploinsufficiency Disease ID')] || null,
      tsDisease: f[idx('Triplosensitivity Disease ID')] || null,
    })
  }
  return out
}

// ---------- Gene-Disease Validity ----------

export interface ValidityEntry {
  disease: string
  mondo: string
  moi: string
  sop: string
  classification: string
  /** gene-validity 評価の ID（URL は GDV_REPORT_BASE + report） */
  report: string
  date: string
  gcep: string
}

export const GDV_REPORT_BASE = 'https://search.clinicalgenome.org/kb/gene-validity/'

/** 引用符・カンマ入り・改行入りフィールドに対応した最小 CSV パーサ。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cur)
      cur = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      cur = ''
      rows.push(row)
      row = []
    } else cur += c
  }
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

export function parseValidityCsv(text: string): { byGene: Record<string, ValidityEntry[]>; fileDate: string | null } {
  const rows = parseCsv(text)
  const fileDate = /FILE CREATED:\s*(\d{4}-\d{2}-\d{2})/.exec(rows.map((r) => r[0]).join('\n'))?.[1] ?? null
  const h = rows.findIndex((r) => r[0] === 'GENE SYMBOL')
  if (h < 0) throw new Error('Gene-Disease Validity CSV: ヘッダー行が見つかりません')
  const col = (n: string) => rows[h].indexOf(n)
  const [iG, iD, iM, iMoi, iSop, iCl, iUrl, iDate, iGcep] = [
    'GENE SYMBOL', 'DISEASE LABEL', 'DISEASE ID (MONDO)', 'MOI', 'SOP', 'CLASSIFICATION', 'ONLINE REPORT', 'CLASSIFICATION DATE', 'GCEP',
  ].map(col)
  if ([iG, iD, iM, iMoi, iCl, iUrl].some((i) => i < 0)) throw new Error('Gene-Disease Validity CSV: 必須列がありません')
  const byGene: Record<string, ValidityEntry[]> = {}
  for (const r of rows.slice(h + 1)) {
    if (!r[iG] || r[iG].startsWith('+')) continue
    ;(byGene[r[iG]] ??= []).push({
      disease: r[iD],
      mondo: r[iM],
      moi: r[iMoi],
      sop: r[iSop] ?? '',
      classification: r[iCl],
      report: r[iUrl].startsWith(GDV_REPORT_BASE) ? r[iUrl].slice(GDV_REPORT_BASE.length) : r[iUrl],
      date: (r[iDate] ?? '').slice(0, 10),
      gcep: r[iGcep] ?? '',
    })
  }
  return { byGene, fileDate }
}

// ---------- CSpec (VCEP criteria specifications) ----------

export interface CSpecIndexEntry {
  id: string // GN021 等
  affiliation: string
  version: string
  status: string
  url: string
  genes: string[]
}

export function parseCSpecIndex(raw: unknown): CSpecIndexEntry[] {
  const data = (raw as { data?: any[] }).data // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!Array.isArray(data)) throw new Error('CSpec: svis 一覧の形式が不正です')
  return data.map((d) => ({
    id: String(d['@id']).split('/').pop() as string,
    affiliation: d.affiliation?.label ?? '',
    version: String(d.version ?? ''),
    status: String(d.status ?? ''),
    url: d.url ?? '',
    genes: [...new Set<string>((d.ruleSets ?? []).flatMap((rs: any) => (rs.genes ?? []).map((g: any) => g.label)))], // eslint-disable-line @typescript-eslint/no-explicit-any
  }))
}

export interface CSpecStrength {
  label: string
  applicability: string
  description?: string
}

export interface CSpecCode {
  description: string
  /** applicability が Applicable 系の強度のみ。空なら、この VCEP では適用不可（Not Applicable）。 */
  strengths: CSpecStrength[]
  /** 説明文中の割合・頻度らしき数値（未検証の手掛かり。閾値は人が確認すること） */
  thresholdHints: string[]
}

export interface CSpecDoc {
  id: string
  label: string
  version: string
  status: string
  lastUpdated: string
  affiliation: string
  url: string
  /** key: PVS1, BA1 等。genes ごとに ruleSet が分かれる場合は gene をキーにする */
  ruleSets: Array<{ genes: string[]; codes: Record<string, CSpecCode> }>
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 説明文から 5%, 0.00002, 1e-5 のような数値表現を拾う（意味解釈はしない）。 */
export function extractThresholdHints(text: string): string[] {
  const hits = text.match(/\d+(?:\.\d+)?\s*%|\b0\.\d{2,}\b|\b\d(?:\.\d+)?\s*[x×]\s*10\s*[-−–]\s*\d+|\b\d(?:\.\d+)?e-\d+\b/gi) ?? []
  return [...new Set(hits.map((h) => h.replace(/\s+/g, '')))]
}

export function parseCSpecDoc(raw: unknown): CSpecDoc {
  const d = raw as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = String(d['@id'] ?? '').split('/').pop() as string
  if (!/^GN\d+$/.test(id)) throw new Error('CSpec: 文書 ID を解釈できません')
  return {
    id,
    label: squash(d.label ?? ''),
    version: String(d.version ?? ''),
    status: String(d.currentStatus ?? d.cspecStatus ?? ''),
    lastUpdated: d.lastUpdated ?? '',
    affiliation: d.affiliation?.label ?? '',
    url: `https://cspec.genome.network/cspec/ui/svi/doc/${id}`,
    ruleSets: (d.ruleSets ?? []).map((rs: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      genes: (rs.genes ?? []).map((g: any) => g.label), // eslint-disable-line @typescript-eslint/no-explicit-any
      codes: Object.fromEntries(
        (rs.criteriaCodes ?? []).map((c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const strengths: CSpecStrength[] = (c.evidenceStrengths ?? [])
            .filter((s: any) => /^applicable/i.test(s.applicability ?? '')) // eslint-disable-line @typescript-eslint/no-explicit-any
            .map((s: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
              label: s.label,
              applicability: s.applicability,
              ...(s.description ? { description: squash(s.description) } : {}),
            }))
          const description = squash(c.description ?? '')
          const hintSrc = [description, ...strengths.map((s) => s.description ?? '')].join(' ')
          return [c.label, { description, strengths, thresholdHints: extractThresholdHints(hintSrc) }]
        }),
      ),
    })),
  }
}
