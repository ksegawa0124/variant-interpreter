import { useMemo, useState } from 'react'
import { parseVariantInput, type Genome } from './input/parseInput.ts'
import { routeInput, type Engine } from './input/route.ts'
import { analyzeSmall, type SmallAnalysis } from './engine/gather.ts'
import { SmallResultView } from './SmallResult.tsx'
import { CnvResultView } from './CnvResult.tsx'
import { analyzeCnv, toCnvRegion, type CnvAnalysis } from './cnv/gather.ts'
import { loadSettings, saveSettings, sanitizeSettings, type Settings } from './settings.ts'
import './App.css'

export const DISCLAIMER =
  '本アプリは研究および解釈支援を目的とします。診断行為には用いず、最終判断は資格を持つ担当者が行ってください。'

export const PRIVACY_NOTICE =
  '外部 API をブラウザから直接呼び出します。患者個人情報は一切入力しないでください。'

const ENGINE_LABEL: Record<Engine, string> = {
  small: '小変異エンジン（ACMG/AMP）',
  cnv: 'CNV エンジン（ClinGen 2019 技術標準）',
  deferred: '解決後に判定',
  invalid: '判別不能',
}

const KIND_LABEL = {
  hgvs_c: 'HGVS.c',
  hgvs_g: 'HGVS.g',
  rsid: 'rsID',
  caid: 'ClinGen CAid',
  cnv: 'CNV 座標',
  iscn: 'ISCN',
  unknown: '不明',
} as const

function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [showSettings, setShowSettings] = useState(false)
  const [genome, setGenome] = useState<Genome>(settings.defaultGenome)
  const [transcript, setTranscript] = useState('')
  const [gene, setGene] = useState('')
  const [variant, setVariant] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<SmallAnalysis | null>(null)
  const [cnv, setCnv] = useState<CnvAnalysis | null>(null)
  const [cnvError, setCnvError] = useState<string | null>(null)

  const parsed = useMemo(() => parseVariantInput(variant), [variant])
  const route = useMemo(() => routeInput(parsed, genome, settings), [parsed, genome, settings])

  // 空欄時の自動補完を表示する（実際の解決は Allele Registry / MANE 検索の結果で置き換える）
  const resolvedGenomeNote = genome === 'GRCh38' ? 'GRCh38/hg38（既定）' : 'GRCh37/hg19'
  const geneHint = gene || (parsed.kind === 'hgvs_c' && parsed.gene) || ''

  const applySettings = (s: Settings) => {
    const clean = sanitizeSettings(s)
    setSettings(clean)
    saveSettings(clean)
  }

  return (
    <>
      <header className="app-disclaimer" role="note">
        {DISCLAIMER}
      </header>
      <main>
        <div className="title-row">
          <h1>Variant Interpreter</h1>
          <button type="button" onClick={() => setShowSettings(true)}>
            設定
          </button>
        </div>
        <p>ClinGen 公開リソースに基づく遺伝子バリアント解釈支援（開発中: Phase 7）</p>

        <form
          className="home-form"
          onSubmit={(e) => {
            e.preventDefault()
            const v = variant.trim()
            if (!v) return
            setSubmitted(v)
            setAnalysis(null)
            setCnv(null)
            setCnvError(null)
            if (route.engine === 'cnv') {
              const t = toCnvRegion(parsed, genome)
              if ('error' in t) return setCnvError(t.error)
              setBusy(true)
              analyzeCnv(t.region, route.genome ?? t.genome)
                .then(setCnv)
                .catch((err) => setCnvError(`予期しないエラー: ${err}`))
                .finally(() => setBusy(false))
              return
            }
            if (route.engine !== 'small') return
            setBusy(true)
            analyzeSmall(parsed, genome, gene.trim() || undefined, transcript.trim() || undefined)
              .then(setAnalysis)
              .catch((err) => setAnalysis({ genome, allele: null, alleleCandidates: 0, vep: null, choice: null, evidence: null, sources: [], fatal: `予期しないエラー: ${err}` }))
              .finally(() => setBusy(false))
          }}
        >
          <label>
            リファレンスゲノム
            <select value={genome} onChange={(e) => setGenome(e.target.value as Genome)}>
              <option value="GRCh38">GRCh38/hg38</option>
              <option value="GRCh37">GRCh37/hg19</option>
            </select>
          </label>
          <label>
            参照配列（任意）
            <input
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="NM_*******.*　未入力なら MANE Select を自動検索"
            />
          </label>
          <label>
            遺伝子（任意）
            <input
              value={gene}
              onChange={(e) => setGene(e.target.value)}
              placeholder={geneHint || 'BRCA1, TSC2, SCN4A など　未入力なら HGVS から解決'}
            />
          </label>
          <label>
            バリアントの詳細（必須）
            <input
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="NM_000546.6:c.743G>A / rs11540652 / chr7:72663000-74133000 DEL"
              required
            />
          </label>
          <p className="privacy-notice">{PRIVACY_NOTICE}</p>
          <button type="submit" disabled={route.engine === 'invalid' || !variant.trim()}>
            解析
          </button>
        </form>

        {variant.trim() && (
          <section className="detect" aria-live="polite">
            <p>
              判別: <strong>{KIND_LABEL[parsed.kind]}</strong>　→　<strong>{ENGINE_LABEL[route.engine]}</strong>
            </p>
            <p className="muted">
              {route.reason}（ゲノム: {route.genome ?? resolvedGenomeNote}）
            </p>
            {route.warnings.map((w) => (
              <p key={w} className="warn">
                ⚠ {w}
              </p>
            ))}
          </section>
        )}

        {busy && <p className="muted" role="status">解析中…（外部 API を呼び出しています）</p>}
        {submitted && !busy && route.engine === 'small' && analysis && <SmallResultView key={submitted} a={analysis} />}
        {cnvError && <p className="warn" role="alert">⚠ {cnvError}</p>}
        {submitted && !busy && route.engine === 'cnv' && cnv && <CnvResultView key={submitted} a={cnv} />}
        {submitted && !busy && route.engine !== 'small' && route.engine !== 'cnv' && route.engine !== 'invalid' && (
          <p className="muted">「{submitted}」は {ENGINE_LABEL[route.engine]} の対象です。このエンジンは後続フェーズで接続します。</p>
        )}
      </main>

      {showSettings && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="設定">
          <div className="dialog">
            <h2>設定</h2>
            <label>
              CNV 振り分け閾値（bp。この長さ以上の del/dup を CNV エンジンへ）
              <input
                type="number"
                min={1}
                value={settings.cnvThresholdBp}
                onChange={(e) => applySettings({ ...settings, cnvThresholdBp: Number(e.target.value) })}
              />
            </label>
            <label>
              既定のリファレンスゲノム
              <select
                value={settings.defaultGenome}
                onChange={(e) => applySettings({ ...settings, defaultGenome: e.target.value as Genome })}
              >
                <option value="GRCh38">GRCh38/hg38</option>
                <option value="GRCh37">GRCh37/hg19</option>
              </select>
            </label>
            <button type="button" onClick={() => setShowSettings(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default App
