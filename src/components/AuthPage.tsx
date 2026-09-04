import { useState } from 'react'

import { useAuth } from '@/hooks/AuthContext'

/**
 * The sign-in surface for a deployed backend.
 *
 * Fixture mode never reaches this: it reads no tenant, so it needs no identity. This is the door
 * onto a real Fabric tenant, where every user signs in as themselves — the capacity metrics
 * connectors are delegated-auth only, so there is no service principal reading once for everyone
 * and no way to render a capacity the signed-in user cannot already see.
 */
export function AuthPage() {
  const { signIn, fabricAuthEnabled } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSignIn = async () => {
    setError(null)
    setBusy(true)
    try {
      await signIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  const label = busy ? (fabricAuthEnabled ? 'Opening Fabric…' : 'Signing in…') : 'Sign in with Microsoft'

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true" />
          <span className="sidebar-brand-name">FabricSimCity</span>
        </div>

        <h1 className="auth-title">Your capacity, as a city</h1>
        <p className="auth-sub">Sign in to read the capacities you already have access to.</p>

        <button type="button" className="auth-button" onClick={handleSignIn} disabled={busy}>
          <svg viewBox="0 0 21 21" width="15" height="15" aria-hidden="true" focusable="false">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          {label}
        </button>

        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}
