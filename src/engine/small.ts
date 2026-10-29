// 小変異エンジン：エビデンス入力 → コードごとの判定 → 点数 → 分類。
// 閾値・点数・分類境界は rules.ts の宣言を参照する。ネットワークには依存しない純粋関数。
import type { SourceResult } from '../api/http.ts'
import type { VepTranscriptConsequence } from '../api/vep.ts'
import type { CSpecCode, CSpecDoc, DosageEntry } from '../data/convert.ts'
import {
  CSPEC_STRENGTH, INFRAME_CONSEQUENCES, LOF_CONSEQUENCES, PM1_DOMAIN_DBS,
  REVEL_CALIBRATION, SMALL_CODES, STANDALONE_CODE, STRENGTH_LABEL, STRENGTH_POINTS, THRESHOLDS, classifyPoints,
  type ClassTier, type Strength,
} from './rules.ts'

// ---------- 入力 ----------

export interface PopulationData {
  /** gnomAD に該当バリアントがあったか */
  present: boolean
  af?: number
  hom?: number
  an?: number
  /** 例: gnomad_genome */
  dataset: string
  /** 例: 2.1.1（頻度系コードに必ず併記する） */
  version?: string
}

export interface ClinvarCodonVariant {
  /** 置換後アミノ酸（3 文字） */
  alt: string
  /** 審査基準ありで P/LP */
  plp: boolean
  /** 審査基準ありで B/LB */
  blb: boolean
  /** MyVariant の _id（ゲノム HGVS）。入力自身の除外に使う */
  id: string
  clinvarId?: number
}

export interface SmallEvidence {
  gene?: string
  transcript: VepTranscriptConsequence | null
  /** 入力バリアント自身のゲノム HGVS 由来 ID（PS1/PM5 で自身を除外する） */
  selfId?: string
  population: SourceResult<PopulationData>
  revel: SourceResult<number | undefined>
  splice: SourceResult<{ maxDelta: number }>
  clinvarCodon: SourceResult<ClinvarCodonVariant[]>
  dosage: SourceResult<DosageEntry | null>
  cspec: CSpecDoc[]
}

// ---------- 出力 ----------

export type EvalState =
  | 'met' // 該当
  | 'not_met' // 評価した上で非該当
  | 'not_applicable' // この変異型には適用しない
  | 'no_evidence' // 取得できたがエビデンスが無い
  | 'not_evaluable' // 取得失敗等で評価できない
  | 'candidate' // 候補（人が確認して採用）
  | 'manual' // 人が入力

export interface CSpecOverride {
  specId: string
  specLabel: string
  kind: 'strength' | 'not_applicable' | 'threshold_unverified' | 'ambiguous'
  from?: Strength
  to?: Strength
  message: string
}

export interface CodeEvaluation {
  id: string
  state: EvalState
  /** 自動判定時点の（CSpec 上書き後の）強度 */
  strength: Strength
  reason: string
  /** 画面に併記する補足（gnomAD の版など） */
  notes: string[]
  override?: CSpecOverride
  /** VCEP 仕様で適用不可（採点しない） */
  vcepNotApplicable: boolean
  /** 参照したデータソース */
  sources: string[]
}

export interface ManualInput {
  met: boolean
  strength?: Strength
}
export type ManualMap = Record<string, ManualInput>

export interface ScoredCode {
  id: string
  counted: boolean
  strength: Strength
  points: number
}

export interface SmallResult {
  evaluations: CodeEvaluation[]
  scored: ScoredCode[]
  pathogenicPoints: number
  benignPoints: number
  total: number
  classification: ClassTier['label']
  /** BA1 などの単独基準で確定した場合の説明 */
  standaloneApplied: boolean
  warnings: string[]
  /** 評価不可のコード（暫定分類の注意喚起に使う） */
  notEvaluable: string[]
}

// ---------- ヘルパ ----------

const pct = (x: number) => `${(x * 100).toPrecision(3)}%`
const fmtAf = (x: number) => (x === 0 ? '0' : x < 0.0001 ? x.toExponential(2) : x.toPrecision(3))

function freqNote(p: PopulationData): string[] {
  return [`gnomAD ${p.version ? 'v' + p.version : '版不明'}（${p.dataset}）`]
}

const THREE = /^p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2}|=|Ter|\*)/

