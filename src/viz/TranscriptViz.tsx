import { useMemo } from 'react'
import type { TranscriptView } from '../api/ensemblViz.ts'
import { layoutExons, linear } from './layout.ts'

const W = 720
const DOMAIN_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2']

/** エクソン構造（イントロン圧縮）とタンパク質ドメイン上のバリアント位置。 */
export function TranscriptViz({ view, variantPos, proteinPos, domainError }: {
  view: TranscriptView; variantPos?: number; proteinPos?: number; domainError?: string
}) {
  const lay = useMemo(() => layoutExons(view.exons, view.strand, W - 20, { start: view.cdsStart, end: view.cdsEnd }), [view])
  const vx = variantPos !== undefined ? lay.xOf(variantPos) : null
  const inExon = variantPos !== undefined && lay.exonAt(variantPos) !== null
  const plen = view.proteinLength
  const px = plen ? linear(1, plen, W - 20) : null
  const names = [...new Set(view.features.map((f) => `${f.db}:${f.name}`))]
  const color = (f: { db: string; name: string }) => DOMAIN_COLORS[names.indexOf(`${f.db}:${f.name}`) % DOMAIN_COLORS.length]
  // 重なるドメインは段を分ける
  const rows: number[] = []
  const lanes = view.features.map((f) => {
    let lane = rows.findIndex((end) => end < f.start)
    if (lane < 0) { lane = rows.length; rows.push(0) }
    rows[lane] = f.end
    return lane
  })
  const protH = 30 + rows.length * 14

  return (
    <figure className="viz" aria-label="エクソン構造とドメイン">
      <figcaption>
        {view.transcriptId}　エクソン {view.exons.length}（{view.strand === 1 ? '＋鎖' : '－鎖'}、イントロンは圧縮表示）
      </figcaption>
      <svg viewBox={`0 0 ${W} 70`} role="img" aria-label="エクソン構造">
        <g transform="translate(10,10)">
          <line x1={0} x2={lay.width} y1={30} y2={30} className="viz-axis" />
          {lay.boxes.map((b) => (
            <g key={b.index}>
              <rect x={b.x} y={18} width={b.width} height={24} className="viz-utr" />
              {b.cds && <rect x={b.cds.x} y={14} width={b.cds.width} height={32} className="viz-cds" />}
              {b.width > 14 && <text x={b.x + b.width / 2} y={60} textAnchor="middle" className="viz-label">{b.number}</text>}
            </g>
          ))}
          {vx !== null && (
            <g>
              <line x1={vx} x2={vx} y1={2} y2={50} className="viz-variant" />
              <circle cx={vx} cy={4} r={4} className="viz-variant-dot" />
              {!inExon && <text x={vx + 6} y={10} className="viz-label">イントロン</text>}
            </g>
          )}
        </g>
      </svg>
      <p className="viz-legend"><span className="sw cds" />コード領域 <span className="sw utr" />非翻訳領域 <span className="sw var" />バリアント</p>

      {px && plen && (
        <>
          <svg viewBox={`0 0 ${W} ${protH}`} role="img" aria-label="タンパク質ドメイン">
            <g transform="translate(10,6)">
              <rect x={0} y={0} width={W - 20} height={10} className="viz-protein" />
              {view.features.map((f, i) => (
                <g key={`${f.db}${f.name}${f.start}`}>
                  <rect x={px(f.start)} y={18 + lanes[i] * 14} width={Math.max(2, px(f.end) - px(f.start))} height={11} fill={color(f)} rx={2}>
                    <title>{f.db}: {f.name} ({f.start}-{f.end})</title>
                  </rect>
                </g>
              ))}
              {proteinPos !== undefined && proteinPos >= 1 && proteinPos <= plen && (
                <g>
                  <line x1={px(proteinPos)} x2={px(proteinPos)} y1={-4} y2={protH - 10} className="viz-variant" />
                  <circle cx={px(proteinPos)} cy={-3} r={4} className="viz-variant-dot" />
                </g>
              )}
            </g>
          </svg>
          <p className="viz-legend">
            アミノ酸 1–{plen}{proteinPos ? `　バリアント位置 ${proteinPos}` : ''}
            {names.map((n) => <span key={n} className="legend-item"><span className="sw" style={{ background: DOMAIN_COLORS[names.indexOf(n) % DOMAIN_COLORS.length] }} />{n}</span>)}
          </p>
          {!view.features.length && !domainError && <p className="muted">Pfam / PROSITE / SMART に登録されたドメインはありません。</p>}
        </>
      )}
      {domainError && <p className="warn">⚠ タンパク質ドメインの取得に失敗しました（{domainError}）。エクソン構造のみ表示しています。</p>}
    </figure>
  )
}
