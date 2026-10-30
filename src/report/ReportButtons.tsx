import { useMemo } from 'react'
import { ReportBlockedError, toJson, toText, type CnvReport, type SmallReport } from './report.ts'

function download(name: string, body: string, mime: string) {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** レポートの書き出し（JSON / テキスト）。版情報のないデータソースがあれば出力せず理由を示す。 */
export function ReportButtons({ build, filename }: { build: () => SmallReport | CnvReport; filename: string }) {
  const built = useMemo(() => {
    try {
      return { report: build() }
    } catch (e) {
      return { error: e instanceof ReportBlockedError ? e.message : `レポートを作成できません: ${e instanceof Error ? e.message : String(e)}` }
    }
  }, [build])
  const stamp = (built.report?.generatedAt ?? new Date().toISOString()).slice(0, 19).replace(/[-:T]/g, '')
  return (
    <div className="report-buttons">
      <span className="muted">レポート（取得日時と各データソースの版を含みます）:</span>
      <button type="button" disabled={!built.report} onClick={() => built.report && download(`${filename}-${stamp}.json`, toJson(built.report), 'application/json')}>JSON で保存</button>
      <button type="button" disabled={!built.report} onClick={() => built.report && download(`${filename}-${stamp}.txt`, toText(built.report), 'text/plain')}>テキストで保存</button>
      {built.error && <p className="warn" role="alert">⚠ {built.error}</p>}
    </div>
  )
}
