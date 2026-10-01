// The video player (spec "The player"): Netflix feel — dark, immersive, chrome that fades 2.5 s after
// the last pointer move while playing and stays while paused. Mounted once per lecture
// (`key={lecture.id}` in Watch), so every piece of state here belongs to one lecture.
import { Maximize, Minimize, Pause, PictureInPicture2, Play, RefreshCw, RotateCcw, SkipForward } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type SyntheticEvent } from 'react';
import type { Lecture, Prefs } from '../../../shared/types';
import { formatClock } from '../lib/format';
import { stepRate, type PlayerAction } from '../lib/keys';
import { PlayerButton, SkipTen, SpeedMenu, VolumeControl } from './Controls';
import { SeekBar } from './SeekBar';
import { UpNext } from './UpNext';

export interface PlayerHandle {
  handle: (action: PlayerAction) => void;
  /** current position, for saving on pagehide/unmount */
  position: () => number;
}

interface Props {
  lecture: Lecture;
  /** "Section 05 · Lecture 13" — shown top-left in fullscreen */
  overline: string;
  /** saved position; resumed when 10 s < pos < duration − 15 s */
  startAt: number;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** every 5 s of playback, on pause, on seek release */
  onPosition: (seconds: number) => void;
  /** ≥ 90 % watched or `ended` — called once */
  onComplete: () => void;
  onPlayingChange: (playing: boolean) => void;
  next: Lecture | null;
  onNext: () => void;
}

const HIDE_AFTER_MS = 2500;
const SAVE_EVERY_S = 5;
const SCRUB_SEEK_MS = 120; // throttle seeks while dragging: each one is a new range request to the SSD

