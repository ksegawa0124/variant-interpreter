import { describe, expect, it } from 'vitest'
import { parseBands, parseFeatures, parseTranscript } from '../api/ensemblViz.ts'
import { layoutExons, linear } from './layout.ts'

const exons = [{ start: 100, end: 199 }, { start: 1000, end: 1099 }, { start: 5000, end: 5199 }]

describe('layoutExons', () => {
  it('＋鎖: 座標昇順に並び、イントロンは固定幅に圧縮される', () => {
    const l = layoutExons(exons, 1, 400, undefined, 10)
    expect(l.boxes.map((b) => b.number)).toEqual([1, 2, 3])
    expect(l.boxes[0].x).toBe(0)
    expect(l.boxes[1].x).toBeCloseTo(l.boxes[0].width + 10)
    const last = l.boxes[2]
    expect(last.x + last.width).toBeCloseTo(400)
    // 200bp は 100bp の 2 倍の幅
    expect(l.boxes[2].width / l.boxes[0].width).toBeCloseTo(2)
  })

  it('－鎖: 転写方向（右端の座標が 1 番目）に並ぶ', () => {
    const l = layoutExons(exons, -1, 400, undefined, 10)
    const byIdx = [...l.boxes].sort((a, b) => a.index - b.index)
    expect(byIdx[2].number).toBe(1)
    expect(byIdx[2].x).toBe(0)
    expect(byIdx[0].number).toBe(3)
  })

  it('バリアントの x: エクソン内は比例、イントロンは隣接エクソン間の中央、範囲外は null', () => {
    const l = layoutExons(exons, 1, 400, undefined, 10)
    const b1 = l.boxes[0]
    expect(l.xOf(100)).toBeCloseTo(b1.x)
    expect(l.xOf(150)).toBeCloseTo(b1.x + b1.width / 2, 0)
    expect(l.exonAt(150)).toBe(0)
    const mid = l.xOf(500)!
    expect(mid).toBeGreaterThan(b1.x + b1.width)
    expect(mid).toBeLessThan(l.boxes[1].x)
    expect(l.exonAt(500)).toBeNull()
    expect(l.xOf(50)).toBeNull()
    expect(l.xOf(9999)).toBeNull()
  })

  it('－鎖でもバリアントは転写方向に沿った位置になる（座標が大きいほど左）', () => {
    const l = layoutExons(exons, -1, 400, undefined, 10)
    expect(l.xOf(5100)!).toBeLessThan(l.xOf(1050)!)
    expect(l.xOf(1050)!).toBeLessThan(l.xOf(150)!)
  })

  it('CDS は翻訳開始・終了とエクソンの交差だけ塗る', () => {
    const l = layoutExons(exons, 1, 400, { start: 150, end: 1049 }, 10)
    expect(l.boxes[0].cds!.width).toBeCloseTo(l.boxes[0].width / 2, 0)
    expect(l.boxes[1].cds!.width).toBeCloseTo(l.boxes[1].width / 2, 0)
    expect(l.boxes[2].cds).toBeUndefined()
  })

  it('極端に短いエクソンにも最小幅がある', () => {
    const l = layoutExons([{ start: 1, end: 2 }, { start: 10, end: 100000 }], 1, 400)
    expect(l.boxes[0].width).toBeGreaterThan(1)
  })
})

describe('Ensembl 応答のパース', () => {
  it('転写産物: エクソンを昇順に並べ、翻訳情報を保持する', () => {
    const t = parseTranscript({ id: 'ENST1', strand: -1, Exon: [{ start: 20, end: 30 }, { start: 1, end: 10 }], Translation: { id: 'ENSP1', start: 5, end: 25, length: 8 } })
    expect(t).toMatchObject({ transcriptId: 'ENST1', strand: -1, cdsStart: 5, cdsEnd: 25, proteinId: 'ENSP1', proteinLength: 8 })
    expect(t.exons.map((e) => e.start)).toEqual([1, 20])
    expect(() => parseTranscript({ id: 'x' })).toThrow()
  })
  it('ドメイン: Pfam/PROSITE/SMART のみ採用', () => {
    const f = parseFeatures([
      { type: 'Pfam', id: 'PF1', description: 'dom', start: 10, end: 20 },
      { type: 'Gene3D', id: 'g', description: '', start: 1, end: 5 },
      { type: 'Prosite_profiles', id: 'PS1', description: '', start: 3, end: 4 },
    ])
    expect(f.map((x) => x.db)).toEqual(['Prosite_profiles', 'Pfam'])
    expect(f[1].name).toBe('dom')
    expect(f[0].name).toBe('PS1')
    expect(() => parseFeatures({})).toThrow()
  })
  it('染色体バンド', () => {
    const c = parseBands({ length: 100, karyotype_band: [{ id: 'q11', start: 50, end: 100, stain: 'gneg' }, { id: 'p11', start: 1, end: 49, stain: 'acen' }] }, '22')
    expect(c.bands.map((b) => b.name)).toEqual(['p11', 'q11'])
    expect(() => parseBands({}, '1')).toThrow()
  })
  it('linear', () => {
    expect(linear(0, 100, 200)(50)).toBe(100)
  })
})
