// The header's account chip: who you are, and the way in or out.
//
// One component for every header so the product never shows a "Sign in" button
// to somebody who is already signed in.

import { authPath } from '../lib/api'
import { navigate } from '../lib/router'
import { useAccountActions, useSession } from '../lib/session'

export function AccountLink({ returnTo = '/capture' }: { returnTo?: string }) {
  const { user, loading } = useSession()
  const { leave } = useAccountActions()

  if (loading) return null

  if (!user) {
    return (
      <a
        className="btn ghost"
        href={authPath(returnTo)}
        onClick={(e) => (e.preventDefault(), navigate(authPath(returnTo)))}
      >
        Sign in
      </a>
    )
  }

  return (
    <span className="account">
      <a
        className="faint"
        href="/account"
        title={`${user.email} — account settings`}
        onClick={(e) => (e.preventDefault(), navigate('/account'))}
      >
        {user.name || user.email}
      </a>
      <button
        className="btn quiet"
        onClick={() => {
          void leave().then(() => navigate('/'))
        }}
      >
        Sign out
      </button>
    </span>
  )
}
