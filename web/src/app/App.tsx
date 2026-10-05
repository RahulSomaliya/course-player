// Boot → the learner's app (v2: one learner — the first profile in config.json; no picker, no
// switching). Owns the global states (loading, not running, stopped) and the app-level flows:
// the timer chip / Note to Rahul… / Quit → sign-off card → send → (quit: flush → stop the server).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BootPayload, Course, Profile, ProgressState } from '../../../shared/types';
import { ApiError, getBoot, getFeed, getJourneyStatus, getOutbox, postFeedRead, postSession, putProgressSnapshot, quitServer, retryOutbox } from '../lib/api';
import { indexCourse } from '../lib/course';
import { parseHash, useHash, type Route } from '../lib/router';
import { buildSnapshot } from '../lib/snapshot';
import { browserStore } from '../lib/storage';
import { HomeScreen } from '../screens/home/HomeScreen';
import { SignOffCard, type SignOffOutcome } from '../screens/SignOffCard';
import { BootFailed, LoadingScreen, NoProfiles, Stopped } from '../screens/States';
import { UpdatesScreen } from '../screens/updates/UpdatesScreen';
import { WatchScreen } from '../screens/watch/WatchScreen';
import { JourneyContext, JourneyStore, SnapshotPusher } from '../state/journey';
import { ProgressContext, ProgressStore } from '../state/progress';
import { StudyContext, StudyController } from '../state/study';
import { applyTheme } from '../state/theme';
import { AppContext, type AppValue } from './context';

/** First open with no cached feed: wait this long for Rahul's feed before showing home, so the "From
 *  Rahul" block is there at first paint instead of shoving the page down when it lands (CLS). */
const FEED_WAIT_MS = 1500;

type Boot = { kind: 'loading' } | { kind: 'failed'; message: string | null } | { kind: 'ready'; data: BootPayload };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const route = parseHash(useHash());

  useEffect(() => {
    const ctrl = new AbortController();
    setBoot({ kind: 'loading' });
    getBoot(ctrl.signal).then(
      (data) => {
        setProfile(data.profiles[0] ?? null);
        setBoot({ kind: 'ready', data });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        console.error('[boot] /api/boot failed', err);
        // 503 = the server runs but can't read the course folder (SSD unplugged): show its message.
        setBoot({ kind: 'failed', message: err instanceof ApiError && err.status === 503 ? err.message : null });
      },
    );
    return () => ctrl.abort();
  }, [attempt]);

  if (stopped) return <Stopped />;
  if (boot.kind === 'loading') return <LoadingScreen />;
  if (boot.kind === 'failed') return <BootFailed message={boot.message} onRetry={() => setAttempt((n) => n + 1)} />;
  if (profile === null) return <NoProfiles />;
  return (
    <LearnerApp
      key={profile.id}
      course={boot.data.course}
      folderCourseId={boot.data.folderCourseId}
      profile={profile}
      route={route}
      onProfile={setProfile}
      onStopped={() => setStopped(true)}
    />
  );
}

interface LearnerAppProps {
  course: Course;
  /** BootPayload.folderCourseId: v2 study state may sit under it (state/study.ts migrateLegacy) */
  folderCourseId: string;
  profile: Profile;
  route: Route;
  onProfile: (p: Profile) => void;
  onStopped: () => void;
}

type CardState = { mode: 'session' | 'note'; quitting: boolean };

