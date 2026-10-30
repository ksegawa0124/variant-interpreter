// 可視化の座標計算（純粋関数）。描画は SVG コンポーネント側。
import type { Exon } from '../api/ensemblViz.ts'

export interface ExonBox {
  index: number
  /** 転写方向での番号（マイナス鎖は 1 番目が最大座標のエクソン） */
  number: number
  x: number
  width: number
  /** CDS に含まれる x 範囲（無ければ undefined） */
  cds?: { x: number; width: number }
}

export interface ExonLayout {
  boxes: ExonBox[]
  width: number
  /** ゲノム座標 → x（イントロン内は隣接エクソン間の中央）。範囲外は null */
  xOf: (pos: number) => number | null
  /** 位置がどのエクソンか（イントロン/範囲外は null） */
  exonAt: (pos: number) => number | null
}

/** イントロンを固定幅に圧縮し、エクソンは長さに比例させる。 */
export function layoutExons(
  exons: Exon[], strand: 1 | -1, total: number, cds?: { start?: number; end?: number }, gap = 10,
): ExonLayout {
  const n = exons.length
  const lens = exons.map((e) => e.end - e.start + 1)
  const sum = lens.reduce((a, b) => a + b, 0)
  const avail = Math.max(1, total - gap * (n - 1))
  // 最小幅を確保しつつ比例配分（極端に短いエクソンも見えるように）
  const MIN = 3
  const widths = lens.map((l) => Math.max(MIN, (l / sum) * avail))
  const scale = avail / widths.reduce((a, b) => a + b, 0)

  // 表示は転写方向。マイナス鎖は右から左へ並べる
  const order = exons.map((_, i) => i)
  if (strand === -1) order.reverse()
  let x = 0
  const boxes: ExonBox[] = []
  const xByIdx: number[] = []
  const wByIdx: number[] = []
  order.forEach((idx, k) => {
    const w = widths[idx] * scale
    xByIdx[idx] = x
    wByIdx[idx] = w
    boxes.push({ index: idx, number: k + 1, x, width: w })
    x += w + gap
  })

  const posInExon = (idx: number, pos: number) => {
    const e = exons[idx]
    const f = (pos - e.start) / Math.max(1, e.end - e.start + 1)
    // 転写方向と描画方向を揃える
    const frac = strand === 1 ? f : 1 - f
    return xByIdx[idx] + frac * wByIdx[idx]
  }

  if (cds?.start !== undefined && cds.end !== undefined) {
    for (const b of boxes) {
      const e = exons[b.index]
      const s = Math.max(e.start, cds.start)
      const t = Math.min(e.end, cds.end)
      if (s > t) continue
      const x1 = posInExon(b.index, s)
      const x2 = posInExon(b.index, t + 1)
      b.cds = { x: Math.min(x1, x2), width: Math.abs(x2 - x1) }
    }
  }

  const exonAt = (pos: number) => {
    const i = exons.findIndex((e) => pos >= e.start && pos <= e.end)
    return i < 0 ? null : i
  }
  const xOf = (pos: number) => {
    const i = exonAt(pos)
    if (i !== null) return posInExon(i, pos)
    // イントロン: 前後のエクソン間の中央
    const left = exons.findLastIndex((e) => e.end < pos)
    const right = exons.findIndex((e) => e.start > pos)
    if (left < 0 || right < 0) return null
    const a = strand === 1 ? left : right
    const b = strand === 1 ? right : left
    return (xByIdx[a] + wByIdx[a] + xByIdx[b]) / 2
  }
  return { boxes, width: total, xOf, exonAt }
}

/** 線形スケール: [a,b] → [0,width] */
export const linear = (a: number, b: number, width: number) => (v: number) => ((v - a) / Math.max(1, b - a)) * width
