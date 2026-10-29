// バリアント入力欄（1 つ）の書式自動判別。ネットワークは使わない純粋関数。

export type Genome = 'GRCh38' | 'GRCh37'
export type VariantType = 'snv' | 'del' | 'dup' | 'ins' | 'delins' | 'inv' | 'other'

export type ParsedInput =
  | {
      kind: 'hgvs_c'
      raw: string
      transcript?: string
      gene?: string
      description: string
      variantType: VariantType
      /** c. 座標から求めた長さ。イントロン側オフセット等で確定できなければ null。 */
      lengthBp: number | null
      inFrameTandemDupCandidate: boolean
    }
  | {
      kind: 'hgvs_g'
      raw: string
      accession: string
      chrom: string
      /** accession のバージョンから推定したアセンブリ。不明なら undefined。 */
      genome?: Genome
      description: string
      variantType: VariantType
      lengthBp: number | null
      inFrameTandemDupCandidate: boolean
    }
  | { kind: 'rsid'; raw: string; rsId: string }
  | { kind: 'caid'; raw: string; caid: string }
  | {
      kind: 'cnv'
      raw: string
      chrom: string
      start: number
      end: number
      cnvType: 'DEL' | 'DUP'
      lengthBp: number
    }
  | {
      kind: 'iscn'
      raw: string
      genome: Genome
      chrom: string
      band?: string
      start: number
      end: number
      copyNumber: number
      cnvType: 'DEL' | 'DUP'
      lengthBp: number
    }
  | { kind: 'unknown'; raw: string; reason: string }

// NC_0000NN.V の染色体・アセンブリ対応（GRCh38 / GRCh37）
const CHROMS = [...Array.from({ length: 22 }, (_, i) => String(i + 1)), 'X', 'Y']
const V38 = [11, 12, 12, 12, 10, 12, 14, 11, 12, 11, 10, 12, 11, 9, 10, 10, 11, 10, 10, 11, 9, 11, 11, 10]
const V37 = [10, 11, 11, 11, 9, 11, 13, 10, 11, 10, 9, 11, 10, 8, 9, 9, 10, 9, 9, 10, 8, 10, 10, 9]

export function genomeFromAccession(accession: string): { chrom: string; genome?: Genome } | null {
  const m = /^NC_0000(\d{2})\.(\d+)$/.exec(accession)
  if (!m) return null
  const idx = Number(m[1]) - 1
  const chrom = CHROMS[idx]
  if (!chrom) return null
  const ver = Number(m[2])
  const genome: Genome | undefined = ver === V38[idx] ? 'GRCh38' : ver === V37[idx] ? 'GRCh37' : undefined
  return { chrom, genome }
}

export function normalizeChrom(c: string): string | null {
  const s = c.replace(/^chr/i, '').toUpperCase()
  if (s === 'M' || s === 'MT') return 'MT'
  return CHROMS.includes(s) ? s : null
}

interface Pos {
  region: '5' | 'cds' | '3'
  n: number
  offset: boolean
}

function parsePos(p: string): Pos | null {
  const m = /^(-|\*)?(\d+)([+-]\d+)?$/.exec(p)
  if (!m) return null
  return {
    region: m[1] === '-' ? '5' : m[1] === '*' ? '3' : 'cds',
    n: Number(m[2]),
    offset: m[3] !== undefined,
  }
}

function spanLength(a: string, b: string | undefined): number | null {
  const s = parsePos(a)
  if (!s) return null
  if (b === undefined) return 1
  const e = parsePos(b)
  if (!e || s.offset || e.offset || s.region !== e.region) return null
  // 5'UTR は -n 表記のため大小が逆転する
  const len = s.region === '5' ? s.n - e.n + 1 : e.n - s.n + 1
  return len > 0 ? len : null
}

const POS = String.raw`(?:-|\*)?\d+(?:[+-]\d+)?`

/** c. / g. の「:c.」以降の記述を解析する。 */
export function parseDescription(desc: string): { variantType: VariantType; lengthBp: number | null } {
  if (new RegExp(String.raw`^${POS}(?:[+-]\d+)?[ACGT]>[ACGT]$`, 'i').test(desc)) return { variantType: 'snv', lengthBp: 1 }
  const m = new RegExp(String.raw`^(${POS})(?:_(${POS}))?(delins|del|dup|ins|inv)([ACGTN]*|\d*)$`, 'i').exec(desc)
  if (!m) return { variantType: 'other', lengthBp: null }
  const [, a, b, op, tail] = m
  const type = op.toLowerCase() as VariantType
  const span = spanLength(a, b)
  if (type === 'ins') return { variantType: 'ins', lengthBp: /^[ACGTN]+$/i.test(tail) ? tail.length : null }
  if (type === 'delins') {
    const ins = /^[ACGTN]+$/i.test(tail) ? tail.length : null
    return { variantType: 'delins', lengthBp: span !== null && ins !== null ? Math.max(span, ins) : (span ?? ins) }
  }
  return { variantType: type, lengthBp: span }
}

