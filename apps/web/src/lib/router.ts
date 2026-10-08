// A minimal history-API router. The app has four routes; a router library would
// be more dependency than the product needs.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { MouseEvent } from 'react'

const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

window.addEventListener('popstate', emit)

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  emit()
  window.scrollTo(0, 0)
}

export function useLocation(): string {
  return useSyncExternalStore(
    useCallback((fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }, []),
    () => window.location.pathname,
    () => '/',
  )
}

/** Navigate when a link is clicked, without a full page load. */
export function onLinkClick(handler: (to: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    const anchor = event.currentTarget
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.button !== 0 ||
      anchor.target === '_blank'
    ) {
      return
    }
    event.preventDefault()
    handler(anchor.getAttribute('href') ?? '/')
  }
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title
  }, [title])
}