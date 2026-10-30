// 同梱した参照データへのアクセス。JSON は動的 import で別チャンクにし、初期表示を重くしない。
import type { SourceResult } from '../api/http.ts'
import type { CSpecDoc, DataMeta, DosageEntry, ValidityEntry } from './convert.ts'
import type { Genome } from '../input/parseInput.ts'

export interface DosageFile { meta: DataMeta; entries: DosageEntry[] }
export interface ValidityFile { meta: DataMeta; byGene: Record<string, ValidityEntry[]> }
export interface CSpecFile { meta: DataMeta; byGene: Record<string, string[]>; specs: CSpecDoc[] }

async function load<T extends { meta: DataMeta }>(source: string, path: string, importer: () => Promise<{ default: unknown }>): Promise<SourceResult<T>> {
  const fetchedAt = new Date().toISOString()
  try {
    const data = (await importer()).default as T
    return { status: 'ok', source, url: path, fetchedAt, data }
  } catch (e) {
    return { status: 'failed', source, url: path, fetchedAt, error: e instanceof Error ? e.message : String(e) }
  }
}

export const loadDosageGenes = (g: Genome) =>
  load<DosageFile>('ClinGen Dosage (gene)', `dosage-gene-${g}.json`, () =>
    g === 'GRCh38' ? import('./generated/dosage-gene-GRCh38.json', { with: { type: 'json' } }) : import('./generated/dosage-gene-GRCh37.json', { with: { type: 'json' } }))

export const loadDosageRegions = (g: Genome) =>
  load<DosageFile>('ClinGen Dosage (region)', `dosage-region-${g}.json`, () =>
    g === 'GRCh38' ? import('./generated/dosage-region-GRCh38.json', { with: { type: 'json' } }) : import('./generated/dosage-region-GRCh37.json', { with: { type: 'json' } }))

export const loadValidity = () =>
  load<ValidityFile>('ClinGen Gene-Disease Validity', 'gene-validity.json', () => import('./generated/gene-validity.json', { with: { type: 'json' } }))

export const loadCSpec = () =>
  load<CSpecFile>('ClinGen CSpec Registry', 'cspec.json', () => import('./generated/cspec.json', { with: { type: 'json' } }))

// ---- 検索ヘルパ（純粋関数） ----

export const dosageForGene = (f: DosageFile, symbol: string): DosageEntry | undefined =>
  f.entries.find((e) => e.id === symbol.toUpperCase())

export const validityForGene = (f: ValidityFile, symbol: string): ValidityEntry[] => f.byGene[symbol.toUpperCase()] ?? []

/** 遺伝子に適用される VCEP 特殊化（複数ありうる）。 */
export const cspecForGene = (f: CSpecFile, symbol: string): CSpecDoc[] => {
  const ids = f.byGene[symbol.toUpperCase()] ?? []
  return f.specs.filter((s) => ids.includes(s.id))
}

/** [start,end]（両端含む）が [qs,qe] と重なる bp 数。重ならなければ 0。 */
export const overlapBp = (start: number, end: number, qs: number, qe: number): number =>
  Math.max(0, Math.min(end, qe) - Math.max(start, qs) + 1)

/** 指定区間と重なる Dosage エントリ（遺伝子 or 領域）を、重なり bp 付きで返す。 */
export function findOverlaps(f: DosageFile, chrom: string, qs: number, qe: number): Array<{ entry: DosageEntry; overlap: number; contained: boolean }> {
  const c = chrom.replace(/^chr/i, '').toUpperCase()
  return f.entries
    .filter((e) => e.chrom === c)
    .map((entry) => ({ entry, overlap: overlapBp(entry.start, entry.end, qs, qe), contained: entry.start >= qs && entry.end <= qe }))
    .filter((x) => x.overlap > 0)
}
