// MyVariant.info：集団頻度・in silico スコア・ClinVar
import { wrapSource, type HttpOptions, type SourceResult } from './http.ts'

export const MYVARIANT_BASE = 'https://myvariant.info/v1'

export interface PopFreq {
  af?: number
  ac?: number
  an?: number
  hom?: number
}

export interface MyVariantResult {
  id: string
  clinvar?: { variationId?: number; significance?: string; reviewStatus?: string; release?: string }
  /** gnomAD の取得元（インデックス名）。頻度系コードの表示に必ず併記する。 */
  gnomad: { source: 'gnomad_genome' | 'gnomad_exome' | 'none'; overall?: PopFreq }
  dbnsfp: { revel?: number; cadd?: number }
  raw: Record<string, unknown>
}

const FIELDS = [
  'clinvar.variant_id',
  'clinvar.rcv.clinical_significance',
  'clinvar.rcv.review_status',
  'gnomad_genome.af',
  'gnomad_genome.ac',
  'gnomad_genome.an',
  'gnomad_genome.hom',
  'gnomad_exome.af',
  'gnomad_exome.ac',
  'gnomad_exome.an',
  'gnomad_exome.hom',
  'dbnsfp.revel.score',
  'cadd.phred',
].join(',')

const num = (v: unknown): number | undefined => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' ? x : undefined
}
const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v)

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function pop(o: Obj | undefined): PopFreq | undefined {
  if (!o) return undefined
  const af = num(o.af?.af ?? o.af)
  const ac = num(o.ac?.ac ?? o.ac)
  const an = num(o.an?.an ?? o.an)
  const hom = num(o.hom?.hom ?? o.hom)
  return { af, ac, an, hom }
}

export function parseMyVariant(raw: unknown): MyVariantResult {
  const r = raw as Obj
  if (!r || r.notfound) throw new Error('MyVariant.info: 該当バリアントなし')
  const genome = pop(r.gnomad_genome)
  const exome = pop(r.gnomad_exome)
  const rcv = first<Obj>(r.clinvar?.rcv)
  return {
    id: String(r._id ?? ''),
    clinvar: r.clinvar
      ? {
          variationId: num(r.clinvar.variant_id),
          significance: rcv?.clinical_significance,
          reviewStatus: rcv?.review_status,
        }
      : undefined,
    gnomad: genome?.af !== undefined
      ? { source: 'gnomad_genome', overall: genome }
      : exome?.af !== undefined
        ? { source: 'gnomad_exome', overall: exome }
        : { source: 'none' },
    dbnsfp: { revel: num(r.dbnsfp?.revel?.score), cadd: num(r.cadd?.phred) },
    raw: r,
  }
}

/** MyVariant の ID 形式は hg19 が `chr17:g.7577538C>T`。hg38 は assembly=hg38 を付けて同形式で引く。 */
export function fetchMyVariant(
  genomicId: string,
  assembly: 'hg38' | 'hg19' = 'hg38',
  opts?: HttpOptions,
): Promise<SourceResult<MyVariantResult>> {
  const url = `${MYVARIANT_BASE}/variant/${encodeURIComponent(genomicId)}?assembly=${assembly}&fields=${encodeURIComponent(FIELDS)}`
  return wrapSource('MyVariant.info', url, { timeoutMs: 30000, ...opts }, parseMyVariant)
}

export interface MyVariantVersion {
  buildDate?: string
  /** metadata の src.gnomad.version（実測: 2.1.1 = hg19 基盤の旧版）。頻度系コードに併記する。 */
  gnomadVersion?: string
  clinvarVersion?: string
  dbnsfpVersion?: string
}

/** レポート用のビルド情報。gnomAD のバージョン併記に使う。 */
export function fetchMyVariantVersion(opts?: HttpOptions): Promise<SourceResult<MyVariantVersion>> {
  return wrapSource('MyVariant.info metadata', `${MYVARIANT_BASE}/metadata`, { timeoutMs: 30000, ...opts }, (raw) => {
    const m = raw as Obj
    const src = m.src ?? {}
    return {
      buildDate: m.build_date,
      gnomadVersion: src.gnomad?.version,
      clinvarVersion: src.clinvar?.version,
      dbnsfpVersion: src.dbnsfp?.version,
    }
  })
}
