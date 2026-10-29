// 転写産物の選択。優先順位: 利用者指定 → CSpec(VCEP) 指定 → MANE Select → canonical。
import type { VepTranscriptConsequence } from '../api/vep.ts'

export type TranscriptBasis = 'user' | 'vcep' | 'mane' | 'canonical' | 'first'

export interface TranscriptChoice {
  tc: VepTranscriptConsequence
  basis: TranscriptBasis
  note: string
}

const strip = (id: string) => id.replace(/\.\d+$/, '').toUpperCase()

export function selectTranscript(
  all: VepTranscriptConsequence[],
  opts: { gene?: string; userTranscript?: string; vcepTranscript?: string } = {},
): TranscriptChoice | null {
  const genePool = opts.gene ? all.filter((t) => t.geneSymbol?.toUpperCase() === opts.gene!.toUpperCase()) : all
  const pool = genePool.length ? genePool : all
  if (!pool.length) return null
  const matches = (want: string) => pool.find((t) => strip(t.transcriptId) === strip(want) || (t.maneSelect && strip(t.maneSelect) === strip(want)))

  if (opts.userTranscript) {
    const t = matches(opts.userTranscript)
    if (t) return { tc: t, basis: 'user', note: `入力で指定された転写産物 ${opts.userTranscript}` }
  }
  if (opts.vcepTranscript) {
    const t = matches(opts.vcepTranscript)
    if (t) return { tc: t, basis: 'vcep', note: `CSpec(VCEP) 指定の転写産物 ${opts.vcepTranscript}` }
  }
  const mane = pool.find((t) => t.maneSelect)
  if (mane) return { tc: mane, basis: 'mane', note: `MANE Select (${mane.maneSelect})` }
  const canon = pool.find((t) => t.canonical)
  if (canon) return { tc: canon, basis: 'canonical', note: 'Ensembl canonical' }
  return { tc: pool[0], basis: 'first', note: 'MANE/canonical が無いため先頭の転写産物' }
}
