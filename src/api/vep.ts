// Ensembl VEP REST (rest.ensembl.org)。15 req/s 制限があるためレートリミッタ経由で呼ぶ。
import { createRateLimiter, wrapSource, type HttpOptions, type SourceResult } from './http.ts'

export const ENSEMBL_BASE = {
  GRCh38: 'https://rest.ensembl.org',
  GRCh37: 'https://grch37.rest.ensembl.org',
} as const
export type Genome = keyof typeof ENSEMBL_BASE

// 公開上限 15 req/s に余裕を持たせて ~10 req/s
const acquire = createRateLimiter(100)

export interface VepTranscriptConsequence {
  transcriptId: string
  geneSymbol?: string
  consequenceTerms: string[]
  impact?: string
  canonical: boolean
  maneSelect?: string
  hgvsc?: string
  hgvsp?: string
  exon?: string
  intron?: string
  proteinStart?: number
  aminoAcids?: string
  /** 例: "Cgg/Tgg"（変化した塩基が大文字） */
  codons?: string
  domains: Array<{ db: string; name: string }>
}

export interface VepResult {
  input: string
  assemblyName?: string
  mostSevereConsequence?: string
  transcripts: VepTranscriptConsequence[]
}

interface RawTc {
  transcript_id: string
  gene_symbol?: string
  consequence_terms?: string[]
  impact?: string
  canonical?: number
  mane_select?: string
  hgvsc?: string
  hgvsp?: string
  exon?: string
  intron?: string
  protein_start?: number
  amino_acids?: string
  codons?: string
  domains?: Array<{ db: string; name: string }>
}

export function parseVep(raw: unknown): VepResult {
  const arr = raw as Array<{
    input?: string
    assembly_name?: string
    most_severe_consequence?: string
    transcript_consequences?: RawTc[]
  }>
  const r = arr?.[0]
  if (!r) throw new Error('VEP: 結果が空です')
  return {
    input: r.input ?? '',
    assemblyName: r.assembly_name,
    mostSevereConsequence: r.most_severe_consequence,
    transcripts: (r.transcript_consequences ?? []).map((t) => ({
      transcriptId: t.transcript_id,
      geneSymbol: t.gene_symbol,
      consequenceTerms: t.consequence_terms ?? [],
      impact: t.impact,
      canonical: t.canonical === 1,
      maneSelect: t.mane_select,
      hgvsc: t.hgvsc,
      hgvsp: t.hgvsp,
      exon: t.exon,
      intron: t.intron,
      proteinStart: t.protein_start,
      aminoAcids: t.amino_acids,
      codons: t.codons,
      domains: t.domains ?? [],
    })),
  }
}

const VEP_FLAGS = 'canonical=1&mane=1&hgvs=1&domains=1&numbers=1&content-type=application/json'

export async function fetchVepByHgvs(
  hgvs: string,
  genome: Genome = 'GRCh38',
  opts?: HttpOptions,
): Promise<SourceResult<VepResult>> {
  await acquire()
  const url = `${ENSEMBL_BASE[genome]}/vep/human/hgvs/${encodeURIComponent(hgvs)}?${VEP_FLAGS}`
  return wrapSource('Ensembl VEP', url, opts, parseVep)
}

export interface EnsemblVersion {
  release: number
}

/** レポートへ記録する Ensembl release を取得する。 */
export async function fetchEnsemblRelease(
  genome: Genome = 'GRCh38',
  opts?: HttpOptions,
): Promise<SourceResult<EnsemblVersion>> {
  await acquire()
  const url = `${ENSEMBL_BASE[genome]}/info/data?content-type=application/json`
  return wrapSource('Ensembl release', url, opts, (raw) => {
    const releases = (raw as { releases?: number[] }).releases
    if (!releases?.length) throw new Error('Ensembl: release を取得できません')
    return { release: Math.max(...releases) }
  })
}