/** VEP の hgvsp（"ENSP…:p.Arg248Gln"）からミスセンス変化を取り出す。 */
export function parseProteinChange(hgvsp?: string): { ref: string; pos: number; alt: string } | null {
  const m = THREE.exec(hgvsp?.split(':').pop() ?? '')
  if (!m || m[3] === '=' || m[3] === 'Ter' || m[3] === '*') return null
  return { ref: m[1], pos: Number(m[2]), alt: m[3] }
}

const has = (tc: VepTranscriptConsequence | null, terms: readonly string[]) => !!tc?.consequenceTerms.some((t) => terms.includes(t))
const isMissense = (tc: VepTranscriptConsequence | null) => has(tc, ['missense_variant'])

const failedReason = (r: SourceResult<unknown>) => (r.status === 'failed' ? `${r.source} 取得失敗: ${r.error}` : '')

function base(id: string): CodeEvaluation {
  const def = SMALL_CODES.find((c) => c.id === id)!
  return { id, state: 'not_met', strength: def.defaultStrength, reason: '', notes: [], vcepNotApplicable: false, sources: [] }
}

// ---------- 個別コードの自動判定 ----------

function evalFreq(id: 'BA1' | 'BS1', ev: SmallEvidence, threshold: number): CodeEvaluation {
  const e = base(id)
  e.sources = ['gnomAD (MyVariant.info)']
  if (ev.population.status === 'failed') return { ...e, state: 'not_evaluable', reason: failedReason(ev.population) }
  const p = ev.population.data
  e.notes = freqNote(p)
  if (!p.present || p.af === undefined) return { ...e, state: 'not_met', reason: 'gnomAD に記載なし（頻度 0 扱い）' }
  const met = p.af >= threshold
  return { ...e, state: met ? 'met' : 'not_met', reason: `頻度 ${fmtAf(p.af)}（${pct(p.af)}）${met ? '≥' : '<'} 閾値 ${threshold}` }
}

function evalBS2(ev: SmallEvidence): CodeEvaluation {
  const e = base('BS2')
  e.sources = ['gnomAD (MyVariant.info)']
  if (ev.population.status === 'failed') return { ...e, state: 'not_evaluable', reason: failedReason(ev.population) }
  const p = ev.population.data
  e.notes = freqNote(p)
  if (!p.present) return { ...e, state: 'not_met', reason: 'gnomAD に記載なし' }
  if (p.hom === undefined) return { ...e, state: 'no_evidence', reason: 'ホモ接合数の情報なし' }
  const met = p.hom >= THRESHOLDS.bs2Hom
  return { ...e, state: met ? 'met' : 'not_met', reason: `ホモ接合 ${p.hom} 人 ${met ? '≥' : '<'} 閾値 ${THRESHOLDS.bs2Hom}` }
}

function evalPM2(ev: SmallEvidence): CodeEvaluation {
  const e = base('PM2')
  e.sources = ['gnomAD (MyVariant.info)']
  if (ev.population.status === 'failed') return { ...e, state: 'not_evaluable', reason: failedReason(ev.population) }
  const p = ev.population.data
  e.notes = freqNote(p)
  if (!p.present || p.af === undefined) {
    return { ...e, state: 'met', reason: 'gnomAD に不在', notes: [...e.notes, '不在は当該部位のカバレッジが十分である前提。深度は未確認'] }
  }
  const met = p.af <= THRESHOLDS.pm2Af
  return { ...e, state: met ? 'met' : 'not_met', reason: `頻度 ${fmtAf(p.af)} ${met ? '≤' : '>'} 閾値 ${THRESHOLDS.pm2Af}` }
}

function evalInSilico(id: 'PP3' | 'BP4', ev: SmallEvidence): CodeEvaluation {
  const e = base(id)
  e.sources = ['REVEL (MyVariant.info / dbNSFP)']
  if (!isMissense(ev.transcript)) return { ...e, state: 'not_applicable', reason: 'ミスセンス以外には適用しない（スプライス予測は未接続）' }
  if (ev.revel.status === 'failed') return { ...e, state: 'not_evaluable', reason: failedReason(ev.revel) }
  const r = ev.revel.data
  if (r === undefined) return { ...e, state: 'no_evidence', reason: 'REVEL スコアなし' }
  const tier = id === 'PP3'
    ? REVEL_CALIBRATION.pathogenic.find((t) => r >= t.min)
    : REVEL_CALIBRATION.benign.find((t) => r <= t.max)
  if (!tier) return { ...e, state: 'not_met', reason: `REVEL ${r.toFixed(3)}（較正上の判定域外）` }
  return { ...e, state: 'met', strength: tier.strength, reason: `REVEL ${r.toFixed(3)} → 較正上 ${STRENGTH_LABEL[tier.strength]}`, notes: ['Pejaver 2022 の較正閾値'] }
}

