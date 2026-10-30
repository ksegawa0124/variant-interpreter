import { useMemo, useState } from 'react'
import { autoEvaluateCnv, formatCnvPoints, scoreCnv, type CnvItemEval, type CnvManualMap } from './cnv/engine.ts'
import type { CnvAnalysis } from './cnv/gather.ts'
import { CnvViz } from './viz/CnvViz.tsx'
import { CNV_CLASSES, CNV_ITEMS, INTRAGENIC_OPTIONS, cnvItemsFor } from './cnv/rules.ts'

const CLASS_JA = { Pathogenic: '病的', 'Likely Pathogenic': '病的の可能性が高い', VUS: '意義不明', 'Likely Benign': '良性の可能性が高い', Benign: '良性' } as const
const CLASS_KEY = { Pathogenic: 'p', 'Likely Pathogenic': 'lp', VUS: 'vus', 'Likely Benign': 'lb', Benign: 'b' } as const
const STATE_LABEL = { met: '該当', not_met: '代替案', not_evaluable: '評価不可', manual: '手動入力' } as const
const GENE_LIMIT = 200
/** undefined = Dosage に遺伝子なし / null = 未評価 / 30 = 常染色体劣性 / 40 = 感受性なしの可能性が高い */
const score = (v: number | null | undefined) => (v === undefined ? '—' : v === null ? '未評価' : v === 30 ? '30 (AR)' : v === 40 ? '40 (unlikely)' : String(v))
const signed = (p: number) => `${p > 0 ? '+' : ''}${formatCnvPoints(p)}`

function ItemCard({ it, type, manual, onChange, counted }: {
  it: CnvItemEval; type: 'LOSS' | 'GAIN'; manual: CnvManualMap; onChange: (m: CnvManualMap) => void; counted?: number
}) {
  const def = CNV_ITEMS.find((i) => i.id === it.id && i.types.includes(type))
  const m = manual[it.key]
  const on = m?.on ?? it.state === 'met'
  const isIntragenic = it.id === '2E' || it.id === '2I'
  const set = (patch: object) => onChange({ ...manual, [it.key]: { ...m, ...patch } })
  const editable = it.state !== 'not_evaluable' && !!def
  return (
    <article className={`code-card state-${it.state === 'manual' ? 'manual' : it.state}${counted !== undefined ? ' counted' : ''}`}>
      <header>
        <strong>{it.id}</strong>
        {it.basis && <span className="muted">{it.basis}</span>}
        <span className="state">{STATE_LABEL[it.state]}</span>
        <span className="pts">{counted !== undefined ? `${signed(counted)} 点` : ''}</span>
      </header>
      {def && <p className="title">{def.title}</p>}
      {it.reason && <p className="reason">{it.reason}</p>}
      {it.notes.map((n) => <p key={n} className="note">{n}</p>)}
      {editable && (
        <div className="manual-ctl">
          <label>
            <input type="checkbox" checked={on} onChange={(e) => set({ on: e.target.checked })} />
            採用する
          </label>
          {isIntragenic ? (
            <select aria-label={`${it.id} PVS1 の強度`} value={m?.points ?? 0} onChange={(e) => set({ points: Number(e.target.value), on: Number(e.target.value) > 0 })}>
              {INTRAGENIC_OPTIONS[type].map((o) => <option key={o.label} value={o.points}>{o.label}（{formatCnvPoints(o.points)}）</option>)}
            </select>
          ) : def && def.min !== def.max ? (
            <label>
              点
              <input
                type="number" step={0.05} min={def.min / 100} max={def.max / 100} style={{ width: '5.5rem' }}
                value={(m?.points ?? it.points) / 100}
                onChange={(e) => set({ points: Math.round(Number(e.target.value) * 100) })}
              />
            </label>
          ) : null}
          {def?.perUnit && (
            <label>
              {def.perUnit}数
              <input type="number" min={0} step={1} style={{ width: '4rem' }} value={m?.n ?? 1} onChange={(e) => set({ n: Number(e.target.value) })} />
            </label>
          )}
          {def && <span className="muted">範囲 {formatCnvPoints(def.min)}〜{formatCnvPoints(def.max)}</span>}
        </div>
      )}
    </article>
  )
}

