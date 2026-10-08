// The account page: who you are, and the one irreversible thing you can do.
//
// Deletion lives behind this page rather than in the header so it cannot be
// tapped by accident: it needs the password typed again, and the button stays
// disabled until it is. The page states plainly what goes -- every capture,
// every stored model, every session -- because there is nothing to recover
// afterwards.

import { useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../lib/api'
import { navigate, useTitle } from '../lib/router'
import { useAccountActions, useSession } from '../lib/session'
import { AccountLink } from '../components/AccountLink'

function memberSince(createdAt: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return date.toISOString().slice(0, 10)
}

export function AccountPage() {
  const { user } = useSession()
  const { destroy } = useAccountActions()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useTitle('Account · ObjectCapture AR')

  // RequireAuth renders this page only for a signed-in account, but the store
  // can still settle to signed-out between a render and a click, so it is not
  // assumed here.
  if (!user) {
    return (
      <div className="app">
        <main className="page">
          <div className="card">
            <p>You are signed out. Sign in again to manage your account.</p>
          </div>
        </main>
      </div>
    )
  }

  async function remove(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await destroy(password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The account service could not be reached, so nothing was deleted.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          <span className="mark">AR</span> ObjectCapture
        </a>
        <span className="spacer" />
        <AccountLink />
      </header>

      <main className="page">
        <section className="hero">
          <div className="eyebrow">Account</div>
          <h2>Your account and your captures.</h2>
          <p className="lede">
            Your captures belong to this account. They are private until you create a share link
            for one of them, and revoking that link is immediate.
          </p>
        </section>

        <div className="card" style={{ marginTop: 22, maxWidth: 520 }}>
          <h3>Signed in as {user.name || user.email}</h3>
          <div className="stat">
            <span className="faint">Email</span>
            <span>{user.email}</span>
          </div>
          {user.name && (
            <div className="stat">
              <span className="faint">Name</span>
              <span>{user.name}</span>
            </div>
          )}
          <div className="stat">
            <span className="faint">Member since</span>
            <span>{memberSince(user.createdAt)}</span>
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={() => navigate('/capture')}>
              New capture
            </button>
          </div>
        </div>

        <div className="card" style={{ maxWidth: 520 }}>
          <h3>Delete this account</h3>
          <p className="faint" style={{ marginTop: 0 }}>
            This removes the account, every capture it owns and every model stored for it, and
            signs out every device. A running reconstruction is stopped first. It cannot be
            undone, and there is no export — so download any model you want to keep before
            deleting.
          </p>

          <form onSubmit={(e) => void remove(e)}>
            <div className="field">
              <label htmlFor="account-password">Confirm your password</label>
              <input
                id="account-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your current password"
              />
            </div>

            {error && (
              <div className="note error" role="alert">
                {error}
              </div>
            )}

            <button className="btn danger wide" type="submit" disabled={busy || password.length === 0}>
              {busy ? 'Deleting your account…' : 'Delete my account and its captures'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
