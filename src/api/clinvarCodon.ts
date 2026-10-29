// PS1/PM5 用：同じ遺伝子・同じ残基の ClinVar バリアントを MyVariant.info から引く。
import { wrapSource, type HttpOptions, type SourceResult } from './http.ts'
import { MYVARIANT_BASE } from './myvariant.ts'
import { CLINVAR_BLB, CLINVAR_NO_CRITERIA, CLINVAR_PLP } from '../engine/rules.ts'
import type { ClinvarCodonVariant } from '../engine/small.ts'

type Obj = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const PROT = /(?:^|:)p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2}|=|Ter|fs.*)$/

/** MyVariant のクエリ結果 → 残基ごとの ClinVar バリアント（審査基準ありの P/LP, B/LB 判定付き）。 */
export function parseClinvarCodon(raw: unknown, ref: string, pos: number): ClinvarCodonVariant[] {
  const hits = (raw as { hits?: Obj[] }).hits
  if (!Array.isArray(hits)) throw new Error('MyVariant.info: クエリ結果の形式が不正です')
  const out: ClinvarCodonVariant[] = []
  for (const h of hits) {
    const prots: string[] = [h.clinvar?.hgvs?.protein].flat().filter(Boolean)
    // 同一 ID の複数アイソフォーム表記のうち、参照アミノ酸と位置が一致する置換のみ採用
    const alt = prots
      .map((p) => PROT.exec(p))
      .find((m) => m && m[1] === ref && Number(m[2]) === pos && m[3] !== '=' && !m[3].startsWith('fs'))?.[3]
    if (!alt) continue
    const rcvs: Obj[] = [h.clinvar?.rcv].flat().filter(Boolean)
    const usable = rcvs.filter((r) => !CLINVAR_NO_CRITERIA.test(String(r.review_status ?? '')))
    const sig = usable.map((r) => String(r.clinical_significance ?? ''))
    const plp = sig.some((s) => CLINVAR_PLP.test(s))
    const blb = sig.some((s) => CLINVAR_BLB.test(s))
    out.push({ alt, plp: plp && !blb, blb: blb && !plp, id: String(h._id), clinvarId: h.clinvar?.variant_id })
  }
  return out
}

export function fetchClinvarCodon(
  gene: string, ref: string, pos: number, assembly: 'hg38' | 'hg19' = 'hg38', opts?: HttpOptions,
): Promise<SourceResult<ClinvarCodonVariant[]>> {
  const q = `clinvar.gene.symbol:${gene} AND clinvar.hgvs.protein:*${ref}${pos}*`
  const fields = 'clinvar.hgvs.protein,clinvar.rcv.clinical_significance,clinvar.rcv.review_status,clinvar.variant_id'
  const url = `${MYVARIANT_BASE}/query?q=${encodeURIComponent(q)}&fields=${fields}&size=100&assembly=${assembly}`
  return wrapSource('ClinVar (MyVariant.info)', url, { timeoutMs: 30000, ...opts }, (raw) => parseClinvarCodon(raw, ref, pos))
}
