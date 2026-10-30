// 可視化用の Ensembl REST: 転写産物のエクソン構造・タンパク質ドメイン・染色体バンド。
import { createRateLimiter, wrapSource, type HttpOptions, type SourceResult } from './http.ts'
import { ENSEMBL_BASE, type Genome } from './vep.ts'

const acquire = createRateLimiter(100)
/** 可視化は補助情報。Ensembl の 429 は CORS ヘッダが無く通信失敗に見えるため、長めのバックオフで再試行する。 */
const RETRY: HttpOptions = { timeoutMs: 30000, maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 8000 }

export interface Exon { start: number; end: number }
export interface ProteinFeature { db: string; name: string; start: number; end: number }

export interface TranscriptView {
  transcriptId: string
  strand: 1 | -1
  /** ゲノム座標昇順 */
  exons: Exon[]
  /** CDS のゲノム座標（非コード転写産物は undefined） */
  cdsStart?: number
  cdsEnd?: number
  proteinId?: string
  proteinLength?: number
  features: ProteinFeature[]
}

/** 表示対象のドメイン DB（PM1 の判定と同じ範囲） */
export const DOMAIN_TYPES = ['Pfam', 'Prosite_profiles', 'SMART', 'Smart']

export function parseTranscript(raw: unknown): Omit<TranscriptView, 'features'> {
  const t = raw as {
    id?: string; strand?: number
    Exon?: Array<{ start: number; end: number }>
    Translation?: { id?: string; start?: number; end?: number; length?: number }
  }
  if (!t?.Exon?.length) throw new Error('Ensembl: エクソン情報がありません')
  return {
    transcriptId: t.id ?? '',
    strand: t.strand === -1 ? -1 : 1,
    exons: t.Exon.map((e) => ({ start: e.start, end: e.end })).sort((a, b) => a.start - b.start),
    cdsStart: t.Translation?.start,
    cdsEnd: t.Translation?.end,
    proteinId: t.Translation?.id,
    proteinLength: t.Translation?.length,
  }
}

export function parseFeatures(raw: unknown): ProteinFeature[] {
  if (!Array.isArray(raw)) throw new Error('Ensembl: タンパク質ドメインの形式が不正です')
  return (raw as Array<{ type?: string; id?: string; description?: string; start: number; end: number }>)
    .filter((f) => f.type && DOMAIN_TYPES.includes(f.type))
    .map((f) => ({ db: f.type!, name: f.description || f.id || f.type!, start: f.start, end: f.end }))
    .sort((a, b) => a.start - b.start)
}

/** エクソン構造は必須、ドメインは取れなくても構造だけ返す（ドメイン取得失敗は features 空 + domainError）。 */
export async function fetchTranscriptView(
  transcriptId: string, genome: Genome, opts?: HttpOptions,
): Promise<SourceResult<TranscriptView & { domainError?: string }>> {
  const base = ENSEMBL_BASE[genome]
  const id = transcriptId.split('.')[0]
  await acquire()
  const url = `${base}/lookup/id/${encodeURIComponent(id)}?expand=1;content-type=application/json`
  const tr = await wrapSource('Ensembl lookup (transcript)', url, { ...RETRY, ...opts }, parseTranscript)
  if (tr.status === 'failed') return tr
  if (!tr.data.proteinId) return { ...tr, data: { ...tr.data, features: [] } }
  await acquire()
  const fr = await wrapSource('Ensembl protein features', `${base}/overlap/translation/${tr.data.proteinId}?feature=protein_feature;content-type=application/json`, { ...RETRY, ...opts }, parseFeatures)
  return fr.status === 'ok'
    ? { ...tr, data: { ...tr.data, features: fr.data } }
    : { ...tr, data: { ...tr.data, features: [], domainError: fr.error } }
}

export interface CytoBand { name: string; start: number; end: number; stain: string }
export interface ChromosomeView { chrom: string; length: number; bands: CytoBand[] }

export function parseBands(raw: unknown, chrom: string): ChromosomeView {
  const r = raw as { length?: number; karyotype_band?: Array<{ id: string; start: number; end: number; stain?: string }> }
  if (!r?.length) throw new Error('Ensembl: 染色体長を取得できません')
  return {
    chrom, length: r.length,
    bands: (r.karyotype_band ?? []).map((b) => ({ name: b.id, start: b.start, end: b.end, stain: b.stain ?? '' })).sort((a, b) => a.start - b.start),
  }
}

export async function fetchChromosome(chrom: string, genome: Genome, opts?: HttpOptions): Promise<SourceResult<ChromosomeView>> {
  await acquire()
  const url = `${ENSEMBL_BASE[genome]}/info/assembly/homo_sapiens/${encodeURIComponent(chrom)}?bands=1;content-type=application/json`
  return wrapSource('Ensembl cytobands', url, { ...RETRY, ...opts }, (raw) => parseBands(raw, chrom))
}
