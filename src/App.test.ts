import { describe, expect, it } from 'vitest'
import { DISCLAIMER, PRIVACY_NOTICE } from './App'

describe('常時表示の注意書き', () => {
  it('免責と個人情報入力禁止の文言を持つ', () => {
    expect(DISCLAIMER).toContain('診断行為には用いず')
    expect(PRIVACY_NOTICE).toContain('患者個人情報は一切入力しない')
  })
})
