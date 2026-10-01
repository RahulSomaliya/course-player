// Tiny hash router: #/ home, #/watch/<encodeURIComponent(lectureId)>, #/who (spec §3).
import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'who' } | { name: 'watch'; id: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/who') return { name: 'who' };
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
  if (route.name === 'who') return '#/who';
  if (route.name === 'watch') return `#/watch/${encodeURIComponent(route.id)}`;
  return '#/';
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (window.location.hash !== href) window.location.hash = href;
}

const subscribe = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

/** The current hash string; parse it with parseHash (a string snapshot keeps useSyncExternalStore stable). */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