const isInFrameTandemDup = (t: VariantType, len: number | null) => t === 'dup' && len !== null && len % 3 === 0

const GENOME_ALIASES: Record<string, Genome> = { grch38: 'GRCh38', hg38: 'GRCh38', grch37: 'GRCh37', hg19: 'GRCh37' }

export function parseVariantInput(input: string): ParsedInput {
  const raw = input.trim().replace(/\s+/g, ' ')
  if (!raw) return { kind: 'unknown', raw, reason: '入力が空です' }

  let m = /^rs(\d+)$/i.exec(raw)
  if (m) return { kind: 'rsid', raw, rsId: `rs${m[1]}` }

  m = /^CA(\d+)$/i.exec(raw)
  if (m) return { kind: 'caid', raw, caid: `CA${m[1]}` }

  // ISCN: arr[GRCh38] 7q11.23(72663000_74133000)x1
  m = /^arr\s*\[\s*(GRCh38|GRCh37|hg38|hg19)\s*\]\s*(?:chr)?(\d{1,2}|X|Y)([pq][\d.]*(?:[pq][\d.]*)?)?\s*\(\s*([\d,]+)\s*_\s*([\d,]+)\s*\)\s*x(\d+)$/i.exec(raw)
  if (m) {
    const start = Number(m[4].replace(/,/g, ''))
    const end = Number(m[5].replace(/,/g, ''))
    const cn = Number(m[6])
    if (cn === 2) return { kind: 'unknown', raw, reason: 'コピー数 x2 は正常（変異なし）です' }
    if (end < start) return { kind: 'unknown', raw, reason: '終了座標が開始座標より小さい' }
    return {
      kind: 'iscn',
      raw,
      genome: GENOME_ALIASES[m[1].toLowerCase()],
      chrom: m[2].toUpperCase(),
      band: m[3] || undefined,
      start,
      end,
      copyNumber: cn,
      cnvType: cn < 2 ? 'DEL' : 'DUP',
      lengthBp: end - start + 1,
    }
  }

  // CNV 座標: chr7:72663000-74133000 DEL
  m = /^(chr)?(\d{1,2}|X|Y)\s*:\s*([\d,]+)\s*-\s*([\d,]+)\s+(DEL|DUP|DELETION|DUPLICATION|LOSS|GAIN)$/i.exec(raw)
  if (m) {
    const start = Number(m[3].replace(/,/g, ''))
    const end = Number(m[4].replace(/,/g, ''))
    if (end < start) return { kind: 'unknown', raw, reason: '終了座標が開始座標より小さい' }
    const t = m[5].toUpperCase()
    return {
      kind: 'cnv',
      raw,
      chrom: m[2].toUpperCase(),
      start,
      end,
      cnvType: t === 'DEL' || t === 'DELETION' || t === 'LOSS' ? 'DEL' : 'DUP',
      lengthBp: end - start + 1,
    }
  }

  // HGVS.g: NC_000017.11:g.7674220C>T
  m = /^(NC_\d+\.\d+):g\.(.+)$/.exec(raw)
  if (m) {
    const info = genomeFromAccession(m[1])
    if (!info) return { kind: 'unknown', raw, reason: `対応外の染色体アクセッション: ${m[1]}` }
    const d = parseDescription(m[2])
    return {
      kind: 'hgvs_g',
      raw,
      accession: m[1],
      chrom: info.chrom,
      genome: info.genome,
      description: m[2],
      ...d,
      inFrameTandemDupCandidate: false, // ゲノム座標では読み枠を判定できない
    }
  }

  // HGVS.c: NM_000546.6:c.743G>A / NM_000546.6(TP53):c.743G>A / c.743G>A
  m = /^(?:((?:NM|NR|XM|XR)_\d+(?:\.\d+)?|ENST\d+(?:\.\d+)?)(?:\(([A-Za-z0-9_-]+)\))?)?:?c\.(.+)$/.exec(raw)
  if (m) {
    const d = parseDescription(m[3])
    return {
      kind: 'hgvs_c',
      raw,
      transcript: m[1],
      gene: m[2],
      description: m[3],
      ...d,
      inFrameTandemDupCandidate: isInFrameTandemDup(d.variantType, d.lengthBp),
    }
  }

  return { kind: 'unknown', raw, reason: '対応する書式を判別できません（HGVS.c / HGVS.g / rsID / CAid / CNV 座標 / ISCN）' }
}