function evalBP7(ev: SmallEvidence): CodeEvaluation {
  const e = base('BP7')
  const tc = ev.transcript
  if (!has(tc, ['synonymous_variant'])) return { ...e, state: 'not_applicable', reason: '同義置換ではない' }
  e.sources = ['SpliceAI']
  if (ev.splice.status === 'failed') return { ...e, state: 'not_evaluable', reason: `スプライス影響を確認できないため評価不可（${failedReason(ev.splice)}）` }
  const d = ev.splice.data.maxDelta
  const met = d < 0.1
  return { ...e, state: met ? 'met' : 'not_met', reason: `SpliceAI 最大 Δ ${d.toFixed(2)} ${met ? '<' : '≥'} 0.1` }
}

function evalPM4(ev: SmallEvidence): CodeEvaluation {
  const e = base('PM4')
  const tc = ev.transcript
  if (has(tc, ['frameshift_variant']) || !has(tc, INFRAME_CONSEQUENCES)) return { ...e, state: 'not_applicable', reason: 'インフレーム長変化/終止コドン消失ではない' }
  return { ...e, state: 'met', reason: `${tc!.consequenceTerms.filter((t) => INFRAME_CONSEQUENCES.includes(t)).join(', ')}`, notes: ['反復領域かどうかは未判定。反復領域なら不採用'], sources: ['Ensembl VEP'] }
}

function evalPM1(ev: SmallEvidence): CodeEvaluation {
  const e = base('PM1')
  e.sources = ['Ensembl VEP (domains)']
  if (!isMissense(ev.transcript)) return { ...e, state: 'not_applicable', reason: 'ミスセンス以外には適用しない' }
  const doms = (ev.transcript?.domains ?? []).filter((d) => PM1_DOMAIN_DBS.includes(d.db))
  if (!doms.length) return { ...e, state: 'not_met', reason: '注釈された機能ドメイン内ではない' }
  return { ...e, state: 'met', reason: `ドメイン内: ${doms.map((d) => `${d.db}:${d.name}`).join(', ')}`, notes: ['ホットスポット/VCEP 仕様のドメイン定義は未検証'] }
}

function evalCodon(id: 'PS1' | 'PM5', ev: SmallEvidence, ps1Met: boolean): CodeEvaluation {
  const e = base(id)
  e.sources = ['ClinVar (MyVariant.info)']
  const pc = parseProteinChange(ev.transcript?.hgvsp)
  if (!isMissense(ev.transcript) || !pc) return { ...e, state: 'not_applicable', reason: 'ミスセンス以外には適用しない' }
  if (ev.clinvarCodon.status === 'failed') return { ...e, state: 'not_evaluable', reason: failedReason(ev.clinvarCodon) }
  const others = ev.clinvarCodon.data.filter((v) => v.id !== ev.selfId && v.plp)
  const same = others.filter((v) => v.alt === pc.alt)
  const diff = others.filter((v) => v.alt !== pc.alt)
  const cite = (vs: ClinvarCodonVariant[]) => vs.slice(0, 3).map((v) => `VCV${v.clinvarId ?? '?'}(p.${pc.ref}${pc.pos}${v.alt})`).join(', ')
  if (id === 'PS1') {
    return same.length
      ? { ...e, state: 'met', reason: `同一置換が ClinVar で P/LP: ${cite(same)}`, notes: ['別の塩基変化による同一アミノ酸置換であることを確認'] }
      : { ...e, state: others.length || ev.clinvarCodon.data.length ? 'not_met' : 'no_evidence', reason: '同一アミノ酸置換の P/LP なし' }
  }
  if (ps1Met) return { ...e, state: 'not_applicable', reason: 'PS1 が成立するため PM5 は適用しない' }
  return diff.length
    ? { ...e, state: 'met', reason: `同一残基の別置換が ClinVar で P/LP: ${cite(diff)}` }
    : { ...e, state: ev.clinvarCodon.data.length ? 'not_met' : 'no_evidence', reason: '同一残基の別置換の P/LP なし' }
}

