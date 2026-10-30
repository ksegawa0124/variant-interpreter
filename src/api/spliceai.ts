// Broad SpliceAI lookup（Cloud Run の公開エンドポイント）。
// CORS: github.io オリジンからの fetch で応答を読めることを実地確認済み。
// 公開元は「対話的な利用向け・1 ユーザーあたり毎分数回まで」としているため、BP7 の判定に必要な同義置換のときだけ 1 回呼ぶ。
import { wrapSource, type HttpOptions, type SourceResult } from './http.ts'

export const SPLICEAI_BASE = {
  GRCh37: 'https://spliceai-37-xwkwwwxdwq-uc.a.run.app/spliceai/?hg=37',
  GRCh38: 'https://spliceai-38-xwkwwwxdwq-uc.a.run.app/spliceai/?hg=38',
} as const

/** BP7 と同じ最大スプライス距離（SpliceAI 既定 50 より広い 500 を使う）。 */
export const SPLICEAI_DISTANCE = 500

export interface SpliceAiResult {
  /** DS_AG / DS_AL / DS_DG / DS_DL の最大値（全転写産物・全スコアの最大） */
  maxDelta: number
  distance: number
  /** 応答の source（事前計算か計算か）。レポートの版欄に使う */
  source?: string
}

export function parseSpliceAi(raw: unknown): SpliceAiResult {
  const r = raw as { error?: string; scores?: Array<Record<string, string | number>>; distance?: number; source?: string }
  if (r?.error) throw new Error(`SpliceAI: ${r.error}`)
  if (!Array.isArray(r?.scores) || !r.scores.length) throw new Error('SpliceAI: スコアが返りませんでした（遺伝子外など）')
  const vals = r.scores.flatMap((s) => ['DS_AG', 'DS_AL', 'DS_DG', 'DS_DL'].map((k) => Number(s[k]))).filter((n) => Number.isFinite(n))
  if (!vals.length) throw new Error('SpliceAI: スコアを解釈できません')
  return { maxDelta: Math.max(...vals), distance: r.distance ?? SPLICEAI_DISTANCE, source: r.source }
}

/** "NC_…:g.7674221G>A" から chrom-pos-ref-alt を作る。SNV 以外は未対応（null）。 */
export function spliceAiVariant(chrom: string, genomicHgvs: string): string | null {
  const m = /g\.(\d+)([ACGT])>([ACGT])$/.exec(genomicHgvs)
  return m ? `chr${chrom}-${m[1]}-${m[2]}-${m[3]}` : null
}

export function fetchSpliceAi(genome: 'GRCh37' | 'GRCh38', variant: string, opts?: HttpOptions): Promise<SourceResult<SpliceAiResult>> {
  const url = `${SPLICEAI_BASE[genome]}&variant=${encodeURIComponent(variant)}&distance=${SPLICEAI_DISTANCE}&mask=0`
  return wrapSource('SpliceAI lookup (Broad)', url, { timeoutMs: 60000, maxRetries: 1, ...opts }, parseSpliceAi)
}
