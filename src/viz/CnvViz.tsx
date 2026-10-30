import { useMemo } from 'react'
import type { ChromosomeView } from '../api/ensemblViz.ts'
import type { GeneRow } from '../cnv/engine.ts'
import type { DosageEntry } from '../data/convert.ts'
import { linear } from './layout.ts'

const W = 720
const BAND_CLASS: Record<string, string> = {
  gneg: 'b-gneg', gpos25: 'b-gpos25', gpos50: 'b-gpos50', gpos75: 'b-gpos75', gpos100: 'b-gpos100', acen: 'b-acen', gvar: 'b-gvar', stalk: 'b-stalk',
}
const fmtMb = (v: number) => `${(v / 1e6).toFixed(2)} Mb`

/** 遺伝子の色分け: HI/TS が確立(3)=赤、それ以外の Dosage 評価あり=青、評価なし=灰色。 */
const geneClass = (g: GeneRow, type: 'LOSS' | 'GAIN') => {
  const s = type === 'LOSS' ? g.hi : g.ts
  return s === 3 ? 'g-established' : g.hi != null || g.ts != null ? 'g-annotated' : 'g-plain'
}

function lanes<T extends { start: number; end: number }>(items: T[], minGap: number): number[] {
  const ends: number[] = []
  return items.map((it) => {
    let l = ends.findIndex((e) => e + minGap < it.start)
    if (l < 0) { l = ends.length; ends.push(0) }
    ends[l] = it.end
    return l
  })
}

/** 染色体イデオグラム + 領域内の遺伝子トラック + Dosage 領域。 */
export function CnvViz({ chromosome, chromError, region, genes, dosageRegions }: {
  chromosome?: ChromosomeView
  chromError?: string
  region: { chrom: string; start: number; end: number; type: 'LOSS' | 'GAIN' }
  genes: GeneRow[]
  dosageRegions: DosageEntry[]
}) {
  const span = region.end - region.start + 1
  const pad = Math.max(1, Math.round(span * 0.05))
  const vs = Math.max(1, region.start - pad)
  const ve = region.end + pad
  const x = useMemo(() => linear(vs, ve, W - 20), [vs, ve])
  const sorted = useMemo(() => [...genes].sort((a, b) => a.start - b.start), [genes])
  // 文字幅を概算して重ならないよう段を割り当てる（ラベル分の余白を bp に換算）
  const bpPerPx = (ve - vs) / (W - 20)
  const gLane = useMemo(() => lanes(sorted.map((g) => ({ start: g.start, end: Math.max(g.end, g.start + g.symbol.length * 6 * bpPerPx) })), 4 * bpPerPx), [sorted, bpPerPx])
  const laneCount = Math.min(14, Math.max(1, ...gLane.map((l) => l + 1)))
  const regLane = lanes(dosageRegions, 4 * bpPerPx)
  const regRows = Math.max(0, ...regLane.map((l) => l + 1))
  const geneTop = 34 + regRows * 14
  const height = geneTop + laneCount * 24 + 22
  const labelAll = sorted.length <= 40

  return (
    <figure className="viz" aria-label="染色体と遺伝子トラック">
      <figcaption>chr{region.chrom}:{region.start.toLocaleString()}-{region.end.toLocaleString()}（{fmtMb(span)}、{region.type === 'LOSS' ? '欠失' : '重複'}）</figcaption>

      {chromosome ? (
        <svg viewBox={`0 0 ${W} 40`} role="img" aria-label="染色体イデオグラム">
          <g transform="translate(10,8)">
            {chromosome.bands.map((b) => {
              const sx = linear(0, chromosome.length, W - 20)
              return (
                <rect key={b.name} x={sx(b.start)} y={4} width={Math.max(0.5, sx(b.end) - sx(b.start))} height={16} className={`band ${BAND_CLASS[b.stain] ?? 'b-gneg'}`}>
                  <title>{chromosome.chrom}{b.name}</title>
                </rect>
              )
            })}
            <rect x={0} y={4} width={W - 20} height={16} className="chr-outline" rx={7} />
            {(() => {
              const sx = linear(0, chromosome.length, W - 20)
              const x1 = sx(region.start)
              return <rect x={x1 - 1} y={0} width={Math.max(3, sx(region.end) - x1)} height={24} className="region-mark" />
            })()}
          </g>
        </svg>
      ) : (
        <p className="muted">{chromError ? `⚠ 染色体バンドの取得に失敗しました（${chromError}）。遺伝子トラックのみ表示します。` : ''}</p>
      )}

      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label="遺伝子トラック">
        <g transform="translate(10,4)">
          <rect x={x(region.start)} y={0} width={Math.max(2, x(region.end) - x(region.start))} height={8} className={region.type === 'LOSS' ? 'cnv-loss' : 'cnv-gain'}>
            <title>入力 CNV</title>
          </rect>
          {dosageRegions.map((r, i) => {
            const s = region.type === 'LOSS' ? r.hi : r.ts
            const cx = x(Math.max(vs, r.start))
            return (
              <g key={r.id}>
                <rect x={cx} y={20 + regLane[i] * 14} width={Math.max(2, x(Math.min(ve, r.end)) - cx)} height={9} className={s === 3 ? 'g-established' : 'g-annotated'}>
                  <title>{r.id} {r.name ?? ''} HI={String(r.hi)} TS={String(r.ts)}</title>
                </rect>
              </g>
            )
          })}
          {regRows > 0 && <text x={0} y={16} className="viz-label">Dosage 領域</text>}
          {sorted.map((g, i) => {
            const lane = gLane[i]
            if (lane >= 14) return null
            const gx = x(Math.max(vs, g.start))
            const gw = Math.max(1.5, x(Math.min(ve, g.end)) - gx)
            const y = geneTop - 4 + lane * 24
            const show = labelAll || geneClass(g, region.type) !== 'g-plain'
            return (
              <g key={g.symbol + g.start}>
                <rect x={gx} y={y} width={gw} height={8} className={geneClass(g, region.type)}>
                  <title>{g.symbol} HI={String(g.hi ?? '—')} TS={String(g.ts ?? '—')}</title>
                </rect>
                {show && <text x={gx} y={y + 19} className="viz-label">{g.symbol}</text>}
              </g>
            )
          })}
        </g>
      </svg>
      <p className="viz-legend">
        <span className="sw g-established" />HI/TS 確立(3)
        <span className="sw g-annotated" />Dosage 評価あり
        <span className="sw g-plain" />評価なし
        {!labelAll && <span className="muted">　遺伝子が多いため、Dosage 評価のあるものだけラベル表示</span>}
        {gLane.some((l) => l >= 14) && <span className="muted">　密集のため一部の遺伝子を省略（下の表に全件）</span>}
      </p>
    </figure>
  )
}
