// Route table. Six routes, no router dependency.
//
// `/capture` and `/account` are behind an account: a reconstruction costs a full
// pipeline run and belongs to somebody, and deleting an account destroys it. The
// public routes are the landing page, the sign-in page, and `/model/:id` and
// `/ar/:id`, which are readable either by the owning account or by anyone
// holding the capture's share token.

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { AccountPage } from './pages/Account'
import { ArPage } from './pages/Ar'
import { AuthPage } from './pages/Auth'
import { CapturePage } from './pages/Capture'
import { LandingPage } from './pages/Landing'
import { ModelPage } from './pages/Model'
import { authPath } from './lib/api'
import { navigate, useLocation } from './lib/router'
import { useSession } from './lib/session'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sends a signed-out visitor to the sign-in page and remembers where they were
 * going. While the session is still unknown it renders neither the page nor a
 * redirect, so a reloaded page never flashes the sign-in screen at somebody who
 * is already signed in.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()

  useEffect(() => {
    if (!loading && !user) {
      navigate(authPath(window.location.pathname + window.location.search), { replace: true })
    }
  }, [loading, user])

  if (loading || !user) {
    return (
      <div className="app">
        <main className="page">
          <div className="card">
            <p>{loading ? 'Checking your account…' : 'Sending you to sign in…'}</p>
          </div>
        </main>
      </div>
    )
  }

  return <>{children}</>
}

export function App() {
  const path = useLocation().replace(/\/+$/, '') || '/'

  if (path === '/') return <LandingPage />
  if (path === '/auth') return <AuthPage />
  if (path === '/capture') {
    return (
      <RequireAuth>
        <CapturePage />
      </RequireAuth>
    )
  }
  if (path === '/account') {
    return (
      <RequireAuth>
        <AccountPage />
      </RequireAuth>
    )
  }

  const model = /^\/model\/([^/]+)$/.exec(path)
  if (model && UUID.test(model[1])) return <ModelPage id={model[1]} />

  const ar = /^\/ar\/([^/]+)$/.exec(path)
  if (ar && UUID.test(ar[1])) return <ArPage id={ar[1]} />

  return (
    <div className="app">
      <main className="page">
        <div className="card">
          <h3>Page not found</h3>
          <p>
            <code>{path}</code> is not a route in this app. Start from the capture screen.
          </p>
          <a className="btn primary" href="/capture">
            Go to capture
          </a>
        </div>
      </main>
    </div>
  )
}