export const Player = forwardRef<PlayerHandle, Props>(function Player(props, ref) {
  const { lecture, overline, startAt, prefs, onPrefs, onPosition, onComplete, onPlayingChange, next, onNext } = props;
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(lecture.duration);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [awake, setAwake] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [ended, setEnded] = useState(false);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [error, setError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pulse, setPulse] = useState<{ icon: 'play' | 'pause'; n: number } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const lastSaved = useRef(0);
  const lastScrubSeek = useRef(0);
  const completed = useRef(false);
  const resumeAt = useRef(startAt);
  const latest = useRef({ onPosition, onComplete, onPlayingChange });
  latest.current = { onPosition, onComplete, onPlayingChange };

  const chromeVisible = awake || !playing || menuOpen || scrubbing || ended || error;

  /** Show the chrome now; hide it again 2.5 s later (it stays while paused — see chromeVisible). */
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setAwake(false), HIDE_AFTER_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // Apply remembered prefs to the element whenever they change.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, prefs.volume));
    v.muted = prefs.muted;
    v.playbackRate = prefs.rate;
    v.defaultPlaybackRate = prefs.rate;
  }, [prefs.volume, prefs.muted, prefs.rate]);

  // Save the position when the lecture unmounts (navigating away mid-video).
  // Capture the element NOW: by the time an unmount cleanup runs React has already set object refs to
  // null, so reading `video.current` in the cleanup silently skipped the save (Player.test.ts).
  useEffect(() => {
    const v = video.current;
    return () => {
      if (v && v.currentTime > 0) latest.current.onPosition(v.currentTime);
      latest.current.onPlayingChange(false);
    };
  }, []);

  // Fullscreen is on the container (not the <video>) so the custom controls stay.
  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const play = useCallback((): void => {
    const v = video.current;
    if (!v) return;
    if (v.ended) v.currentTime = 0;
    setEnded(false);
    // A blocked autoplay (no user gesture yet, e.g. a reload) is fine: we just stay paused.
    v.play().catch((err: unknown) => {
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
      console.error(`[player] play failed for ${lecture.id}`, err);
    });
  }, [lecture.id]);

  const togglePlay = useCallback((): void => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      play();
      setPulse((p) => ({ icon: 'play', n: (p?.n ?? 0) + 1 }));
    } else {
      v.pause();
      setPulse((p) => ({ icon: 'pause', n: (p?.n ?? 0) + 1 }));
    }
  }, [play]);

  const seekTo = useCallback((seconds: number, final = true): void => {
    const v = video.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const t = Math.max(0, Math.min(v.duration - 0.1, seconds));
    setTime(t);
    const now = performance.now();
    if (!final && now - lastScrubSeek.current < SCRUB_SEEK_MS) return;
    lastScrubSeek.current = now;
    v.currentTime = t;
    if (t < v.duration - 0.5) setEnded(false);
    if (final) {
      lastSaved.current = t;
      latest.current.onPosition(t);
    }
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const el = box.current;
    if (!el) return;
    const p = document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen();
    p.catch((err: unknown) => console.error('[player] fullscreen request failed', err));
  }, []);

  const setVolume = useCallback(
    (patch: { volume?: number; muted?: boolean }): void => {
      onPrefs(patch);
    },
    [onPrefs],
  );

  useImperativeHandle(
    ref,
    () => ({
      position: () => video.current?.currentTime ?? 0,
      handle: (a: PlayerAction) => {
        const v = video.current;
        if (!v) return;
        wake();
        switch (a.type) {
          case 'togglePlay':
            togglePlay();
            break;
          case 'seekBy':
            seekTo(v.currentTime + a.seconds);
            break;
          case 'seekToFraction':
            if (Number.isFinite(v.duration)) seekTo(v.duration * a.fraction);
            break;
          case 'volumeBy': {
            const vol = Math.round(Math.max(0, Math.min(1, (prefs.muted ? 0 : prefs.volume) + a.delta)) * 100) / 100;
            setVolume({ volume: vol, muted: vol === 0 });
            break;
          }
          case 'toggleMute':
            setVolume({ muted: !prefs.muted, volume: prefs.muted && prefs.volume === 0 ? 0.5 : prefs.volume });
            break;
          case 'rateStep':
            onPrefs({ rate: stepRate(prefs.rate, a.dir) });
            break;
          case 'fullscreen':
            toggleFullscreen();
            break;
          default:
            break; // next/prev/theatre/help belong to Watch
        }
      },
    }),
    [wake, togglePlay, seekTo, setVolume, onPrefs, prefs.muted, prefs.volume, prefs.rate, toggleFullscreen],
  );

  // ---- media events ---------------------------------------------------------------------------
  const onLoadedMetadata = (e: SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget;
    setDuration(v.duration);
    v.playbackRate = prefs.rate;
    const at = resumeAt.current;
    if (at > 10 && at < v.duration - 15) {
      v.currentTime = at;
      setTime(at);
    }
    resumeAt.current = 0;
    play();
  };
  const onTimeUpdate = (e: SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget;
    if (!scrubbing) setTime(v.currentTime);
    if (Math.abs(v.currentTime - lastSaved.current) >= SAVE_EVERY_S) {
      lastSaved.current = v.currentTime;
      latest.current.onPosition(v.currentTime);
    }
    if (!completed.current && v.duration > 0 && v.currentTime >= v.duration * 0.9) {
      completed.current = true;
      latest.current.onComplete();
    }
  };
  const onProgress = (e: SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) {
        setBufferedEnd(b.end(i));
        return;
      }
    }
  };
  const onPlay = (): void => {
    setPlaying(true);
    setError(false);
    latest.current.onPlayingChange(true);
    wake();
  };
  const onPause = (e: SyntheticEvent<HTMLVideoElement>): void => {
    setPlaying(false);
    latest.current.onPlayingChange(false);
    lastSaved.current = e.currentTarget.currentTime;
    latest.current.onPosition(e.currentTarget.currentTime);
  };
  const onEnded = (): void => {
    setEnded(true);
    setUpNextDismissed(false);
    if (!completed.current) {
      completed.current = true;
      latest.current.onComplete();
    }
  };
  const onError = (e: SyntheticEvent<HTMLVideoElement>): void => {
    const err = e.currentTarget.error;
    console.error(`[player] can't read ${lecture.id}: ${err ? `code ${err.code} ${err.message}` : 'unknown error'}`);
    setError(true);
    setPlaying(false);
    latest.current.onPlayingChange(false);
  };
  const retry = (): void => {
    const v = video.current;
    if (!v) return;
    resumeAt.current = time;
    setError(false);
    v.load();
  };

  const pip = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  const showUpNext = ended && next !== null && !upNextDismissed && !error;
  // Ended without the Up next card (Cancel pressed, or the last lecture): offer the next step in the frame.
  const showEndActions = ended && !showUpNext && !error;

  return (
    <div
      ref={box}
      data-player
      data-state={error ? 'error' : ended ? 'ended' : playing ? 'playing' : 'paused'}
      data-chrome={chromeVisible ? 'visible' : 'hidden'}
      onPointerMove={wake}
      onPointerLeave={() => playing && setAwake(false)}
      className={`group/player relative isolate aspect-video w-full select-none overflow-hidden bg-player text-player-ink ${
        fullscreen ? '' : 'rounded-lg'
      } ${chromeVisible ? '' : 'cursor-none'}`}
    >
      <video
        ref={video}
        src={lecture.src}
        preload="auto"
        playsInline
        className="absolute inset-0 size-full"
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={onTimeUpdate}
        onProgress={onProgress}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={onError}
      />

      {/* click = play/pause (with a centre pulse); double-click = fullscreen */}
      <div className="absolute inset-0 z-0" onClick={togglePlay} onDoubleClick={toggleFullscreen} aria-hidden="true" />

      {pulse && (
        <div key={pulse.n} className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" aria-hidden="true">
          <span className="flex size-20 animate-pulse-out items-center justify-center rounded-full bg-player-scrim">
            {pulse.icon === 'play' ? <Play className="ml-1 size-9 fill-current" strokeWidth={1.5} /> : <Pause className="size-9 fill-current" strokeWidth={1.5} />}
          </span>
        </div>
      )}

      {!playing && !ended && !error && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute left-1/2 top-1/2 z-10 flex size-18 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-player-scrim text-player-ink transition-transform duration-150 ease-out hover:scale-105"
        >
          <Play className="ml-1 size-8 fill-current" strokeWidth={1.5} />
        </button>
      )}

      {error && (
        <div role="alert" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-player px-6 text-center">
          <p className="max-w-sm text-base text-player-ink">Can’t read this video — is the SSD connected?</p>
          <button type="button" onClick={retry} className="inline-flex h-10 items-center gap-2 rounded-md bg-player-hover px-4 text-sm font-medium text-player-ink hover:bg-player-track">
            <RefreshCw className="size-4" strokeWidth={1.5} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {fullscreen && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-linear-to-b from-player-scrim to-transparent px-8 pb-16 pt-6 transition-opacity duration-200 ease-out ${
            chromeVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <p className="text-sm text-player-ink-muted">{overline}</p>
          <p className="mt-1 text-xl font-semibold">{lecture.title}</p>
        </div>
      )}

      {showUpNext && next && <UpNext next={next} autoplay={prefs.autoplay} onPlay={onNext} onCancel={() => setUpNextDismissed(true)} />}

      {showEndActions && (
        <div data-control="end-actions" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-3 pb-10 sm:pb-14">
          <button
            type="button"
            onClick={togglePlay}
            className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full bg-player-scrim px-4 text-sm font-medium text-player-ink hover:bg-player-panel"
          >
            <RotateCcw className="size-4" strokeWidth={1.5} aria-hidden="true" />
            Replay
          </button>
          {next && (
            <button
              type="button"
              onClick={onNext}
              className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full bg-player-accent px-4 text-sm font-medium text-player-on-accent hover:opacity-90"
            >
              <SkipForward className="size-4" strokeWidth={1.5} aria-hidden="true" />
              Next lecture
            </button>
          )}
        </div>
      )}

      <div
        data-control="bar"
        className={`absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-player-scrim via-player-scrim/60 to-transparent px-3 pb-2 pt-10 transition-opacity duration-200 ease-out has-[:focus-visible]:opacity-100 sm:px-4 sm:pt-14 ${
          chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <SeekBar time={time} duration={duration} bufferedEnd={bufferedEnd} onSeek={seekTo} onScrubbing={setScrubbing} />
        <div className="mt-1 flex items-center gap-0.5">
          {/* At the end the same button restarts the lecture (play() rewinds an ended video), so say so. */}
          <PlayerButton label={playing ? 'Pause (K)' : ended ? 'Replay (K)' : 'Play (K)'} onClick={togglePlay}>
            {playing ? (
              <Pause className="size-6 fill-current" strokeWidth={1.5} />
            ) : ended ? (
              <RotateCcw className="size-6" strokeWidth={1.5} />
            ) : (
              <Play className="size-6 fill-current" strokeWidth={1.5} />
            )}
          </PlayerButton>
          <PlayerButton label="Back 10 seconds (J)" wideOnly onClick={() => video.current && seekTo(video.current.currentTime - 10)}>
            <SkipTen dir={-1} />
          </PlayerButton>
          <PlayerButton label="Forward 10 seconds (L)" wideOnly onClick={() => video.current && seekTo(video.current.currentTime + 10)}>
            <SkipTen dir={1} />
          </PlayerButton>
          <VolumeControl volume={prefs.volume} muted={prefs.muted} onChange={setVolume} />
          <p className="ml-2 whitespace-nowrap text-sm tabular-nums text-player-ink">
            {formatClock(time)}
            <span className="text-player-ink-muted"> / {formatClock(duration)}</span>
          </p>
          <div className="ml-auto flex items-center gap-0.5">
            <SpeedMenu
              rate={prefs.rate}
              autoplay={prefs.autoplay}
              onRate={(rate) => onPrefs({ rate })}
              onAutoplay={(autoplay) => onPrefs({ autoplay })}
              onOpenChange={setMenuOpen}
            />
            {next && (
              <PlayerButton label={`Next lecture: ${next.title} (Shift+N)`} onClick={onNext}>
                <SkipForward className="size-6" strokeWidth={1.5} />
              </PlayerButton>
            )}
            {pip && (
              <PlayerButton
                label="Picture in picture"
                wideOnly
                onClick={() => {
                  const v = video.current;
                  if (!v) return;
                  const p = document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture().then(() => undefined);
                  p.catch((err: unknown) => console.error('[player] picture-in-picture failed', err));
                }}
              >
                <PictureInPicture2 className="size-6" strokeWidth={1.5} />
              </PlayerButton>
            )}
            <PlayerButton label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize className="size-6" strokeWidth={1.5} /> : <Maximize className="size-6" strokeWidth={1.5} />}
            </PlayerButton>
          </div>
        </div>
      </div>
    </div>
  );
});
