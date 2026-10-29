// CNV 判定ルール（ACMG/ClinGen 2019 技術標準, Riggs et al. 2020 Genet Med）。
// 点数・範囲・閾値・遺伝子数区分はすべてここに宣言し、評価関数には直書きしない。
// 点数は誤差を避けるため 1/100 点単位の整数で保持する（0.45 → 45）。

export type CnvType = 'LOSS' | 'GAIN'
export type Section = 1 | 2 | 3 | 4 | 5

export interface CnvClassTier {
  label: 'Pathogenic' | 'Likely Pathogenic' | 'VUS' | 'Likely Benign' | 'Benign'
  min: number
  max: number
}

/** 合計点(1/100 点) → 分類。P ≥0.99, LP 0.90–0.98, VUS −0.89–0.89, LB −0.90…−0.98, B ≤−0.99 */
export const CNV_CLASSES: readonly CnvClassTier[] = [
  { label: 'Pathogenic', min: 99, max: Infinity },
  { label: 'Likely Pathogenic', min: 90, max: 98 },
  { label: 'VUS', min: -89, max: 89 },
  { label: 'Likely Benign', min: -98, max: -90 },
  { label: 'Benign', min: -Infinity, max: -99 },
]

export function classifyCnv(points: number): CnvClassTier['label'] {
  return CNV_CLASSES.find((c) => points >= c.min && points <= c.max)?.label ?? 'VUS'
}

/** Section 3 の遺伝子数区分（タンパク質コード遺伝子）。上から順に当てはめる。 */
export const GENE_COUNT_TIERS: Record<CnvType, ReadonlyArray<{ id: string; min: number; points: number }>> = {
  LOSS: [{ id: '3C', min: 35, points: 90 }, { id: '3B', min: 25, points: 45 }, { id: '3A', min: 0, points: 0 }],
  GAIN: [{ id: '3C', min: 50, points: 90 }, { id: '3B', min: 35, points: 45 }, { id: '3A', min: 0, points: 0 }],
}

/** Section 1 */
export const SECTION1 = { has: { id: '1A', points: 0 }, none: { id: '1B', points: -60 } } as const

export interface CnvItem {
  id: string
  section: Section
  types: readonly CnvType[]
  title: string
  /** 既定点（1/100 点）。per は「1 件あたり」を意味し、件数を掛ける */
  points: number
  min: number
  max: number
  /** 件数入力を伴う項目（例: 症例数・家系数）。合計は max で頭打ち */
  perUnit?: string
  /** 入力方法: auto=自動 / suggest=自動で候補提示 / manual=人が入力 */
  mode: 'auto' | 'suggest' | 'manual'
}

const B = ['LOSS', 'GAIN'] as const
const L = ['LOSS'] as const
const G = ['GAIN'] as const