export function CnvResultView({ a }: { a: CnvAnalysis }) {
  const [manual, setManual] = useState<CnvManualMap>({})
  const [showAllGenes, setShowAllGenes] = useState(false)
  const auto = useMemo(() => autoEvaluateCnv(a.evidence), [a.evidence])
  const r = useMemo(() => scoreCnv(a.evidence, auto, manual), [a.evidence, auto, manual])
  const { region } = a.evidence
  const type = region.type
  const countedBy = (key: string) => r.counted.find((c) => c.key === key)?.points
  const len = region.end - region.start + 1
  const overlappingRegions = useMemo(
    () => (a.evidence.dosageRegions.status === 'ok'
      ? a.evidence.dosageRegions.data.entries.filter((e) => e.chrom === region.chrom && e.end >= region.start && e.start <= region.end)
      : []),
    [a.evidence.dosageRegions, region],
  )

  const geneRows = useMemo(() => {
    const annotated = (g: (typeof r.genes)[number]) => (g.hi != null || g.ts != null ? 0 : g.gdv ? 1 : 2)
    return [...r.genes].sort((x, y) => annotated(x) - annotated(y) || x.start - y.start)
  }, [r])
  const shownGenes = showAllGenes ? geneRows : geneRows.slice(0, GENE_LIMIT)
  const bySection = (s: number) => r.items.filter((i) => i.section === s)
  const manualOf = (s: number) => bySection(s).filter((i) => i.state === 'manual')

  return (
    <section className="result" aria-label="CNV 解析結果">
      <h2>解析結果（CNV）</h2>
      <div className="variant-head">
        <dl>
          <dt>種別</dt><dd>{type === 'LOSS' ? 'Copy number loss（欠失）' : 'Copy number gain（重複）'}</dd>
          <dt>座標</dt><dd>chr{region.chrom}:{region.start.toLocaleString()}-{region.end.toLocaleString()}（{a.genome}、{len.toLocaleString()} bp）</dd>
          <dt>コード遺伝子数</dt><dd>{r.geneCount ?? '取得失敗'}</dd>
        </dl>
      </div>

      <div className="verdict">
        <span className={`badge badge-${CLASS_KEY[r.classification]}`}>{r.classification}（{CLASS_JA[r.classification]}）</span>
        <span className="total">合計 {signed(r.total)} 点</span>
        <span className="muted">S1 {signed(r.sectionPoints[1])} / S2 {signed(r.sectionPoints[2])} / S3 {signed(r.sectionPoints[3])} / S4 {signed(r.sectionPoints[4])} / S5 {signed(r.sectionPoints[5])}</span>
        {r.notEvaluable.length > 0 && <span className="provisional">暫定</span>}
      </div>
      <p className="muted">
        分類境界: {CNV_CLASSES.map((c) => `${c.label} ${Number.isFinite(c.min) ? formatCnvPoints(c.min) : '…'}〜${Number.isFinite(c.max) ? formatCnvPoints(c.max) : '…'}`).join(' / ')}
      </p>
      {r.warnings.map((w) => <p key={w} className="warn">⚠ {w}</p>)}

      <CnvViz
        region={{ ...region, type }} genes={r.genes} dosageRegions={overlappingRegions}
        chromosome={a.chromosome.status === 'ok' ? a.chromosome.data : undefined}
        chromError={a.chromosome.status === 'failed' ? a.chromosome.error : undefined}
      />

      {[1, 2, 3].map((s) => (
        <div key={s}>
          <h3>Section {s}: {['', '遺伝子内容の初期評価', 'ハプロ不全/トリプロ感受性・既知 CNV との重なり', '重複する遺伝子数'][s]}（自動）</h3>
          <div className="cards">
            {bySection(s).filter((i) => i.state !== 'manual' || s === 2).filter((i) => s !== 2 || i.state !== 'manual' || i.basis).map((it) => (
              <ItemCard key={it.key} it={it} type={type} manual={manual} onChange={setManual} counted={countedBy(it.key)} />
            ))}
          </div>
          {s === 2 && (
            <details>
              <summary>Section 2 の手動項目（良性 CNV との重なり・遺伝子内・HI 予測）</summary>
              <div className="cards">
                {manualOf(2).filter((i) => !i.basis).map((it) => (
                  <ItemCard key={it.key} it={it} type={type} manual={manual} onChange={setManual} counted={countedBy(it.key)} />
                ))}
              </div>
            </details>
          )}
        </div>
      ))}

      {[4, 5].map((s) => (
        <details key={s} open={s === 4}>
          <summary>Section {s}: {s === 4 ? '症例・家系・症例対照のエビデンス' : '遺伝形式'}（手動入力）</summary>
          {s === 5 && <p className="muted">5A・5D・5E は Section 4 の項目（4A–4D / 4F–4H / 4I–4K）で入力します。</p>}
          <div className="cards">
            {manualOf(s).map((it) => <ItemCard key={it.key} it={it} type={type} manual={manual} onChange={setManual} counted={countedBy(it.key)} />)}
          </div>
        </details>
      ))}

      <h3>重複する遺伝子（{r.genes.length}）</h3>
      <p className="muted">HI/TS は ClinGen Dosage Sensitivity、GDV は Gene-Disease Validity の最上位分類。Dosage 評価のある遺伝子を先頭に表示します。</p>
      <div className="table-wrap">
        <table className="sources genes">
          <thead><tr><th>遺伝子</th><th>座標</th><th>HI</th><th>TS</th><th>GDV</th><th>領域に完全包含</th></tr></thead>
          <tbody>
            {shownGenes.map((g) => (
              <tr key={g.symbol + g.start}>
                <td>{g.symbol}</td><td>{g.start.toLocaleString()}-{g.end.toLocaleString()}</td>
                <td>{score(g.hi)}</td><td>{score(g.ts)}</td>
                <td>{g.gdv ? `${g.gdv}（${g.gdvDiseases}）` : '—'}</td><td>{g.contained ? '○' : '一部'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {geneRows.length > GENE_LIMIT && (
        <button type="button" onClick={() => setShowAllGenes((v) => !v)}>{showAllGenes ? '先頭 200 件のみ表示' : `すべて表示（${geneRows.length}）`}</button>
      )}

      <h3>データソースと取得時刻</h3>
      <table className="sources">
        <thead><tr><th>ソース</th><th>状態</th><th>取得時刻 (UTC)</th><th>版</th></tr></thead>
        <tbody>
          {a.sources.map((s, i) => (
            <tr key={`${s.name}-${i}`} className={s.status === 'failed' ? 'failed' : ''}>
              <td>{s.name}</td><td>{s.status === 'ok' ? '取得済み' : `取得失敗: ${s.error}`}</td>
              <td>{s.fetchedAt.replace('T', ' ').slice(0, 19)}</td><td>{s.version ?? '版不明'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">使用ルール: ACMG/ClinGen CNV 技術標準 2019（Riggs et al. 2020）。項目数 {cnvItemsFor(type).length}。</p>
    </section>
  )
}
