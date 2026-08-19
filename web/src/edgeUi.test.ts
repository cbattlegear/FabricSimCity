import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

describe('edge source qualifications', () => {
  it('keeps the no-login and point-in-time warnings on the rendered edge surface', () => {
    expect(app).toContain('no built-in login or authentication')
    expect(app).toContain('EdgeConnector · {info.state}')
    expect(app).toContain('{info.qualification}')
    expect(app).not.toMatch(/dangerouslySetInnerHTML/)
    expect(app).toContain('edgeGeneration={edgeInfo?.publicationGeneration ?? null}')
  })

  it('keeps the edge qualification visible at the mobile breakpoint', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 620px)'))
    expect(mobile).toMatch(/\.edge-source-panel p\s*\{[^}]*font-size:\s*\.76rem/)
    expect(mobile).not.toMatch(/\.edge-source-panel[^}]*display:\s*none/)
    expect(mobile).not.toMatch(/\.deploy-warning[^}]*display:\s*none/)
  })
})

describe('deployment security notice', () => {
  it('draws the notice unless the operator acknowledged it', () => {
    expect(app).toContain('{!noticeAcknowledged && (')
    expect(app).toContain('no built-in login or authentication')
  })

  it('starts unacknowledged, so a slow or failed read shows the notice', () => {
    expect(app).toMatch(/useState\(false\)[\s\S]{0,200}fetchDeploymentNotice/)
  })

  it('reports "not acknowledged" for any unreadable response, and never throws', () => {
    expect(api).toMatch(/if \(!response\.ok\) return false/)
    expect(api).toMatch(/catch \{\s*return false\s*\}/)
    expect(api).toContain('body.securityNoticeAcknowledged === true')
  })
})
