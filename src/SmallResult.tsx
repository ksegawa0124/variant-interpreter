import { useMemo, useState } from 'react'
import { PM1_DOMAIN_DBS, SMALL_CODES, STRENGTH_LABEL, STRENGTH_POINTS, THRESHOLDS, type Strength } from './engine/rules.ts'
import { ErepoPanel } from './ErepoPanel.tsx'
import type { SmallAnalysis } from './engine/gather.ts'
import { autoEvaluate, scoreSmall, type CodeEvaluation, type EvalState, type ManualMap } from './engine/small.ts'

const STATE_LABEL: Record<EvalState, string> = {
  met: '該当',
  not_met: '非該当',
  not_applicable: '適用外',
  no_evidence: 'エビデンスなし',
  not_evaluable: '評価不可',
  candidate: '候補 – 要確認',
  manual: '手動入力',
}

const CLASS_JA = { Pathogenic: '病的', 'Likely Pathogenic': '病的の可能性が高い', VUS: '意義不明', 'Likely Benign': '良性の可能性が高い', Benign: '良性' } as const
const CLASS_KEY = { Pathogenic: 'p', 'Likely Pathogenic': 'lp', VUS: 'vus', 'Likely Benign': 'lb', Benign: 'b' } as const

const STRENGTHS: Strength[] = ['supporting', 'moderate', 'strong', 'very_strong', 'standalone']

function ManualControl({ ev, manual, onChange }: { ev: CodeEvaluation; manual: ManualMap; onChange: (m: ManualMap) => void }) {
  const m = manual[ev.id]
  const def = SMALL_CODES.find((c) => c.id === ev.id)!
  const options = def.direction === 'benign' ? STRENGTHS : STRENGTHS.filter((s) => s !== 'standalone')
  return (
    <div className="manual-ctl">
      <label>
        <input
          type="checkbox"
          checked={!!m?.met}
          onChange={(e) => onChange({ ...manual, [ev.id]: { ...m, met: e.target.checked } })}
        />
        {ev.state === 'candidate' ? '採用する' : '該当する'}
      </label>
      <select
        aria-label={`${ev.id} の強度`}
        value={m?.strength ?? ev.strength}
        onChange={(e) => onChange({ ...manual, [ev.id]: { met: !!m?.met, strength: e.target.value as Strength } })}
      >
        {options.map((s) => (
          <option key={s} value={s}>{STRENGTH_LABEL[s]}</option>
        ))}
      </select>
    </div>
  )
}

function CodeCard({ ev, points, counted, manual, onChange }: { ev: CodeEvaluation; points: number; counted: boolean; manual: ManualMap; onChange: (m: ManualMap) => void }) {
  const def = SMALL_CODES.find((c) => c.id === ev.id)!
  const interactive = !ev.vcepNotApplicable && (ev.state === 'candidate' || ev.state === 'manual')
  return (
    <article className={`code-card state-${ev.state}${counted ? ' counted' : ''}${ev.vcepNotApplicable ? ' vcep-na' : ''}`}>
      <header>
        <strong>{ev.id}</strong>
        <span className={`dir ${def.direction}`}>{def.direction === 'pathogenic' ? '病的' : '良性'}</span>
        <span className="state">{ev.vcepNotApplicable ? 'VCEP で適用不可' : STATE_LABEL[ev.state]}</span>
        <span className="pts">
          {counted ? `${STRENGTH_LABEL[ev.state === 'met' ? ev.strength : (manual[ev.id]?.strength ?? ev.strength)]} / ${points > 0 ? '+' : ''}${points} 点` : ''}
        </span>
      </header>
      <p className="title">{def.title}</p>
      {ev.reason && <p className="reason">{ev.reason}</p>}
      {ev.state === 'manual' && <p className="muted">{def.criterion}</p>}
      {ev.override && (
        <p className="override" role="note">
          ⚙ {ev.override.message}
        </p>
      )}
      {ev.notes.map((n) => (
        <p key={n} className="note">{n}</p>
      ))}
      {interactive && <ManualControl ev={ev} manual={manual} onChange={onChange} />}
    </article>
  )
}

