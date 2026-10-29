import { describe, expect, it } from 'vitest'
import { genomeFromAccession, parseDescription, parseVariantInput } from './parseInput.ts'
import { routeInput } from './route.ts'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../settings.ts'

const route = (s: string, thr = 50, g: 'GRCh38' | 'GRCh37' = 'GRCh38') =>
  routeInput(parseVariantInput(s), g, { ...DEFAULT_SETTINGS, cnvThresholdBp: thr })

describe('parseVariantInput: 書式判別（仕様書の例）', () => {
  it('HGVS.c', () => {
    expect(parseVariantInput('NM_000546.6:c.743G>A')).toMatchObject({ kind: 'hgvs_c', transcript: 'NM_000546.6', variantType: 'snv', lengthBp: 1 })
    expect(parseVariantInput('c.1234_1290dup')).toMatchObject({ kind: 'hgvs_c', variantType: 'dup', lengthBp: 57 })
    expect(parseVariantInput('NM_000546.6(TP53):c.743G>A')).toMatchObject({ transcript: 'NM_000546.6', gene: 'TP53' })
  })
  it('HGVS.g とアセンブリ推定', () => {
    expect(parseVariantInput('NC_000017.11:g.7674220C>T')).toMatchObject({ kind: 'hgvs_g', chrom: '17', genome: 'GRCh38' })
    expect(parseVariantInput('NC_000017.10:g.7577538C>T')).toMatchObject({ genome: 'GRCh37' })
    expect(genomeFromAccession('NC_000023.11')).toEqual({ chrom: 'X', genome: 'GRCh38' })
    expect(genomeFromAccession('NC_000017.99')).toEqual({ chrom: '17', genome: undefined })
  })
  it('rsID / CAid', () => {
    expect(parseVariantInput('rs11540652')).toMatchObject({ kind: 'rsid', rsId: 'rs11540652' })
    expect(parseVariantInput('CA123456')).toMatchObject({ kind: 'caid', caid: 'CA123456' })
  })
  it('CNV 座標', () => {
    expect(parseVariantInput('chr7:72663000-74133000 DEL')).toMatchObject({ kind: 'cnv', chrom: '7', cnvType: 'DEL', lengthBp: 1470001 })
    expect(parseVariantInput('chr15:22,800,000-28,400,000 DUP')).toMatchObject({ kind: 'cnv', cnvType: 'DUP', start: 22800000 })
  })
  it('ISCN', () => {
    expect(parseVariantInput('arr[GRCh38] 7q11.23(72663000_74133000)x1')).toMatchObject({
      kind: 'iscn', genome: 'GRCh38', chrom: '7', band: 'q11.23', cnvType: 'DEL', copyNumber: 1, lengthBp: 1470001,
    })
    expect(parseVariantInput('arr[hg19] 15q11.2q13.1(22800000_28400000)x3')).toMatchObject({ kind: 'iscn', genome: 'GRCh37', cnvType: 'DUP' })
    expect(parseVariantInput('arr[GRCh38] 7q11.23(1_100)x2').kind).toBe('unknown')
  })
  it('判別不能・空', () => {
    expect(parseVariantInput('').kind).toBe('unknown')
    expect(parseVariantInput('hello').kind).toBe('unknown')
    expect(parseVariantInput('NC_000099.1:g.1A>T').kind).toBe('unknown')
  })
})

describe('parseDescription', () => {
  it('種別と長さ', () => {
    expect(parseDescription('100del')).toEqual({ variantType: 'del', lengthBp: 1 })
    expect(parseDescription('100_149del')).toEqual({ variantType: 'del', lengthBp: 50 })
    expect(parseDescription('100_101insACG')).toEqual({ variantType: 'ins', lengthBp: 3 })
    expect(parseDescription('100_103delinsAT')).toEqual({ variantType: 'delins', lengthBp: 4 })
    expect(parseDescription('100_200inv')).toEqual({ variantType: 'inv', lengthBp: 101 })
  })
  it('イントロン側オフセット・領域跨ぎは長さ不明', () => {
    expect(parseDescription('100+1_100+60del').lengthBp).toBeNull()
    expect(parseDescription('-5_10del').lengthBp).toBeNull()
  })
  it('5\'UTR・3\'UTR の長さ', () => {
    expect(parseDescription('-10_-1dup').lengthBp).toBe(10)
    expect(parseDescription('*1_*5del').lengthBp).toBe(5)
  })
})

describe('routeInput: 振り分けと閾値', () => {
  it('SNV・indel は小変異', () => {
    expect(route('NM_000546.6:c.743G>A').engine).toBe('small')
    expect(route('NC_000017.11:g.100_101insACG').engine).toBe('small')
  })
  it('50bp の境界: 49 は小変異、50 は CNV', () => {
    expect(route('NC_000017.11:g.100_148dup').engine).toBe('small')
    expect(route('NC_000017.11:g.100_149dup').engine).toBe('cnv')
    expect(route('NC_000017.11:g.100_149del').engine).toBe('cnv')
  })
  it('閾値を変更すると振り分けが変わる', () => {
    expect(route('NC_000017.11:g.100_149del', 100).engine).toBe('small')
    expect(route('NC_000017.11:g.100_149del', 30).engine).toBe('cnv')
  })
  it('CNV 座標・ISCN は CNV エンジン', () => {
    expect(route('chr7:72663000-74133000 DEL').engine).toBe('cnv')
    expect(route('arr[GRCh38] 7q11.23(72663000_74133000)x1').engine).toBe('cnv')
  })
  it('rsID / CAid は解決後に判定', () => {
    expect(route('rs11540652').engine).toBe('deferred')
    expect(route('CA123456').engine).toBe('deferred')
  })
  it('in-frame tandem dup 候補（<50bp, 3 の倍数）は警告', () => {
    const r = route('NM_000546.6:c.100_108dup')
    expect(r.engine).toBe('small')
    expect(r.warnings.join()).toContain('tandem dup')
    expect(route('NM_000546.6:c.100_107dup').warnings.join()).not.toContain('tandem dup')
  })
  it('c. の長さ不明な del は警告つきで小変異', () => {
    const r = route('NM_000546.6:c.100+1_100+60del')
    expect(r.engine).toBe('small')
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('アセンブリ不一致は警告し入力側を優先', () => {
    const r = route('NC_000017.10:g.7577538C>T', 50, 'GRCh38')
    expect(r.genome).toBe('GRCh37')
    expect(r.warnings.join()).toContain('GRCh37')
  })
  it('参照配列も遺伝子も無い c. は警告', () => {
    expect(route('c.743G>A').warnings.join()).toContain('遺伝子欄')
  })
  it('判別不能は invalid', () => {
    expect(route('xyz').engine).toBe('invalid')
  })
})

describe('sanitizeSettings', () => {
  it('不正値は既定へ戻す', () => {
    expect(sanitizeSettings({ cnvThresholdBp: -3, defaultGenome: 'x' })).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ cnvThresholdBp: 80, defaultGenome: 'GRCh37' })).toEqual({ cnvThresholdBp: 80, defaultGenome: 'GRCh37' })
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
})
