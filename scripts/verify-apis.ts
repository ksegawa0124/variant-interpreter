// 手動確認スクリプト（CI では実行しない）: npm run verify:apis
// 実 API を叩き、各クライアントの取得・パースが成立するかを確認する。
import { fetchAlleleByCaid, fetchAlleleByHgvs, fetchAllelesByRsId, genomicHgvs } from '../src/api/alleleRegistry.ts'
import { fetchEnsemblRelease, fetchVepByHgvs } from '../src/api/vep.ts'
import { fetchMyVariant, fetchMyVariantVersion } from '../src/api/myvariant.ts'
import type { SourceResult } from '../src/api/http.ts'

function show(label: string, r: SourceResult<unknown>, summarize: (d: never) => unknown) {
  if (r.status === 'ok') console.log(`OK    ${label}`, JSON.stringify(summarize(r.data as never)))
  else console.log(`FAIL  ${label}: ${r.error}`)
}

const byHgvs = await fetchAlleleByHgvs('NM_000546.6:c.743G>A')
show('AlleleRegistry hgvs.c', byHgvs, (d: any) => ({ caid: d.caid, rs: d.rsIds }))
show('AlleleRegistry CAid', await fetchAlleleByCaid('CA16602537'), (d: any) => ({ caid: d.caid, n: d.genomicAlleles.length }))
show('AlleleRegistry rsID', await fetchAllelesByRsId('rs11540652'), (d: any) => d.map((a: any) => a.caid))

const g38 = byHgvs.status === 'ok' ? genomicHgvs(byHgvs.data, 'GRCh38') : undefined
console.log('GRCh38 HGVS.g =', g38)

show('Ensembl release', await fetchEnsemblRelease(), (d: any) => d)
show('VEP', await fetchVepByHgvs(g38 ?? 'NC_000017.11:g.7675088C>T'), (d: any) => ({
  n: d.transcripts.length,
  mane: d.transcripts.filter((t: any) => t.maneSelect).map((t: any) => t.maneSelect),
}))

const id = g38 ? 'chr17:g.' + g38.split('g.')[1] : 'chr17:g.7675088C>T'
show('MyVariant variant', await fetchMyVariant(id), (d: any) => ({ id: d.id, gnomad: d.gnomad.source, af: d.gnomad.overall?.af }))
show('MyVariant metadata', await fetchMyVariantVersion(), (d: any) => d)
