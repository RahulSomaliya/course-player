// @vitest-environment jsdom
// The player in jsdom (no media playback: currentTime is stubbed on the element).
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Lecture } from '../../../shared/types';
import { DEFAULT_PREFS } from '../lib/progress';
import { sampleCourse } from '../lib/test-fixtures';
import { Player } from './Player';

// React 19 act() environment flag; jsdom has no type for it on globalThis.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Player', () => {
  // Review finding (2026-10-01): the unmount save read `video.current` inside the effect CLEANUP, where
  // React has already set object refs to null, so it never saved. Leaving a lecture mid-video (sidebar,
  // Next, Shift+N, Back) lost up to 5 s of position (10 s of video at 2x).
  it('leaving a lecture mid-video saves the exact position', () => {
    const lecture = sampleCourse().sections[0]?.lectures[0] as Lecture;
    const onPosition = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(Player, {
          lecture,
          overline: 'Section 01 · Lecture 1',
          startAt: 0,
          prefs: DEFAULT_PREFS,
          onPrefs: () => undefined,
          onPosition,
          onComplete: () => undefined,
          onPlayingChange: () => undefined,
          next: null,
          onNext: () => undefined,
        }),
      );
    });
    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    // 123.4 s in, last periodic save at 120 s (none recorded here): only the unmount save can store it.
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 123.4, set: () => undefined });
    act(() => root.unmount());
    expect(onPosition).toHaveBeenCalledWith(123.4);
  });
});
