// Sign in / create an account.
//
// First-party accounts: an email and a password, nothing else. The page is
// reachable from `/capture` with a `returnTo`, so signing in from a guarded
// route lands where the user was actually going.

import { useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError, authPath } from '../lib/api'
import { navigate, useTitle } from '../lib/router'
import { useAccountActions, useSession } from '../lib/session'

const MIN_PASSWORD = 10

function returnTo(): string {
  if (typeof window === 'undefined') return '/capture'
  const raw = new URLSearchParams(window.location.search).get('returnTo')
  // Only same-origin paths: an absolute URL here would be an open redirect.
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw
  return '/capture'
}

export function AuthPage() {
  const { user } = useSession()
  const { create, enter } = useAccountActions()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const destination = returnTo()
  useTitle(mode === 'signin' ? 'Sign in · ObjectCapture AR' : 'Create an account · ObjectCapture AR')

  if (user) {
    return (
      <div className="app">
        <header className="topbar">
          <a href="/" className="brand" onClick={(e) => (e.preventDefault(), navigate('/'))}>
            <span className="mark">AR</span> ObjectCapture
          </a>
          <span className="spacer" />
        </header>
        <main className="page">
          <div className="card">
            <h3>You are signed in as {user.email}</h3>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => navigate(destination)}>
                Continue
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (mode === 'signup' && password.length < MIN_PASSWORD) {
      setError(`Choose a password of at least ${MIN_PASSWORD} characters.`)
      return
    }
    setBusy(true)
    try {
      if (mode === 'signup') await create({ email, password, name })
      else await enter({ email, password })
      navigate(destination, { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The account service could not be reached. Check your connection and try again.',
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
        <a
          className="btn ghost"
          href={authPath('/capture')}
          onClick={(e) => (e.preventDefault(), navigate('/capture'))}
        >
          Capture
        </a>
      </header>

      <main className="page">
        <section className="hero">
          <div className="eyebrow">Your captures, your account</div>
          <h2>
            {mode === 'signin'
              ? 'Sign in to your captures.'
              : 'Create an account to keep your captures.'}
          </h2>
          <p className="lede">
            A capture costs a full reconstruction run, so it is stored against the account that
            made it. Nothing else is collected: an email address, a password, and the models you
            build. Sharing a model is a separate, revocable decision you make on its page.
          </p>
        </section>

        <div className="card" style={{ marginTop: 22, maxWidth: 460 }}>
          <div className="btn-row" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signin'}
              className={`btn ${mode === 'signin' ? 'primary' : 'ghost'}`}
              onClick={() => {
                setMode('signin')
                setError(null)
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              className={`btn ${mode === 'signup' ? 'primary' : 'ghost'}`}
              onClick={() => {
                setMode('signup')
                setError(null)
              }}
            >
              Create account
            </button>
          </div>

          <form onSubmit={(e) => void submit(e)} style={{ marginTop: 16 }}>
            {mode === 'signup' && (
              <div className="field">
                <label htmlFor="auth-name">Name (optional)</label>
                <input
                  id="auth-name"
                  name="name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What should we call you?"
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : ''}
              />
            </div>

            {error && (
              <div className="note error" role="alert">
                {error}
              </div>
            )}

            <button className="btn primary wide" type="submit" disabled={busy}>
              {busy
                ? mode === 'signup'
                  ? 'Creating your account…'
                  : 'Signing in…'
                : mode === 'signup'
                  ? 'Create account'
                  : 'Sign in'}
            </button>
          </form>

          <p className="faint" style={{ marginBottom: 0 }}>
            Passwords are stored as scrypt hashes. The session is an HttpOnly cookie, so no script
            on the page can read it.
          </p>
        </div>
      </main>
    </div>
  )
}
