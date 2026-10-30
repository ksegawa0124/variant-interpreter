// 入力バリアント → 各 API の呼び出し → SmallEvidence への組み立て（小変異）。
// 各ソースの失敗はそのソースだけに閉じ込め、依存するコードを「評価不可」にする。
import { fetchAlleleByCaid, fetchAlleleByHgvs, fetchAllelesByRsId, genomicHgvs, type RegistryAllele } from '../api/alleleRegistry.ts'
import { fetchClinvarCodon } from '../api/clinvarCodon.ts'
import { fetchErepo, type ErepoClassification } from '../api/erepo.ts'
import type { SourceResult } from '../api/http.ts'
import { fetchMyVariant, fetchMyVariantVersion, type MyVariantResult } from '../api/myvariant.ts'
import { fetchEnsemblRelease, fetchVepByHgvs, type VepResult } from '../api/vep.ts'
import { loadCSpec, loadDosageGenes, dosageForGene, cspecForGene } from '../data/reference.ts'
import { genomeFromAccession, type Genome, type ParsedInput } from '../input/parseInput.ts'
import { parseProteinChange, type PopulationData, type SmallEvidence } from './small.ts'
import { selectTranscript, type TranscriptChoice } from './transcript.ts'

/** レポートに必ず載せるデータソース記録。 */
export interface SourceRecord {
  name: string
  status: 'ok' | 'failed'
  fetchedAt: string
  url: string
  /** 配布元の版（gnomAD 2.1.1 など）。取得できなければ null（レポートでは「版不明」と明示する）。 */
  version: string | null
  error?: string
}

export interface SmallAnalysis {
  genome: Genome
  allele: RegistryAllele | null
  genomicHgvs?: string
  /** 他に候補アレルがある（rsID が多アレル部位など） */
  alleleCandidates: number
  vep: SourceResult<VepResult> | null
  choice: TranscriptChoice | null
  evidence: SmallEvidence | null
  /** ERepo の専門家パネル分類（ない場合は ok で空配列） */
  erepo?: SourceResult<ErepoClassification[]>
  sources: SourceRecord[]
  /** 解析を続行できなかった理由 */
  fatal?: string
}

const rec = (r: SourceResult<unknown>, version: string | null): SourceRecord => ({
  name: r.source, status: r.status, fetchedAt: r.fetchedAt, url: r.url, version,
  ...(r.status === 'failed' ? { error: r.error } : {}),
})

const NOT_FOUND = /HTTP 404|該当バリアントなし/

/** MyVariant の結果と版情報から、頻度コード用の入力を作る。404 = gnomAD にも ClinVar にも無い = 不在。 */
export function populationFrom(mv: SourceResult<MyVariantResult>, gnomadVersion?: string): SourceResult<PopulationData> {
  if (mv.status === 'ok') {
    const g = mv.data.gnomad
    const pm = mv.data.popmax
    return { ...mv, data: g.source === 'none' || !g.overall ? { present: false, dataset: 'gnomAD', version: gnomadVersion } : { present: true, ...g.overall, popmaxAf: pm?.af, popmaxPop: pm ? `${pm.pop}/${pm.dataset}` : undefined, dataset: g.source, version: gnomadVersion } }
  }
  if (NOT_FOUND.test(mv.error)) return { ...mv, status: 'ok', data: { present: false, dataset: 'gnomAD', version: gnomadVersion } }
  return mv
}

async function resolveAllele(p: ParsedInput): Promise<{ allele: RegistryAllele | null; candidates: number; fatal?: string; rec?: SourceRecord }> {
  let r: SourceResult<RegistryAllele | RegistryAllele[]>
  switch (p.kind) {
    case 'hgvs_c':
      if (!p.transcript) return { allele: null, candidates: 0, fatal: '転写産物（NM_…）付きの HGVS.c を入力してください。ゲノム HGVS・rsID・CAid でも解析できます' }
      r = await fetchAlleleByHgvs(p.raw)
      break
    case 'hgvs_g': r = await fetchAlleleByHgvs(p.raw); break
    case 'caid': r = await fetchAlleleByCaid(p.caid); break
    case 'rsid': r = await fetchAllelesByRsId(p.rsId); break
    default: return { allele: null, candidates: 0, fatal: 'この入力は小変異エンジンの対象ではありません' }
  }
  if (r.status === 'failed') return { allele: null, candidates: 0, fatal: `ClinGen Allele Registry で解決できません: ${r.error}`, rec: rec(r, null) }
  const list = Array.isArray(r.data) ? r.data : [r.data]
  return { allele: list[0], candidates: list.length, rec: rec(r, null) }
}

