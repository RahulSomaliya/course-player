// Boot → (Who's studying?) → the chosen profile's app. Owns the global states (loading, not running,
// stopped) and the app-level flows: End session / Quit → wrap-up card → send → stop the server.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BootPayload, Course, Profile } from '../../../shared/types';
import { ApiError, getBoot, postSession, quitServer } from '../lib/api';
import { indexCourse } from '../lib/course';
import { navigate, parseHash, useHash, type Route } from '../lib/router';
import type { LiveSession, Mood } from '../lib/session';
import { browserStore, readString, writeString } from '../lib/storage';
import { HomeScreen } from '../screens/home/HomeScreen';
import { BootFailed, LoadingScreen, NoProfiles, Stopped } from '../screens/States';
import { WatchScreen } from '../screens/watch/WatchScreen';
import { WhoScreen } from '../screens/WhoScreen';
import { WrapUp } from '../screens/WrapUp';
import { ProgressContext, ProgressStore } from '../state/progress';
import { StudyContext, StudyController } from '../state/study';
import { applyTheme } from '../state/theme';
import { AppContext, type AppValue } from './context';

const PROFILE_KEY = 'cp:profile';

type Boot = { kind: 'loading' } | { kind: 'failed'; message: string | null } | { kind: 'ready'; data: BootPayload };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(() => readString(browserStore(), PROFILE_KEY));
  const route = parseHash(useHash());

  useEffect(() => {
    const ctrl = new AbortController();
    setBoot({ kind: 'loading' });
    getBoot(ctrl.signal).then(
      (data) => {
        setProfiles(data.profiles);
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

  const updateProfile = useCallback((p: Profile) => setProfiles((list) => list.map((x) => (x.id === p.id ? p : x))), []);
  const pick = useCallback(
    (id: string) => {
      writeString(browserStore(), PROFILE_KEY, id);
      setProfileId(id);
      if (route.name === 'who') navigate({ name: 'home' });
    },
    [route.name],
  );

  if (stopped) return <Stopped />;
  if (boot.kind === 'loading') return <LoadingScreen />;
  if (boot.kind === 'failed') return <BootFailed message={boot.message} onRetry={() => setAttempt((n) => n + 1)} />;
  if (profiles.length === 0) return <NoProfiles />;
  const profile = profiles.find((p) => p.id === profileId);
  if (route.name === 'who' || profile === undefined) return <WhoScreen profiles={profiles} current={profile?.id ?? null} onPick={pick} />;
  return <ProfileApp key={profile.id} course={boot.data.course} profile={profile} route={route} onProfile={updateProfile} onStopped={() => setStopped(true)} />;
}

interface ProfileAppProps {
  course: Course;
  profile: Profile;
  route: Exclude<Route, { name: 'who' }>;
  onProfile: (p: Profile) => void;
  onStopped: () => void;
}

type WrapState = { session: LiveSession; endedAt: number; quitting: boolean };

function ProfileApp({ course, profile, route, onProfile, onStopped }: ProfileAppProps) {
  const index = useMemo(() => indexCourse(course), [course]);
  const connected = useRef(profile.journeyConnected);
  connected.current = profile.journeyConnected;
  const [store] = useState(() => new ProgressStore({ courseId: course.id, profile: profile.id, storage: browserStore() }));
  const [study] = useState(
    () =>
      new StudyController({
        courseId: course.id,
        profile: profile.id,
        progress: store,
        index,
        storage: browserStore(),
        isConnected: () => connected.current,
        send: (s) => postSession(profile.id, s),
      }),
  );
  const [wrap, setWrap] = useState<WrapState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const quitting = useRef(false);

  useEffect(() => {
    let live = true;
    // The screens wait for this read of the SSD copy (one loopback GET, a few ms). WHY: React runs a
    // CHILD's passive effects before this parent effect, so a screen mounted next to it (WatchScreen's
    // `withLast`, see the note there) would change progress before hydrate even starts — on a cleared
    // browser that stamped an empty copy "newest" and overwrote the SSD copy. ProgressStore also queues
    // pre-hydrate changes (state/progress.ts update()), and Watch must read the hydrated `pos` to resume.
    void store.hydrate().then(() => {
      if (live) setHydrated(true);
    });
    const stop = study.start();
    const onHide = (): void => {
      store.flushOnHide();
      study.sendPendingWrap();
    };
    // Bubble phase on purpose: WatchScreen's capture-phase pagehide listener writes the exact video
    // position first, so this keepalive PUT carries it. Do not switch this one to capture.
    window.addEventListener('pagehide', onHide);
    return () => {
      live = false;
      stop();
      window.removeEventListener('pagehide', onHide);
      store.flushOnHide();
    };
  }, [store, study]);

  const theme = useSyncExternalStore(store.subscribe, () => store.get().prefs.theme);
  useEffect(() => applyTheme(theme), [theme]);

  const stopServer = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    await store.flushNow();
    try {
      await quitServer();
    } catch (err) {
      // Already gone (closed terminal) is fine — the page says "Stopped" either way.
      console.error('[quit] the course server did not answer', err);
    }
    onStopped();
  }, [store, onStopped]);

  const endSession = useCallback(() => {
    const s = study.endSession();
    if (s !== null && study.needsWrapUp(s)) setWrap({ session: s, endedAt: Date.now(), quitting: false });
  }, [study]);

  const quit = useCallback(() => {
    const s = study.endSession();
    if (s !== null && study.needsWrapUp(s)) setWrap({ session: s, endedAt: Date.now(), quitting: true });
    else void stopServer();
  }, [study, stopServer]);

  const finishWrap = async (answer: { mood: Mood | null; note: string | null }): Promise<void> => {
    if (wrap === null) return;
    await study.send(wrap.session, { ...answer, endedAt: wrap.endedAt });
    setWrap(null);
    if (wrap.quitting) await stopServer();
  };

  const value: AppValue = useMemo(
    () => ({ course, index, profile, endSession, quit, updateProfile: onProfile }),
    [course, index, profile, endSession, quit, onProfile],
  );

  if (!hydrated) return <LoadingScreen />;
  return (
    <AppContext.Provider value={value}>
      <ProgressContext.Provider value={store}>
        <StudyContext.Provider value={study}>
          {route.name === 'watch' ? <WatchScreen id={route.id} /> : <HomeScreen />}
          {wrap && <WrapUp session={wrap.session} name={profile.name} course={course} quitting={wrap.quitting} onDone={(a) => void finishWrap(a)} />}
        </StudyContext.Provider>
      </ProgressContext.Provider>
    </AppContext.Provider>
  );
}
