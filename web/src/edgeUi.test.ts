import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

describe('edge source qualifications', () => {
  it('keeps the no-login and point-in-time warnings on the rendered edge surface', () => {
    expect(app).toContain('no built-in login or authentication')
    expect(app).toContain('EdgeConnector · ${edgeInfo.state}')
    expect(app).toContain('{info.qualification}')
    expect(app).not.toMatch(/dangerouslySetInnerHTML/)
    // The publication generation is provenance, so it stays on screen wherever the edge panel is.
    expect(app).toContain("<dt>Generation</dt>")
  })

  it('keeps the edge qualification visible at the narrow breakpoint', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 860px)'))
    expect(mobile).toMatch(/\.edge-source-panel p\s*\{[^}]*font-size:\s*\.76rem/)
    expect(mobile).not.toMatch(/\.edge-source-panel[^}]*display:\s*none/)
    expect(mobile).not.toMatch(/\.floating-card[^}]*display:\s*none/)
  })
})

describe('deployment security notice', () => {
  it('draws the notice unless the operator acknowledged it', () => {
    expect(app).toContain('{!noticeAcknowledged && !noticeDismissed && (')
    expect(app).toContain('no built-in login or authentication')
  })

  /**
   * The notice floats over the map now, so it can be dismissed. Dismissal must be an explicit user
   * action that starts false — the notice is never hidden by default, and never hidden by a state
   * the server controls.
   */
  it('starts undismissed, so the notice is visible until the operator closes it', () => {
    expect(app).toMatch(/const \[noticeDismissed, setNoticeDismissed\] = useState\(false\)/)
    expect(app).toContain('onDismiss={() => setNoticeDismissed(true)}')
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