export const CNV_ITEMS: readonly CnvItem[] = [
  // ---- Section 2 (LOSS) ----
  { id: '2A', section: 2, types: L, title: '確立したハプロ不全(HI)遺伝子/領域を完全に含む', points: 100, min: 100, max: 100, mode: 'auto' },
  { id: '2B', section: 2, types: L, title: '確立した HI 領域に部分的に重なる（原因遺伝子は含まない/不明）', points: 0, min: 0, max: 0, mode: 'auto' },
  { id: '2C-1', section: 2, types: L, title: 'HI 遺伝子の 5′ 端に部分重複（コード配列を含む）', points: 90, min: 45, max: 100, mode: 'suggest' },
  { id: '2C-2', section: 2, types: L, title: 'HI 遺伝子の 5′ 端に部分重複（5′UTR のみ）', points: 0, min: 0, max: 45, mode: 'suggest' },
  { id: '2D-1', section: 2, types: L, title: 'HI 遺伝子の 3′ 端に部分重複（3′UTR のみ）', points: 0, min: 0, max: 0, mode: 'suggest' },
  { id: '2D-2', section: 2, types: L, title: '最終エクソンのみ。同エクソンに既知の病的変異あり', points: 90, min: 45, max: 90, mode: 'suggest' },
  { id: '2D-3', section: 2, types: L, title: '最終エクソンのみ。同エクソンに既知の病的変異なし', points: 30, min: 0, max: 45, mode: 'suggest' },
  { id: '2D-4', section: 2, types: L, title: '最終エクソン以外も含む（NMD が予想される）', points: 90, min: 45, max: 100, mode: 'suggest' },
  { id: '2E', section: 2, types: L, title: '遺伝子内（両切断点が同一遺伝子）。PVS1 仕様で採点', points: 0, min: 0, max: 90, mode: 'manual' },
  { id: '2F', section: 2, types: L, title: '確立した良性 CNV に完全に含まれる', points: -100, min: -100, max: -100, mode: 'manual' },
  { id: '2G', section: 2, types: L, title: '確立した良性 CNV と重なるが追加領域を含む', points: 0, min: 0, max: 0, mode: 'manual' },
  { id: '2H', section: 2, types: L, title: '2 つ以上の HI 予測により少なくとも 1 遺伝子が HI と示唆', points: 15, min: 15, max: 15, mode: 'manual' },
  // ---- Section 2 (GAIN) ----
  { id: '2A', section: 2, types: G, title: '確立したトリプロ感受性(TS)遺伝子/領域を完全に含む', points: 100, min: 100, max: 100, mode: 'auto' },
  { id: '2B', section: 2, types: G, title: '確立した TS 領域に部分的に重なる（原因遺伝子は含まない/不明）', points: 0, min: 0, max: 0, mode: 'auto' },
  { id: '2C', section: 2, types: G, title: '確立した良性増幅と遺伝子内容が同一', points: -100, min: -100, max: -100, mode: 'manual' },
  { id: '2D', section: 2, types: G, title: '確立した良性増幅より小さく、切断点がコード遺伝子を壊さない', points: -100, min: -100, max: -100, mode: 'manual' },
  { id: '2E', section: 2, types: G, title: '確立した良性増幅より小さく、切断点がコード遺伝子を壊しうる', points: 0, min: 0, max: 0, mode: 'manual' },
  { id: '2F', section: 2, types: G, title: '既知の良性増幅より大きいが追加のコード遺伝子なし', points: -100, min: -100, max: 0, mode: 'manual' },
  { id: '2G', section: 2, types: G, title: '良性増幅と重なるが追加領域を含む', points: 0, min: 0, max: 0, mode: 'manual' },
  { id: '2H', section: 2, types: G, title: 'HI 遺伝子を完全に含む', points: 0, min: 0, max: 0, mode: 'auto' },
  { id: '2I', section: 2, types: G, title: '遺伝子内（両切断点が同一遺伝子）。PVS1 仕様で採点', points: 0, min: 0, max: 90, mode: 'manual' },
  { id: '2J', section: 2, types: G, title: '切断点の 1 つが HI 遺伝子内。表現型が LoF と不整合/不明', points: 0, min: 0, max: 0, mode: 'suggest' },
  { id: '2K', section: 2, types: G, title: '切断点の 1 つが HI 遺伝子内。表現型が高度に特異的で LoF と整合', points: 45, min: 45, max: 45, mode: 'manual' },
  { id: '2L', section: 2, types: G, title: '切断点が臨床的意義の確立していない遺伝子内', points: 0, min: 0, max: 0, mode: 'suggest' },
  // ---- Section 4 (LOSS/GAIN 共通) ----
  { id: '4A', section: 4, types: B, title: 'de novo・表現型が高度に特異的かつ唯一（確認済 0.45 / 想定 0.30 / 例）', points: 45, min: 15, max: 45, perUnit: '例', mode: 'manual' },
  { id: '4B', section: 4, types: B, title: 'de novo・表現型が整合し高度に特異的だが唯一ではない（確認済 0.30 / 想定 0.15 / 例）', points: 30, min: 0, max: 45, perUnit: '例', mode: 'manual' },
  { id: '4C', section: 4, types: B, title: 'de novo・表現型が整合するが特異性が低い/異質性が高い（確認済 0.15 / 想定 0.10 / 例）', points: 15, min: 0, max: 30, perUnit: '例', mode: 'manual' },
  { id: '4D', section: 4, types: B, title: '報告された表現型が当該遺伝子/領域と不整合', points: 0, min: -30, max: 0, mode: 'manual' },
  { id: '4E', section: 4, types: B, title: '遺伝形式不明・表現型が高度に特異的で整合（例）', points: 10, min: 0, max: 15, perUnit: '例', mode: 'manual' },
  { id: '4F', section: 4, types: B, title: '3〜4 件の共分離観察', points: 15, min: 15, max: 45, mode: 'manual' },
  { id: '4G', section: 4, types: B, title: '5〜6 件の共分離観察', points: 30, min: 30, max: 30, mode: 'manual' },
  { id: '4H', section: 4, types: B, title: '7 件以上の共分離観察', points: 45, min: 45, max: 45, mode: 'manual' },
  { id: '4I', section: 4, types: B, title: '特異的表現型の罹患家族に変異なし（家系）', points: -45, min: -45, max: 0, perUnit: '家系', mode: 'manual' },
  { id: '4J', section: 4, types: B, title: '特異的表現型だが非罹患の家族に変異あり（家系）', points: -30, min: -30, max: 0, perUnit: '家系', mode: 'manual' },
  { id: '4K', section: 4, types: B, title: '非特異的表現型で非罹患の家族に変異あり（家系）', points: -15, min: -15, max: 0, perUnit: '家系', mode: 'manual' },
  { id: '4L', section: 4, types: B, title: '症例対照で有意に増加（特異的表現型）', points: 45, min: 0, max: 45, perUnit: '研究', mode: 'manual' },
  { id: '4M', section: 4, types: B, title: '症例対照で有意に増加（非特異的/不明の表現型）', points: 30, min: 0, max: 30, perUnit: '研究', mode: 'manual' },
  { id: '4N', section: 4, types: B, title: '症例対照で有意差なし', points: -90, min: -90, max: 0, perUnit: '研究', mode: 'manual' },
  { id: '4O', section: 4, types: B, title: '一般集団の多型と重なる', points: -100, min: -100, max: 0, mode: 'manual' },
  // ---- Section 5 ----
  { id: '5B', section: 5, types: B, title: '表現型が特異的、家族歴なし、表現型が正常な親から遺伝', points: -30, min: -45, max: 0, mode: 'manual' },
  { id: '5C', section: 5, types: B, title: '非特異的表現型、家族歴なし、表現型が正常な親から遺伝', points: -15, min: -30, max: 0, mode: 'manual' },
  { id: '5G', section: 5, types: B, title: '遺伝形式不明/非情報的・非特異的表現型が類似症例と整合', points: 10, min: 0, max: 15, mode: 'manual' },
  { id: '5H', section: 5, types: L, title: '遺伝形式不明/非情報的・高度に特異的な表現型が類似症例と整合', points: 30, min: 0, max: 30, mode: 'manual' },
  { id: '5H', section: 5, types: G, title: '遺伝形式不明/非情報的・高度に特異的な表現型が類似症例と整合', points: 15, min: 0, max: 30, mode: 'manual' },
]

