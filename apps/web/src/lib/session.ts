// Who is signed in, shared by every component that needs to know.
//
// One module-level store rather than a fetch per component: the header, the
// capture screen and the model page all ask, and they must never disagree about
// whether there is an account. Same shape as the router: a tiny external store
// read through useSyncExternalStore, no context provider to thread through.

import { useCallback, useSyncExternalStore } from 'react'

import { deleteAccount, getSession, signIn, signOut, signUp } from './api'
import type { Account, DeleteAccountResult } from './api'

export interface SessionState {
  /** True until the first answer from the server arrives. */
  loading: boolean
  user: Account | null
}

let state: SessionState = { loading: true, user: null }
const listeners = new Set<() => void>()

function emit(next: SessionState) {
  state = next
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Ask the server once per page load; `me` answers signed-out with a null user.
 * It runs when this module is first imported rather than from a component, so
 * the answer is already on its way before the first render asks for it.
 */
getSession()
  .then(({ user }) => emit({ loading: false, user }))
  // A failed bootstrap is not an error the user can act on. Treat an
  // unreachable API as signed out; the guard then sends them to sign in, and
  // signing in surfaces the real connection error.
  .catch(() => emit({ loading: false, user: null }))


export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/**
 * The three account actions, each returning the ApiError message rather than
 * throwing it, because every caller renders it into the form.
 */
export function useAccountActions() {
  const create = useCallback(
    async (input: { email: string; password: string; name?: string }) => {
      const { user } = await signUp(input)
      emit({ loading: false, user })
    },
    [],
  )

  const enter = useCallback(async (input: { email: string; password: string }) => {
    const { user } = await signIn(input)
    emit({ loading: false, user })
  }, [])

  const leave = useCallback(async () => {
    try {
      await signOut()
    } finally {
      emit({ loading: false, user: null })
    }
  }, [])

  /**
   * Delete the account. The store is cleared only after the server confirms it:
   * a wrong password must not sign the user out of a session that is still
   * valid, and the thrown ApiError is what the page renders.
   */
  const destroy = useCallback(async (password: string): Promise<DeleteAccountResult> => {
    const result = await deleteAccount(password)
    emit({ loading: false, user: null })
    return result
  }, [])

  return { create, enter, leave, destroy }
}
