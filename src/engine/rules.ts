// 小変異（ACMG/AMP + ClinGen SVI ポイント方式）の判定ルール定義。
// 閾値・点数・分類境界・コード定義はすべてこのファイルに集約する（評価関数に直書きしない）。

export type Strength = 'standalone' | 'very_strong' | 'strong' | 'moderate' | 'supporting'
export type Direction = 'pathogenic' | 'benign'
/** auto: 自動判定 / semi: 候補提示（人が確認して採用）/ manual: 人が入力 */
export type Mode = 'auto' | 'semi' | 'manual'

/** 強度ごとの点数（絶対値）。ClinGen SVI: Supporting=1, Moderate=2, Strong=4, Very Strong=8。Stand-alone は Very Strong 相当の 8 点。 */
export const STRENGTH_POINTS: Record<Strength, number> = {
  standalone: 8,
  very_strong: 8,
  strong: 4,
  moderate: 2,
  supporting: 1,
}

export const STRENGTH_LABEL: Record<Strength, string> = {
  standalone: 'Stand-alone',
  very_strong: 'Very Strong',
  strong: 'Strong',
  moderate: 'Moderate',
  supporting: 'Supporting',
}

/** CSpec の強度ラベル → 内部表現 */
export const CSPEC_STRENGTH: Record<string, Strength> = {
  'stand alone': 'standalone',
  'stand-alone': 'standalone',
  'very strong': 'very_strong',
  strong: 'strong',
  moderate: 'moderate',
  supporting: 'supporting',
}

export interface ClassTier {
  label: 'Pathogenic' | 'Likely Pathogenic' | 'VUS' | 'Likely Benign' | 'Benign'
  min: number
  max: number
}

/** 合計点 → 分類（ClinGen SVI ポイント方式）。 */
export const SMALL_CLASSES: readonly ClassTier[] = [
  { label: 'Pathogenic', min: 10, max: Infinity },
  { label: 'Likely Pathogenic', min: 6, max: 9 },
  { label: 'VUS', min: 0, max: 5 },
  { label: 'Likely Benign', min: -6, max: -1 },
  { label: 'Benign', min: -Infinity, max: -7 },
]

export interface CodeDef {
  id: string
  direction: Direction
  defaultStrength: Strength
  mode: Mode
  title: string
  /** 画面に出す判定基準の説明 */
  criterion: string
}

export const SMALL_CODES: readonly CodeDef[] = [
  { id: 'PVS1', direction: 'pathogenic', defaultStrength: 'very_strong', mode: 'semi', title: '機能喪失型バリアント', criterion: 'LoF（ナンセンス/フレームシフト/スプライス部位/開始コドン消失）。LoF が疾患機序の遺伝子で、NMD・最終エクソン等を確認して採用' },
  { id: 'PS1', direction: 'pathogenic', defaultStrength: 'strong', mode: 'auto', title: '同一アミノ酸変化が既知の病的変異', criterion: 'ClinVar で同じアミノ酸置換を生じる別の塩基変化が P/LP（審査基準あり）' },
  { id: 'PM5', direction: 'pathogenic', defaultStrength: 'moderate', mode: 'auto', title: '同一残基の別置換が既知の病的変異', criterion: 'ClinVar で同じ残基の別のミスセンスが P/LP（審査基準あり）。PS1 が成立する場合は適用しない' },
  { id: 'PM1', direction: 'pathogenic', defaultStrength: 'supporting', mode: 'auto', title: '機能ドメイン内のミスセンス', criterion: 'VEP が注釈する機能ドメイン内のミスセンス。ホットスポット/VCEP 仕様は未検証のため Supporting' },
  { id: 'PM2', direction: 'pathogenic', defaultStrength: 'supporting', mode: 'auto', title: '集団頻度が極めて低い/不在', criterion: 'gnomAD で不在、または頻度が閾値以下（SVI 推奨に従い Supporting）' },
  { id: 'PM4', direction: 'pathogenic', defaultStrength: 'moderate', mode: 'auto', title: '非反復領域のインフレーム長変化 / 終止コドン消失', criterion: 'in-frame insertion/deletion または stop_lost（反復領域の判定は未実施のため要確認）' },
  { id: 'PP3', direction: 'pathogenic', defaultStrength: 'supporting', mode: 'auto', title: 'in silico 予測が有害', criterion: 'REVEL（Pejaver 2022 較正）。ミスセンスのみ' },
  { id: 'BA1', direction: 'benign', defaultStrength: 'standalone', mode: 'auto', title: '集団頻度が高い（Stand-alone）', criterion: 'gnomAD 全体の頻度が閾値以上' },
  { id: 'BS1', direction: 'benign', defaultStrength: 'strong', mode: 'auto', title: '疾患から予想より集団頻度が高い', criterion: 'gnomAD 全体の頻度が閾値以上（疾患・遺伝子別の閾値は VCEP 仕様を確認）' },
  { id: 'BS2', direction: 'benign', defaultStrength: 'strong', mode: 'auto', title: '健常成人でのホモ接合観察', criterion: 'gnomAD でのホモ接合数が閾値以上' },
  { id: 'BP4', direction: 'benign', defaultStrength: 'supporting', mode: 'auto', title: 'in silico 予測が無害', criterion: 'REVEL（Pejaver 2022 較正）。ミスセンスのみ' },
  { id: 'BP7', direction: 'benign', defaultStrength: 'supporting', mode: 'auto', title: '同義置換でスプライス影響なし', criterion: '同義置換（スプライス領域外）かつスプライス予測で影響なし。スプライス予測が無い場合は評価不可' },
  { id: 'PS2', direction: 'pathogenic', defaultStrength: 'strong', mode: 'manual', title: 'de novo（確認済み）', criterion: '親子関係確認済みの de novo。PM6 は未確認の de novo' },
  { id: 'PM6', direction: 'pathogenic', defaultStrength: 'moderate', mode: 'manual', title: 'de novo（未確認）', criterion: '親子関係未確認の de novo' },
  { id: 'PS3', direction: 'pathogenic', defaultStrength: 'strong', mode: 'manual', title: '機能解析で有害', criterion: '十分に確立された機能解析で有害な影響' },
  { id: 'BS3', direction: 'benign', defaultStrength: 'strong', mode: 'manual', title: '機能解析で影響なし', criterion: '十分に確立された機能解析で影響なし' },
  { id: 'PP1', direction: 'pathogenic', defaultStrength: 'supporting', mode: 'manual', title: '家系内で疾患と共分離', criterion: '複数の発端者で共分離（共分離の程度で強度を調整）' },
  { id: 'BS4', direction: 'benign', defaultStrength: 'strong', mode: 'manual', title: '家系内で非共分離', criterion: '罹患者に変異がない/非罹患者にある（浸透率を考慮）' },
  { id: 'PM3', direction: 'pathogenic', defaultStrength: 'moderate', mode: 'manual', title: 'trans に病的変異（劣性）', criterion: '劣性疾患で既知の病的変異と trans（フェーズ確認済み）' },
  { id: 'PP4', direction: 'pathogenic', defaultStrength: 'supporting', mode: 'manual', title: '表現型が遺伝子に高度に特異的', criterion: '患者の表現型・家族歴が当該遺伝子に特異的' },
  { id: 'PS4', direction: 'pathogenic', defaultStrength: 'strong', mode: 'manual', title: '患者群で有意に多い', criterion: '症例対照/複数の無関係な発端者での観察' },
]

