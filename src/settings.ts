import type { Genome } from './input/parseInput.ts'

export interface Settings {
  /** この長さ（bp）以上の del / dup を CNV エンジンへ振り分ける */
  cnvThresholdBp: number
  defaultGenome: Genome
}

export const DEFAULT_SETTINGS: Settings = { cnvThresholdBp: 50, defaultGenome: 'GRCh38' }

const KEY = 'variant-interpreter:settings'

/** 不正値は既定値へ戻す。 */
export function sanitizeSettings(v: unknown): Settings {
  const o = (v ?? {}) as Partial<Settings>
  const t = Number(o.cnvThresholdBp)
  return {
    cnvThresholdBp: Number.isInteger(t) && t >= 1 && t <= 10_000_000 ? t : DEFAULT_SETTINGS.cnvThresholdBp,
    defaultGenome: o.defaultGenome === 'GRCh37' ? 'GRCh37' : 'GRCh38',
  }
}

export function loadSettings(): Settings {
  try {
    const s = localStorage.getItem(KEY)
    return s ? sanitizeSettings(JSON.parse(s)) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 保存できなくても動作は継続する */
  }
}
