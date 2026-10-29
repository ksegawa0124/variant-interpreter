// CNV 入力 → Ensembl（遺伝子一覧・遺伝子構造）+ 同梱 ClinGen データ → CnvEvidence
import { createRateLimiter, wrapSource, type SourceResult } from '../api/http.ts'
import { ENSEMBL_BASE, fetchEnsemblRelease } from '../api/vep.ts'
import { loadDosageGenes, loadDosageRegions, loadValidity } from '../data/reference.ts'
import { normalizeChrom, type Genome, type ParsedInput } from '../input/parseInput.ts'
import type { SourceRecord } from '../engine/gather.ts'
import { ESTABLISHED_SCORE } from './rules.ts'
import { relation, type CnvEvidence, type CnvRegion, type GeneInfo, type GeneStructure } from './engine.ts'

const acquire = createRateLimiter(100)
/** Ensembl overlap エンドポイントの上限は 5 Mb。余裕を見て分割する。 */
export const MAX_SPAN = 4_900_000

export function toCnvRegion(p: ParsedInput, selected: Genome): { region: CnvRegion; genome: Genome } | { error: string } {
  if (p.kind === 'cnv') {
    const c = normalizeChrom(p.chrom)
    return c ? { region: { chrom: c, start: p.start, end: p.end, type: p.cnvType === 'DEL' ? 'LOSS' : 'GAIN' }, genome: selected } : { error: `染色体を解釈できません: ${p.chrom}` }
  }
  if (p.kind === 'iscn') {
    const c = normalizeChrom(p.chrom)
    return c ? { region: { chrom: c, start: p.start, end: p.end, type: p.cnvType === 'DEL' ? 'LOSS' : 'GAIN' }, genome: p.genome } : { error: `染色体を解釈できません: ${p.chrom}` }
  }
  if (p.kind === 'hgvs_g') {
    const m = /^(\d+)(?:_(\d+))?(del|dup)$/i.exec(p.description)
    if (!m) return { error: 'HGVS.g の del/dup 座標を解釈できません' }
    const start = Number(m[1])
    return { region: { chrom: p.chrom, start, end: m[2] ? Number(m[2]) : start, type: m[3].toLowerCase() === 'del' ? 'LOSS' : 'GAIN' }, genome: p.genome ?? selected }
  }
  return { error: 'CNV として扱える入力ではありません' }
}

const CLONE_NAME = /^(A[CLP]\d{6}|CT[ABCD]-|RP\d+-|CU\d{6})/

type Raw =Array<{ id: string; external_name?: string; start: number; end: number; strand: number; biotype?: string }>

export function parseGenes(raw: unknown): GeneInfo[] {
  if (!Array.isArray(raw)) throw new Error('Ensembl: 遺伝子一覧の形式が不正です')
  return (raw as Raw)
    // クローン由来の仮想名（AC006547.14 等）は RefSeq 遺伝子ではないため数えない
    .filter((g) => g.external_name && g.biotype === 'protein_coding' && !CLONE_NAME.test(g.external_name))
    .map((g) => ({ symbol: g.external_name!, id: g.id, start: g.start, end: g.end, strand: g.strand === -1 ? -1 : 1 }))
}

export function parseStructure(raw: unknown): GeneStructure {
  const g = raw as {
    display_name?: string; start: number; end: number; strand: number
    Transcript?: Array<{ is_canonical?: number; Exon?: Array<{ start: number; end: number }>; Translation?: { start: number; end: number } }>
  }
  const t = g.Transcript?.find((x) => x.is_canonical === 1) ?? g.Transcript?.[0]
  if (!t?.Exon?.length) throw new Error('Ensembl: 転写産物の構造がありません')
  return {
    symbol: g.display_name ?? '', strand: g.strand === -1 ? -1 : 1, start: g.start, end: g.end,
    exons: t.Exon.map((e) => ({ start: e.start, end: e.end })).sort((a, b) => a.start - b.start),
    cdsStart: t.Translation?.start, cdsEnd: t.Translation?.end,
  }
}