export const codeDef = (id: string): CodeDef | undefined => SMALL_CODES.find((c) => c.id === id)

/** 既定の自動判定閾値（VCEP 仕様で数値が確定できない場合の既定値）。 */
export const THRESHOLDS = {
  /** BA1: 全体頻度がこれ以上 */
  ba1Af: 0.05,
  /** BS1: 全体頻度がこれ以上（遺伝子/疾患別の閾値は VCEP 仕様を確認） */
  bs1Af: 0.01,
  /** PM2: 不在、または頻度がこれ以下 */
  pm2Af: 0.0001,
  /** BS2: ホモ接合数がこれ以上 */
  bs2Hom: 2,
} as const

/** REVEL 較正（Pejaver et al. 2022）。強い順に並べ、最初に当てはまった強度を採用する。 */
export const REVEL_CALIBRATION = {
  pathogenic: [
    { min: 0.932, strength: 'strong' },
    { min: 0.773, strength: 'moderate' },
    { min: 0.644, strength: 'supporting' },
  ],
  benign: [
    { max: 0.003, strength: 'very_strong' },
    { max: 0.016, strength: 'strong' },
    { max: 0.183, strength: 'moderate' },
    { max: 0.29, strength: 'supporting' },
  ],
} as const satisfies {
  pathogenic: ReadonlyArray<{ min: number; strength: Strength }>
  benign: ReadonlyArray<{ max: number; strength: Strength }>
}

/** PVS1 の候補になる VEP consequence。 */
export const LOF_CONSEQUENCES: readonly string[] = [
  'stop_gained', 'frameshift_variant', 'splice_donor_variant', 'splice_acceptor_variant', 'start_lost', 'transcript_ablation',
]

/** PM1 で「機能ドメイン」とみなす VEP ドメイン DB（Gene3D/PANTHER 等の広い注釈は除く）。 */
export const PM1_DOMAIN_DBS: readonly string[] = ['Pfam', 'PROSITE_profiles', 'SMART']

/** 単独で良性(Benign)を確定させるコード。 */
export const STANDALONE_CODE = 'BA1'

export const INFRAME_CONSEQUENCES: readonly string[] = ['inframe_insertion', 'inframe_deletion', 'stop_lost']

/** ClinVar の P/LP 判定に使う臨床的意義と、採用しない審査状態。 */
export const CLINVAR_PLP = /^(pathogenic|likely pathogenic|pathogenic\/likely pathogenic)$/i
export const CLINVAR_BLB = /^(benign|likely benign|benign\/likely benign)$/i
export const CLINVAR_NO_CRITERIA = /no assertion|no classification/i

/** 重み付け用に、点数から分類を引く。 */
export function classifyPoints(points: number): ClassTier['label'] {
  const t = SMALL_CLASSES.find((c) => points >= c.min && points <= c.max)
  // 閾値表が連続整数を網羅する前提だが、保険として VUS に倒す
  return t?.label ?? 'VUS'
}