/** 件数入力項目の合計上限（1/100 点）。ID に対して指定がなければ項目の max。 */
export const CNV_TOTAL_CAP: Record<string, number> = { '4A': 90, '4B': 90, '4C': 90, '4D': 30, '4E': 30, '4I': 90, '4J': 90, '4K': 30, '4L': 45, '4M': 45, '4N': 90 }

export const cnvItemsFor = (type: CnvType, section?: Section) =>
  CNV_ITEMS.filter((i) => i.types.includes(type) && (section === undefined || i.section === section))

/** PVS1 仕様による遺伝子内 CNV（2E/2I）の選択肢。 */
export const INTRAGENIC_OPTIONS: Record<CnvType, ReadonlyArray<{ label: string; points: number }>> = {
  LOSS: [
    { label: 'N/A', points: 0 },
    { label: 'PVS1_Supporting', points: 15 },
    { label: 'PVS1_Moderate / PM4（インフレーム）', points: 30 },
    { label: 'PVS1_Strong', points: 45 },
    { label: 'PVS1', points: 90 },
  ],
  GAIN: [
    { label: 'N/A', points: 0 },
    { label: 'PVS1_Strong', points: 45 },
    { label: 'PVS1', points: 90 },
  ],
}

/** HI / TS スコアで「確立」とみなす値。 */
export const ESTABLISHED_SCORE = 3