export function SmallResultView({ a }: { a: SmallAnalysis }) {
  const [manual, setManual] = useState<ManualMap>({})
  const evals = useMemo(() => (a.evidence ? autoEvaluate(a.evidence) : []), [a.evidence])
  const result = useMemo(() => scoreSmall(evals, manual), [evals, manual])
  const tc = a.evidence?.transcript
  const pop = a.evidence?.population

  const domainNames = [...new Set((tc?.domains ?? []).filter((d) => PM1_DOMAIN_DBS.includes(d.db)).map((d) => `${d.db}:${d.name}`))]
  const consequence =tc?.consequenceTerms.join(', ') ?? '—'
  const freq =
    pop?.status === 'ok'
      ? pop.data.present && pop.data.af !== undefined
        ? `gnomAD ${pop.data.version ? 'v' + pop.data.version : '版不明'} 頻度 ${pop.data.af.toExponential(2)}（ホモ接合 ${pop.data.hom ?? '不明'}）`
        : `gnomAD ${pop.data.version ? 'v' + pop.data.version : '版不明'} に記載なし`
      : pop
        ? '集団頻度: 取得失敗'
        : ''

  return (
    <section className="result" aria-label="解析結果">
      <h2>解析結果（小変異）</h2>

      <div className="variant-head">
        <dl>
          <dt>CAid</dt><dd>{a.allele?.caid ?? '—'}</dd>
          <dt>遺伝子</dt><dd>{a.evidence?.gene ?? '—'}</dd>
          <dt>転写産物</dt><dd>{tc ? `${tc.transcriptId}${tc.maneSelect ? `（${tc.maneSelect}）` : ''}` : '—'}<span className="muted">　{a.choice?.note}</span></dd>
          <dt>HGVS.c</dt><dd>{tc?.hgvsc ?? '—'}</dd>
          <dt>HGVS.p</dt><dd>{tc?.hgvsp ?? '—'}</dd>
          <dt>ゲノム座標</dt><dd>{a.genomicHgvs ?? '—'}（{a.genome}）</dd>
        </dl>
      </div>

      <ErepoPanel erepo={a.erepo} auto={a.evidence ? result.classification : undefined} />

      {a.alleleCandidates > 1 &&<p className="warn">⚠ 入力に対応するアレルが {a.alleleCandidates} 件あります。先頭の {a.allele?.caid} を使用しています（多アレル部位は HGVS で指定してください）</p>}
      {a.fatal && <p className="warn" role="alert">⚠ {a.fatal}</p>}

      {a.evidence && (
        <>
          {a.erepo?.status === 'ok' && a.erepo.data.length > 0 && <p className="muted">以下は本アプリの自動判定（参考）です。専門家パネルの分類が優先されます。</p>}
          <div className="verdict">
            <span className={`badge badge-${CLASS_KEY[result.classification]}`}>
              {result.classification}（{CLASS_JA[result.classification]}）
            </span>
            <span className="total">合計 {result.total > 0 ? '+' : ''}{result.total} 点</span>
            <span className="muted">病的 +{result.pathogenicPoints} / 良性 {result.benignPoints}</span>
            {result.notEvaluable.length > 0 && <span className="provisional">暫定</span>}
          </div>

          <p className="brief">
            {consequence}
            {tc?.exon ? `　エクソン ${tc.exon}` : tc?.intron ? `　イントロン ${tc.intron}` : ''}
            {domainNames.length ? `　ドメイン: ${domainNames.join(', ')}` : ''}
            {freq ? `　${freq}` : ''}
          </p>

          {result.warnings.map((w) => (
            <p key={w} className="warn">⚠ {w}</p>
          ))}

          <h3>エビデンス</h3>
          <p className="muted">
            既定の閾値: BA1 ≥ {THRESHOLDS.ba1Af}、BS1 ≥ {THRESHOLDS.bs1Af}、PM2 ≤ {THRESHOLDS.pm2Af}（または不在）、BS2 ホモ接合 ≥ {THRESHOLDS.bs2Hom}。
            VCEP 仕様がある遺伝子は強度を上書きし、頻度閾値は自動では置換せず要確認として表示します。
            点数: Supporting {STRENGTH_POINTS.supporting} / Moderate {STRENGTH_POINTS.moderate} / Strong {STRENGTH_POINTS.strong} / Very Strong {STRENGTH_POINTS.very_strong}。
          </p>
          <div className="cards">
            {result.evaluations.map((ev) => {
              const s = result.scored.find((x) => x.id === ev.id)!
              return <CodeCard key={ev.id} ev={ev} points={s.points} counted={s.counted} manual={manual} onChange={setManual} />
            })}
          </div>
        </>
      )}

      <h3>データソースと取得時刻</h3>
      <table className="sources">
        <thead>
          <tr><th>ソース</th><th>状態</th><th>取得時刻 (UTC)</th><th>版</th></tr>
        </thead>
        <tbody>
          {a.sources.map((s, i) => (
            <tr key={`${s.name}-${i}`} className={s.status === 'failed' ? 'failed' : ''}>
              <td>{s.name}</td>
              <td>{s.status === 'ok' ? '取得済み' : `取得失敗: ${s.error}`}</td>
              <td>{s.fetchedAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{s.version ?? '版不明'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