export async function analyzeSmall(p: ParsedInput, genome: Genome, geneHint?: string, transcriptHint?: string): Promise<SmallAnalysis> {
  const out: SmallAnalysis = { genome, allele: null, alleleCandidates: 0, vep: null, choice: null, evidence: null, sources: [] }
  const res = await resolveAllele(p)
  // Allele Registry は版情報を提供しないため、その旨を版欄に明示する（版欄を空にしない）
  if (res.rec) out.sources.push({ ...res.rec, version: 'API（版情報の提供なし・取得時刻で特定）' })
  out.allele = res.allele
  out.alleleCandidates = res.candidates
  if (!res.allele) return { ...out, fatal: res.fatal }

  // 入力が別アセンブリの NC_ だった場合はそちらを優先する
  const effGenome: Genome = (p.kind === 'hgvs_g' && p.genome) || genome
  out.genome = effGenome
  const g = genomicHgvs(res.allele, effGenome)
  if (!g) return { ...out, fatal: `${effGenome} のゲノム座標を Allele Registry から取得できません` }
  out.genomicHgvs = g
  const acc = g.split(':')[0]
  const chrom = genomeFromAccession(acc)?.chrom
  const mvId = chrom ? `chr${chrom}:${g.split(':')[1]}` : undefined

  const hgvsC = p.kind === 'hgvs_c' ? p : undefined
  const [vep, mv, mvVer, ensRel, dosageFile, cspecFile, erepo] = await Promise.all([
    fetchVepByHgvs(g, effGenome),
    mvId ? fetchMyVariant(mvId, effGenome === 'GRCh38' ? 'hg38' : 'hg19') : Promise.resolve(null),
    fetchMyVariantVersion(),
    fetchEnsemblRelease(effGenome),
    loadDosageGenes(effGenome),
    loadCSpec(),
    fetchErepo(res.allele.caid),
  ])
  // ERepo は VEP 失敗時にも最優先表示できるよう、ここで記録する。分類の版は日付で特定する。
  out.erepo = erepo
  out.sources.push(rec(erepo, erepo.status === 'ok' ? 'ERepo（分類ごとの公開日を併記）' : null))
  out.vep = vep
  out.sources.push(rec(vep, ensRel.status === 'ok' ? `Ensembl release ${ensRel.data.release}` : null))
  if (ensRel.status === 'failed') out.sources.push(rec(ensRel, null))

  const gnomadVersion = mvVer.status === 'ok' ? mvVer.data.gnomadVersion : undefined
  const mvFailed: SourceResult<MyVariantResult> = {
    status: 'failed', source: 'MyVariant.info', url: '', fetchedAt: new Date().toISOString(), error: 'ゲノム座標を MyVariant 形式に変換できません',
  }
  const mvRes = mv ?? mvFailed
  out.sources.push(rec(mvRes, mvVer.status === 'ok' ? `gnomAD ${mvVer.data.gnomadVersion ?? '不明'} / ClinVar ${mvVer.data.clinvarVersion ?? '不明'} / dbNSFP ${mvVer.data.dbnsfpVersion ?? '不明'}` : null))
  if (mvVer.status === 'failed') out.sources.push(rec(mvVer, null))

  if (vep.status === 'failed') return { ...out, fatal: `Ensembl VEP の取得に失敗したため、転写産物への影響を判定できません（${vep.error}）` }

  const gene = geneHint || hgvsC?.gene || res.allele.transcriptAlleles.find((t) => t.geneSymbol)?.geneSymbol
  const cspec = cspecFile.status === 'ok' && gene ? cspecForGene(cspecFile.data, gene) : []
  const choice = selectTranscript(vep.data.transcripts, { gene, userTranscript: transcriptHint ?? hgvsC?.transcript })
  out.choice = choice
  const geneSym = choice?.tc.geneSymbol ?? gene

  const pc = parseProteinChange(choice?.tc.hgvsp)
  const codon: SourceResult<import('./small.ts').ClinvarCodonVariant[]> =
    pc && geneSym
      ? await fetchClinvarCodon(geneSym, pc.ref, pc.pos, effGenome === 'GRCh38' ? 'hg38' : 'hg19')
      : { status: 'ok', source: 'ClinVar (MyVariant.info)', url: '', fetchedAt: new Date().toISOString(), data: [] }
  if (pc) out.sources.push(rec(codon, mvVer.status === 'ok' ? `ClinVar ${mvVer.data.clinvarVersion ?? '不明'}` : null))

  const dosage: SourceResult<import('../data/convert.ts').DosageEntry | null> =
    dosageFile.status === 'ok' ? { ...dosageFile, data: geneSym ? dosageForGene(dosageFile.data, geneSym) ?? null : null } : dosageFile
  out.sources.push(rec(dosageFile, dosageFile.status === 'ok' ? `Dosage ${dosageFile.data.meta.version ?? '版不明'}（取得 ${dosageFile.data.meta.fetchedAt.slice(0, 10)}）` : null))
  out.sources.push(rec(cspecFile, cspecFile.status === 'ok' ? `CSpec ${cspecFile.data.meta.version ?? '版不明'}（取得 ${cspecFile.data.meta.fetchedAt.slice(0, 10)}）` : null))

  out.evidence = {
    gene: geneSym,
    transcript: choice?.tc ?? null,
    selfId: mvId,
    population: populationFrom(mvRes, gnomadVersion),
    revel: mvRes.status === 'ok'
      ? { ...mvRes, data: mvRes.data.dbnsfp.revel }
      : mvRes.error && NOT_FOUND.test(mvRes.error) ? { ...mvRes, status: 'ok', data: undefined } : mvRes,
    splice: { status: 'failed', source: 'SpliceAI', url: '', fetchedAt: new Date().toISOString(), error: 'SpliceAI は未接続（CORS 未検証）' },
    clinvarCodon: codon,
    dosage,
    cspec,
  }
  return out
}
