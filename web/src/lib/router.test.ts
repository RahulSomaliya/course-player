// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hrefFor, navigateNow, parseHash, subscribeHash } from './router';

describe('hash routes', () => {
  it('parses home, updates and watch', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/updates')).toEqual({ name: 'updates' });
    expect(hrefFor({ name: 'updates' })).toBe('#/updates');
    expect(parseHash('#/watch/05%20Working%2FA%20%231.mp4')).toEqual({ name: 'watch', id: '05 Working/A #1.mp4' });
  });
  it('unknown or malformed → home', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'home' });
    expect(parseHash('#/who')).toEqual({ name: 'home' }); // v1's profile picker is gone (one learner)
    expect(parseHash('#/watch/%E0%A4%A')).toEqual({ name: 'home' });
    expect(parseHash('#/watch/')).toEqual({ name: 'home' });
  });
  it('round-trips a lecture id with spaces, slashes, # and !', () => {
    const id = "01 Welcome, Welcome, Welcome!/04 Read Before You Start!.html";
    expect(parseHash(hrefFor({ name: 'watch', id }))).toEqual({ name: 'watch', id });
    expect(hrefFor({ name: 'home' })).toBe('#/');
  });
});

describe('navigateNow (inside a View Transition update callback)', () => {
  it('changes the hash and tells subscribers synchronously — the new screen must render before the callback returns', () => {
    window.location.hash = '#/';
    const seen: string[] = [];
    const off = subscribeHash(() => seen.push(window.location.hash));
    navigateNow({ name: 'updates' });
    expect(seen).toEqual(['#/updates']);
    off();
  });
});
