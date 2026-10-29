// ClinGen Allele Registry (reg.clinicalgenome.org)
import { wrapSource, type HttpOptions, type SourceResult } from './http.ts'

export const ALLELE_REGISTRY_BASE = 'https://reg.clinicalgenome.org'

export interface GenomicAllele {
  referenceGenome: string // 'GRCh38' | 'GRCh37' | 'NCBI36'
  chromosome: string
  start: number
  end: number
  referenceAllele: string
  allele: string
  hgvs: string[]
}

export interface TranscriptAllele {
  hgvs: string[]
  geneSymbol?: string
  maneSelect: boolean
}

export interface RegistryAllele {
  caid: string
  genomicAlleles: GenomicAllele[]
  transcriptAlleles: TranscriptAllele[]
  rsIds: string[]
}

interface RawAllele {
  '@id'?: string
  genomicAlleles?: Array<{
    referenceGenome?: string
    chromosome?: string
    coordinates?: Array<{ start: number; end: number; referenceAllele: string; allele: string }>
    hgvs?: string[]
  }>
  transcriptAlleles?: Array<{
    hgvs?: string[]
    geneSymbol?: string
    MANE?: { maneStatus?: string } | null
  }>
  externalRecords?: { dbSNP?: Array<{ rs?: number | string }> }
}

export function parseAllele(raw: unknown): RegistryAllele {
  const a = raw as RawAllele
  const id = a['@id'] ?? ''
  const caid = id.split('/').pop() ?? ''
  if (!/^CA\d+$/.test(caid)) throw new Error('Allele Registry: CAid を解釈できません')
  const genomicAlleles: GenomicAllele[] = (a.genomicAlleles ?? []).flatMap((g) => {
    const c = g.coordinates?.[0]
    if (!c || !g.referenceGenome || !g.chromosome) return []
    return [
      {
        referenceGenome: g.referenceGenome,
        chromosome: g.chromosome,
        start: c.start,
        end: c.end,
        referenceAllele: c.referenceAllele,
        allele: c.allele,
        hgvs: g.hgvs ?? [],
      },
    ]
  })
  const transcriptAlleles: TranscriptAllele[] = (a.transcriptAlleles ?? []).map((t) => ({
    hgvs: t.hgvs ?? [],
    geneSymbol: t.geneSymbol,
    maneSelect: t.MANE?.maneStatus === 'MANE Select',
  }))
  const rsIds = (a.externalRecords?.dbSNP ?? []).map((r) => `rs${r.rs}`)
  return { caid, genomicAlleles, transcriptAlleles, rsIds }
}

const get = (query: string, opts?: HttpOptions): Promise<SourceResult<RegistryAllele>> =>
  wrapSource('ClinGen Allele Registry', `${ALLELE_REGISTRY_BASE}${query}`, opts, parseAllele)

export const fetchAlleleByHgvs = (hgvs: string, opts?: HttpOptions) =>
  get(`/allele?hgvs=${encodeURIComponent(hgvs)}`, opts)

export const fetchAlleleByCaid = (caid: string, opts?: HttpOptions) =>
  get(`/allele/${encodeURIComponent(caid)}`, opts)

/** 1 つの rsID が複数アレル（多アレル部位）に対応しうるため、配列で返す。UI 側で選択させる。 */
export const parseAlleleList = (raw: unknown): RegistryAllele[] => {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Allele Registry: 該当アレルなし')
  return raw.map(parseAllele)
}

export const fetchAllelesByRsId = (
  rsId: string,
  opts?: HttpOptions,
): Promise<SourceResult<RegistryAllele[]>> =>
  wrapSource(
    'ClinGen Allele Registry',
    `${ALLELE_REGISTRY_BASE}/alleles?dbSNP.rs=${encodeURIComponent(rsId.replace(/^rs/i, ''))}`,
    opts,
    parseAlleleList,
  )

/** 指定アセンブリのゲノム HGVS（NC_...）を返す。 */
export function genomicHgvs(allele: RegistryAllele, genome: 'GRCh38' | 'GRCh37'): string | undefined {
  return allele.genomicAlleles.find((g) => g.referenceGenome === genome)?.hgvs[0]
}