function evalPVS1(ev: SmallEvidence): CodeEvaluation {
  const e = base('PVS1')
  const tc = ev.transcript
  if (!has(tc, LOF_CONSEQUENCES)) return { ...e, state: 'not_applicable', reason: 'LoF 型の consequence ではない' }
  const terms = tc!.consequenceTerms.filter((t) => LOF_CONSEQUENCES.includes(t))
  const notes: string[] = ['要確認: LoF が疾患機序か / NMD を受けるか / 代替転写産物・救済の有無']
  if (ev.dosage.status === 'failed') notes.push(`LoF 機序の根拠(Dosage)は ${failedReason(ev.dosage)}`)
  else if (ev.dosage.data === null) notes.push('ClinGen Dosage に当該遺伝子の評価なし。LoF 機序を別途確認')
  else if (ev.dosage.data.hi === 3) notes.push('ClinGen Dosage: HI=3（ハプロ不全が十分に確立）')
  else notes.push(`ClinGen Dosage: HI=${ev.dosage.data.hi ?? '未評価'}（ハプロ不全の確立が不十分/未評価）`)
  const exon = tc!.exon
  const last = exon && /^(\d+)\/\1$/.test(exon)
  if (last && has(tc, ['stop_gained', 'frameshift_variant'])) notes.push(`最終エクソン(${exon}): NMD を回避する可能性 → Strong 以下を検討`)
  if (has(tc, ['start_lost'])) notes.push('開始コドン消失: 下流の代替開始点の有無を確認（PVS1 の強度は低くなりうる）')
  if (has(tc, ['splice_donor_variant', 'splice_acceptor_variant'])) notes.push('スプライス部位: エクソンスキップ/フレーム維持かを確認')
  return { ...e, state: 'candidate', reason: `LoF 候補 – 要確認（${terms.join(', ')}）`, notes, sources: ['Ensembl VEP', 'ClinGen Dosage'] }
}

// ---------- CSpec(VCEP) の上書き ----------

/** 遺伝子に対応する CSpec の特定の code を取り出す。複数 VCEP がある場合は先頭を使う。 */
function specCode(ev: SmallEvidence, id: string): { doc: CSpecDoc; code: CSpecCode } | null {
  for (const doc of ev.cspec) {
    const rs = doc.ruleSets.find((r) => ev.gene && r.genes.includes(ev.gene)) ?? doc.ruleSets[0]
    const code = rs?.codes[id]
    if (code) return { doc, code }
  }
  return null
}

const FREQ_CODES = new Set(['BA1', 'BS1', 'BS2', 'PM2'])

function applySpec(e: CodeEvaluation, ev: SmallEvidence): CodeEvaluation {
  const hit = specCode(ev, e.id)
  if (!hit) return e
  const { doc, code } = hit
  const common = { specId: doc.id, specLabel: `${doc.affiliation} ${doc.label} v${doc.version}` }
  if (code.strengths.length === 0) {
    return {
      ...e, vcepNotApplicable: true,
      override: { ...common, kind: 'not_applicable', message: `${common.specLabel} では ${e.id} は適用不可` },
    }
  }
  const allowed = code.strengths.map((s) => CSPEC_STRENGTH[s.label.toLowerCase()]).filter((s): s is Strength => !!s)
  let out = e
  if (allowed.length && !allowed.includes(e.strength)) {
    // 許容強度のうち元の強度に最も近いもの（同距離なら弱い側）へ寄せる
    const dist = (s: Strength) => Math.abs(STRENGTH_POINTS[s] - STRENGTH_POINTS[e.strength])
    const to = allowed.reduce((a, b) => (dist(b) < dist(a) || (dist(b) === dist(a) && STRENGTH_POINTS[b] < STRENGTH_POINTS[a]) ? b : a))
    out = {
      ...out, strength: to,
      override: {
        ...common, kind: allowed.length === 1 ? 'strength' : 'ambiguous', from: e.strength, to,
        message: `${common.specLabel}: ${e.id} は ${allowed.map((s) => STRENGTH_LABEL[s]).join('/')} のみ → ${STRENGTH_LABEL[to]} を使用${allowed.length > 1 ? '（複数候補のため要確認）' : ''}`,
      },
    }
  }
  if (FREQ_CODES.has(e.id) && code.thresholdHints.length) {
    out = {
      ...out,
      notes: [...out.notes, `VCEP 仕様に頻度閾値の記載あり（手掛かり: ${code.thresholdHints.join(', ')}）。自動判定は既定閾値を使用 → ${common.specLabel} を確認`],
      override: out.override ?? { ...common, kind: 'threshold_unverified', message: `${e.id}: VCEP の頻度閾値が既定値と異なる可能性（自動では置換していません）` },
    }
  }
  return out
}