function LearnerApp({ course, folderCourseId, profile, route, onProfile, onStopped }: LearnerAppProps) {
  const index = useMemo(() => indexCourse(course), [course]);
  const connected = useRef(profile.journeyConnected);
  connected.current = profile.journeyConnected;
  const isConnected = useCallback(() => connected.current, []);
  const [store] = useState(() => new ProgressStore({ courseId: course.id, profile: profile.id, storage: browserStore() }));
  const snapshot = useCallback((state?: ProgressState) => buildSnapshot(course, index, state ?? store.get(), Date.now()), [course, index, store]);
  const [journey] = useState(
    () =>
      new JourneyStore({
        courseId: course.id,
        profile: profile.id,
        storage: browserStore(),
        isConnected,
        api: {
          status: () => getJourneyStatus(profile.id),
          feed: () => getFeed(profile.id),
          read: (ids) => postFeedRead(profile.id, ids),
          outbox: (waitMs) => getOutbox(profile.id, { waitMs }),
          retry: (ids) => retryOutbox(profile.id, ids),
        },
      }),
  );
  const [pusher] = useState(() => new SnapshotPusher({ build: snapshot, put: (s, o) => putProgressSnapshot(profile.id, s, o), isConnected }));
  const [study] = useState(
    () =>
      new StudyController({
        courseId: course.id,
        legacyCourseId: folderCourseId,
        profile: profile.id,
        progress: store,
        index,
        storage: browserStore(),
        // v3: handed to the outbox connected or not (v2 skipped the POST when not connected and forgot
        // the session). Its 202 answer lists the update at once as "Waiting to send".
        send: async (s) => journey.noteOutbox(await postSession(profile.id, s)),
        snapshot,
      }),
  );
  const [hydrated, setHydrated] = useState(false);
  const [feedWait, setFeedWait] = useState(() => profile.journeyConnected && journey.get().feed === null);
  const [card, setCard] = useState<CardState | null>(null);
  const quitting = useRef(false);
  const journeyLoaded = useSyncExternalStore(journey.subscribe, () => journey.get().loaded);

  useEffect(() => {
    let live = true;
    // The screens wait for this read of the SSD copy (one loopback GET, a few ms). WHY: React runs a
    // CHILD's passive effects before this parent effect, so a screen mounted next to it (WatchScreen's
    // `withLast`, see the note there) would change progress before hydrate even starts — on a cleared
    // browser that stamped an empty copy "newest" and overwrote the SSD copy. ProgressStore also queues
    // pre-hydrate changes (state/progress.ts update()), and Watch must read the hydrated `pos` to resume.
    void store.hydrate().then(() => {
      if (!live) return;
      setHydrated(true);
    });
    const stop = study.start();
    // v2 sessions left in this browser go to the outbox once (lib/legacy.ts); it waits for hydrate itself
    // (their snapshot must be the SSD copy), then lists them under "Your updates".
    void study.migrateLegacy().then((sent) => {
      if (live && sent > 0) void journey.refresh();
    });
    void journey.refresh();
    const wait = window.setTimeout(() => setFeedWait(false), FEED_WAIT_MS);
    // Progress changes → her snapshot for the coach, ≤ 1 per 5 min (lib/snapshot.ts). Only after hydrate:
    // the SSD copy may still replace this browser's copy.
    const offProgress = store.subscribe(() => {
      if (store.isHydrated()) pusher.changed();
    });
    const onHide = (): void => {
      store.flushOnHide();
      pusher.flushOnHide();
    };
    const onFocus = (): void => void journey.refreshIfStale();
    // Bubble phase on purpose: WatchScreen's capture-phase pagehide listener writes the exact video
    // position first, so this keepalive PUT carries it. Do not switch this one to capture.
    window.addEventListener('pagehide', onHide);
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      stop();
      offProgress();
      window.clearTimeout(wait);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('focus', onFocus);
      store.flushOnHide();
      pusher.cancel();
    };
  }, [store, study, journey, pusher]);

  useEffect(() => {
    if (journeyLoaded) setFeedWait(false);
  }, [journeyLoaded]);

  // Connected from the header menu (it only updates the profile): fetch her plan + Rahul's feed and
  // give the coach her snapshot now. Without this, home showed no This week / From Rahul / Due until a
  // reload, a sign-off or a refocus ≥ 5 min later (the open-time refresh had already run unconnected).
  const wasConnected = useRef(profile.journeyConnected);
  useEffect(() => {
    const was = wasConnected.current;
    wasConnected.current = profile.journeyConnected;
    if (!profile.journeyConnected || was) return;
    void journey.refresh();
    if (store.isHydrated()) void pusher.pushNow();
  }, [profile.journeyConnected, journey, pusher, store]);

  const theme = useSyncExternalStore(store.subscribe, () => store.get().prefs.theme);
  useEffect(() => applyTheme(theme), [theme]);

  const stopServer = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    await store.flushNow();
    await pusher.pushNow({ keepalive: true });
    try {
      await quitServer();
    } catch (err) {
      // Already gone (closed terminal) is fine — the page says "Stopped" either way.
      console.error('[quit] the course server did not answer', err);
    }
    onStopped();
  }, [store, pusher, onStopped]);

  const openSignOff = useCallback(() => setCard((c) => c ?? { mode: study.getState().session === null ? 'note' : 'session', quitting: false }), [study]);
  const openNote = useCallback(() => setCard((c) => c ?? { mode: 'note', quitting: false }), []);

  const quit = useCallback(() => {
    if (study.getState().session !== null) setCard({ mode: 'session', quitting: true });
    else void stopServer();
  }, [study, stopServer]);

  // The card says whether to quit (its own outcome) — App never re-reads `card` here: a stale
  // `quitting: true` once stopped the server after she chose "keep studying" (2026-10-01 review).
  const cardDone = (outcome: SignOffOutcome): void => {
    setCard(null);
    if (outcome.sent > 0) {
      void pusher.pushNow();
      void journey.refresh(); // his feed after a sign-off (the update now shows in "Your updates")
    }
    if (outcome.quit) void stopServer();
  };

  const value: AppValue = useMemo(
    () => ({ course, index, profile, openSignOff, openNote, quit, updateProfile: onProfile }),
    [course, index, profile, openSignOff, openNote, quit, onProfile],
  );

  if (!hydrated || feedWait) return <LoadingScreen />;
  return (
    <AppContext.Provider value={value}>
      <ProgressContext.Provider value={store}>
        <JourneyContext.Provider value={journey}>
          <StudyContext.Provider value={study}>
            {route.name === 'watch' ? <WatchScreen id={route.id} /> : route.name === 'updates' ? <UpdatesScreen /> : <HomeScreen />}
            {card && <SignOffCard mode={card.mode} quitting={card.quitting} onDone={cardDone} />}
          </StudyContext.Provider>
        </JourneyContext.Provider>
      </ProgressContext.Provider>
    </AppContext.Provider>
  );
}