async function fetchGenes(r: CnvRegion, genome: Genome): Promise<SourceResult<GeneInfo[]>> {
  const fetchedAt = new Date().toISOString()
  const url0 = `${ENSEMBL_BASE[genome]}/overlap/region/human/${r.chrom}:${r.start}-${r.end}?feature=gene`
  const chunks: Array<[number, number]> = []
  for (let s = r.start; s <= r.end; s += MAX_SPAN) chunks.push([s, Math.min(r.end, s + MAX_SPAN - 1)])
  const all: GeneInfo[] = []
  for (const [s, e] of chunks) {
    await acquire()
    const url = `${ENSEMBL_BASE[genome]}/overlap/region/human/${r.chrom}:${s}-${e}?feature=gene;content-type=application/json`
    const res = await wrapSource('Ensembl overlap (genes)', url, { timeoutMs: 60000 }, parseGenes)
    if (res.status === 'failed') return res
    all.push(...res.data)
  }
  const byId = new Map(all.map((g) => [g.id, g]))
  return { status: 'ok', source: 'Ensembl overlap (genes)', url: url0, fetchedAt, data: [...byId.values()].sort((a, b) => a.start - b.start) }
}

async function fetchStructure(symbol: string, genome: Genome): Promise<SourceResult<GeneStructure>> {
  await acquire()
  const url = `${ENSEMBL_BASE[genome]}/lookup/symbol/homo_sapiens/${encodeURIComponent(symbol)}?expand=1;content-type=application/json`
  return wrapSource(`Ensembl lookup (${symbol})`, url, { timeoutMs: 60000 }, parseStructure)
}

const rec = (r: SourceResult<unknown>, version: string | null): SourceRecord => ({
  name: r.source, status: r.status, fetchedAt: r.fetchedAt, url: r.url, version, ...(r.status === 'failed' ? { error: r.error } : {}),
})

export interface CnvAnalysis {
  genome: Genome
  evidence: CnvEvidence
  sources: SourceRecord[]
}

export async function analyzeCnv(region: CnvRegion, genome: Genome): Promise<CnvAnalysis> {
  const [genes, dg, dr, val, rel] = await Promise.all([
    fetchGenes(region, genome), loadDosageGenes(genome), loadDosageRegions(genome), loadValidity(), fetchEnsemblRelease(genome),
  ])
  // 部分重複する確立 HI 遺伝子（LOSS のみ）の構造を取得する
  const structures: CnvEvidence['structures'] = {}
  if (region.type === 'LOSS' && dg.status === 'ok') {
    const partial = dg.data.entries.filter((e) => e.chrom === region.chrom && e.hi === ESTABLISHED_SCORE && ['left', 'right'].includes(relation(region, e) ?? ''))
    await Promise.all(partial.map(async (g) => { structures[g.id.toUpperCase()] = await fetchStructure(g.id, genome) }))
  }
  const ens = rel.status === 'ok' ? `Ensembl release ${rel.data.release}` : null
  const ver = (r: typeof dg) => (r.status === 'ok' ? `${r.data.meta.version ?? '版不明'}（取得 ${r.data.meta.fetchedAt.slice(0, 10)}）` : null)
  const sources: SourceRecord[] = [
    rec(genes, ens), rec(dg, ver(dg)), rec(dr, ver(dr)),
    rec(val, val.status === 'ok' ? `${val.data.meta.version ?? '版不明'}（取得 ${val.data.meta.fetchedAt.slice(0, 10)}）` : null),
    ...Object.values(structures).map((s) => rec(s, ens)),
    ...(rel.status === 'failed' ? [rec(rel, null)] : []),
  ]
  return { genome, evidence: { region, genes, dosageGenes: dg, dosageRegions: dr, validity: val, structures }, sources }
}