// ---------- 全体 ----------

export function autoEvaluate(ev: SmallEvidence): CodeEvaluation[] {
  const ba1 = evalFreq('BA1', ev, THRESHOLDS.ba1Af)
  const bs1 = evalFreq('BS1', ev, THRESHOLDS.bs1Af)
  if (ba1.state === 'met' && bs1.state === 'met') {
    bs1.state = 'not_applicable'
    bs1.reason += '（BA1 が成立するため重複して計上しない）'
  }
  const ps1 = evalCodon('PS1', ev, false)
  const byId: Record<string, CodeEvaluation> = {
    PVS1: evalPVS1(ev), PS1: ps1, PM5: evalCodon('PM5', ev, ps1.state === 'met'), PM1: evalPM1(ev), PM2: evalPM2(ev), PM4: evalPM4(ev),
    PP3: evalInSilico('PP3', ev), BA1: ba1, BS1: bs1, BS2: evalBS2(ev), BP4: evalInSilico('BP4', ev), BP7: evalBP7(ev),
  }
  return SMALL_CODES.map((def) => {
    const e = byId[def.id] ?? { ...base(def.id), state: 'manual' as const, reason: '人が入力' }
    return applySpec(e, ev)
  })
}

/** 自動判定 + 手動入力 → 点数と分類。手動入力が変わるたびにこれだけを再計算する。 */
export function scoreSmall(evaluations: CodeEvaluation[], manual: ManualMap = {}): SmallResult {
  const scored: ScoredCode[] = evaluations.map((e) => {
    const def = SMALL_CODES.find((c) => c.id === e.id)!
    const m = manual[e.id]
    let counted = false
    let strength = e.strength
    if (!e.vcepNotApplicable) {
      if (e.state === 'met') counted = true
      else if (e.state === 'candidate' || e.state === 'manual') counted = !!m?.met
      if (m?.strength && (e.state === 'candidate' || e.state === 'manual')) strength = m.strength
    }
    const sign = def.direction === 'pathogenic' ? 1 : -1
    return { id: e.id, counted, strength, points: counted ? sign * STRENGTH_POINTS[strength] : 0 }
  })
  const pathogenicPoints = scored.filter((s) => s.points > 0).reduce((a, s) => a + s.points, 0)
  const benignPoints = scored.filter((s) => s.points < 0).reduce((a, s) => a + s.points, 0)
  const total = pathogenicPoints + benignPoints
  const standaloneApplied = scored.some((s) => s.id === STANDALONE_CODE && s.counted)
  const warnings: string[] = []
  if (pathogenicPoints > 0 && benignPoints < 0) warnings.push('病的・良性の両方のエビデンスがあります（矛盾）。点数は合算していますが、専門家の判断が必要です')
  if (standaloneApplied && pathogenicPoints > 0) warnings.push('BA1（Stand-alone）が成立していますが病的エビデンスもあります。頻度データまたは病的コードの適用を再確認してください')
  const notEvaluable = evaluations.filter((e) => e.state === 'not_evaluable' && !e.vcepNotApplicable).map((e) => e.id)
  if (notEvaluable.length) warnings.push(`評価不可のコード（${notEvaluable.join(', ')}）があるため、この分類は暫定です`)
  return {
    evaluations, scored, pathogenicPoints, benignPoints, total,
    classification: standaloneApplied ? 'Benign' : classifyPoints(total),
    standaloneApplied, warnings, notEvaluable,
  }
}

export function evaluateSmall(ev: SmallEvidence, manual: ManualMap = {}): SmallResult {
  return scoreSmall(autoEvaluate(ev), manual)
}
