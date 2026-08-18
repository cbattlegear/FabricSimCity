import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
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
