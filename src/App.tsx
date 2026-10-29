export const DISCLAIMER =
  '本アプリは研究および解釈支援を目的とします。診断行為には用いず、最終判断は資格を持つ担当者が行ってください。'

export const PRIVACY_NOTICE =
  '外部 API をブラウザから直接呼び出します。患者個人情報は一切入力しないでください。'

function App() {
  return (
    <>
      <header className="app-disclaimer" role="note">
        {DISCLAIMER}
      </header>
      <main>
        <h1>Variant Interpreter</h1>
        <p>ClinGen 公開リソースに基づく遺伝子バリアント解釈支援（開発中: Phase 1）</p>
        <p className="privacy-notice">{PRIVACY_NOTICE}</p>
      </main>
    </>
  )
}

export default App
