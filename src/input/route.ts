import type { Genome, ParsedInput, VariantType } from './parseInput.ts'
import type { Settings } from '../settings.ts'

export type Engine = 'small' | 'cnv' | 'deferred' | 'invalid'

export interface Route {
  engine: Engine
  reason: string
  warnings: string[]
  /** 入力から確定したアセンブリ（アクセッション・ISCN 由来）。選択値と食い違うとき警告する。 */
  genome?: Genome
}

/** 種別と長さから振り分ける。rsID / CAid は Allele Registry 解決後にこれを再利用する。 */
export function routeBySize(type: VariantType | 'DEL' | 'DUP', lengthBp: number | null, thresholdBp: number): Route {
  const t = type.toLowerCase()
  if (t === 'del' || t === 'dup') {
    if (lengthBp === null)
      return { engine: 'small', reason: `${type} のサイズを確定できないため小変異エンジンで扱います`, warnings: ['サイズ未確定（イントロン側オフセット等）。ゲノム座標へ解決後に再判定が必要です'] }
    if (lengthBp >= thresholdBp)
      return { engine: 'cnv', reason: `${lengthBp} bp の ${type}（閾値 ${thresholdBp} bp 以上）→ CNV エンジン`, warnings: [] }
    return { engine: 'small', reason: `${lengthBp} bp の ${type}（閾値 ${thresholdBp} bp 未満）→ 小変異エンジン`, warnings: [] }
  }
  return { engine: 'small', reason: `${type === 'other' ? '変異' : type} → 小変異エンジン`, warnings: [] }
}

export function routeInput(p: ParsedInput, selectedGenome: Genome, s: Settings): Route {
  switch (p.kind) {
    case 'unknown':
      return { engine: 'invalid', reason: p.reason, warnings: [] }
    case 'rsid':
    case 'caid':
      return { engine: 'deferred', reason: 'Allele Registry で解決後に種別とサイズから振り分けます', warnings: [] }
    case 'cnv':
    case 'iscn': {
      const r = routeBySize(p.cnvType, p.lengthBp, s.cnvThresholdBp)
      if (r.engine === 'small')
        r.warnings.push('座標入力のため、小変異エンジンで評価するには HGVS への変換が必要です')
      if (p.kind === 'iscn') {
        r.genome = p.genome
        if (p.genome !== selectedGenome) r.warnings.push(`ISCN は ${p.genome} 指定のため、選択中の ${selectedGenome} ではなく ${p.genome} を使用します`)
      }
      return r
    }
    case 'hgvs_g': {
      const r = routeBySize(p.variantType, p.lengthBp, s.cnvThresholdBp)
      if (!p.genome) r.warnings.push(`${p.accession} のバージョンから GRCh38/GRCh37 を判別できません`)
      else {
        r.genome = p.genome
        if (p.genome !== selectedGenome) r.warnings.push(`${p.accession} は ${p.genome} のため、選択中の ${selectedGenome} ではなく ${p.genome} を使用します`)
      }
      return r
    }
    case 'hgvs_c': {
      const r = routeBySize(p.variantType, p.lengthBp, s.cnvThresholdBp)
      if (!p.transcript && !p.gene) r.warnings.push('参照配列も遺伝子も未指定です。遺伝子欄の入力が必要です')
      if (p.inFrameTandemDupCandidate && r.engine === 'small')
        r.warnings.push('in-frame の tandem dup 候補です。PVS1 の適用条件が特殊なため、LoF 前提で自動適用しません')
      return r
    }
  }
}
