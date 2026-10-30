import type { SourceResult } from './api/http.ts'
import { compareWithAuto, type ErepoClass, type ErepoClassification } from './api/erepo.ts'

const CLASS_JA = { Pathogenic: '病的', 'Likely Pathogenic': '病的の可能性が高い', VUS: '意義不明', 'Likely Benign': '良性の可能性が高い', Benign: '良性' } as const
const CLASS_KEY = { Pathogenic: 'p', 'Likely Pathogenic': 'lp', VUS: 'vus', 'Likely Benign': 'lb', Benign: 'b' } as const

/** 専門家パネル（ERepo）の分類。自動判定より上に最優先で表示する。 */
export function ErepoPanel({ erepo, auto }: { erepo: SourceResult<ErepoClassification[]> | undefined; auto?: ErepoClass }) {
  if (!erepo) return null
  if (erepo.status === 'failed') {
    return <p className="warn" role="note">⚠ ClinGen Evidence Repository の取得に失敗したため、専門家パネルによる分類の有無は不明です（{erepo.error}）。「該当なし」ではありません。</p>
  }
  if (erepo.data.length === 0) {
    return <p className="muted erepo-none">ClinGen Evidence Repository に、このバリアントの専門家パネルによる分類は見つかりませんでした（{erepo.fetchedAt.slice(0, 10)} 時点）。</p>
  }
  return (
    <section className="erepo" aria-label="専門家パネルによる分類あり">
      <h3>専門家パネルによる分類あり</h3>
      {erepo.data.map((c, i) => {
        const cmp = auto ? compareWithAuto(c.classification, auto) : undefined
        return (
          <article key={`${c.url ?? ''}-${i}`} className="erepo-card">
            <div className="verdict">
              {c.classification ? (
                <span className={`badge badge-${CLASS_KEY[c.classification]}`}>{c.classification}（{CLASS_JA[c.classification]}）</span>
              ) : (
                <span className="badge">{c.outcomeLabel || '分類不明'}</span>
              )}
              <strong>{c.panel ?? '専門家パネル'}</strong>
              {c.publishedDate && <span className="muted">公開日 {c.publishedDate}</span>}
            </div>
            <p className="muted">
              {c.condition && <>疾患: {c.condition}　</>}
              {c.guideline && <>仕様: {c.guideline}{c.guidelineVersion ? `（v${c.guidelineVersion}）` : ''}　</>}
              {c.url && <a href={c.url} target="_blank" rel="noreferrer">ERepo の記録</a>}
            </p>
            {c.evidenceCodes.length > 0 && (
              <p className="codes">
                {c.evidenceCodes.filter((e) => /^met$/i.test(e.status) || !/not met/i.test(e.status)).map((e) => (
                  <span key={e.label} className="chip">{e.label}{e.status && !/^met$/i.test(e.status) ? `（${e.status}）` : ''}</span>
                ))}
              </p>
            )}
            {cmp && <p className={cmp.match ? 'note' : 'warn'}>{cmp.match ? '✓' : '⚠'} {cmp.message}（自動判定: {auto}）</p>}
            {c.warnings.map((w) => <p key={w} className="muted">ERepo 警告: {w}</p>)}
          </article>
        )
      })}
    </section>
  )
}
