// Tiny hash router: #/ home, #/watch/<encodeURIComponent(lectureId)>, #/updates (all her updates).
import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'updates' } | { name: 'watch'; id: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/updates') return { name: 'updates' };
  if (path.startsWith('/watch/')) {
    try {
      const id = decodeURIComponent(path.slice('/watch/'.length));
      if (id !== '') return { name: 'watch', id };
    } catch {
      // a malformed escape in a hand-typed URL — fall through to home
    }
  }
  return { name: 'home' };
}

export function hrefFor(route: Route): string {
  if (route.name === 'updates') return '#/updates';
  if (route.name === 'watch') return `#/watch/${encodeURIComponent(route.id)}`;
  return '#/';
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash !== href) window.location.hash = href;
}

const listeners = new Set<() => void>();

export function subscribeHash(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener('hashchange', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('hashchange', cb);
  };
}

/**
 * navigate() + tell subscribers NOW instead of on the (async) hashchange event. For a View Transition
 * (lib/motion.ts): the browser captures the new state when the update callback returns, so the new
 * screen must already be rendered — call this inside flushSync. The later hashchange is a no-op
 * (useSyncExternalStore sees the same hash string).
 */
export function navigateNow(route: Route): void {
  navigate(route);
  for (const cb of listeners) cb();
}

/** The current hash string; parse it with parseHash (a string snapshot keeps useSyncExternalStore stable). */
export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => window.location.hash);
}
