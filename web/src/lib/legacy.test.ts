import { describe, expect, it, vi } from 'vitest';
import type { ProgressSnapshot } from '../../../shared/types';
import { LEGACY_MIN_SECONDS, legacyKeys, legacyUpdate, readLegacy, type LegacySession } from './legacy';
import type { KeyValueStore } from './storage';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const tue = new Date(2026, 8, 29, 20, 0).getTime();
const v2 = (over: Partial<LegacySession> = {}): LegacySession => ({
  id: 'old',
  startedAt: tue,
  lastStudyAt: tue + 72 * 60_000,
  seconds: 72 * 60,
  sectionSeconds: { 3: 72 * 60 },
  lecturesCompleted: [{ section: 3, lecture: 1, title: 'Props' }],
  finishedSections: [],
  ...over,
});

describe('readLegacy: v2 state left in this browser (spec v3 A3 "Legacy v2 state")', () => {
  it('reads :session, :pending and :wrap — under the pinned course id AND the old folder id', () => {
    const storage = memoryStore({
      'cp:react-2023:mansi:session': JSON.stringify(v2({ id: 'live' })),
      'cp:react-course:mansi:pending': JSON.stringify([{ ...v2({ id: 'tue' }), skippedAt: tue }, v2({ id: 'live' })]),
      'cp:react-course:mansi:wrap': JSON.stringify({ session: v2({ id: 'v1-wrap' }), endedAt: tue }),
      'cp:react-2023:mansi:progress': '{}',
    });
    const { sessions, keys } = readLegacy(storage, ['react-2023', 'react-course'], 'mansi');
    expect(sessions.map((s) => s.id)).toEqual(['live', 'tue', 'v1-wrap']); // each id once
    expect(keys.sort()).toEqual(['cp:react-2023:mansi:session', 'cp:react-course:mansi:pending', 'cp:react-course:mansi:wrap']);
  });

  it('an unreadable legacy value is reported (its key is still listed, to be removed) — never silently kept forever', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStore({ 'cp:c:mansi:session': '{"id":"half"' });
    const { sessions, keys } = readLegacy(storage, ['c'], 'mansi');
    expect(sessions).toEqual([]);
    expect(keys).toEqual(['cp:c:mansi:session']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('nothing stored → nothing to do', () => {
    expect(readLegacy(memoryStore(), ['c'], 'mansi')).toEqual({ sessions: [], keys: [] });
    expect(readLegacy(null, ['c'], 'mansi')).toEqual({ sessions: [], keys: [] });
  });

  it('lists the three keys for each course id', () => {
    expect(legacyKeys(['a', 'b'], 'mansi')).toEqual([
      'cp:a:mansi:session',
      'cp:a:mansi:pending',
      'cp:a:mansi:wrap',
      'cp:b:mansi:session',
      'cp:b:mansi:pending',
      'cp:b:mansi:wrap',
    ]);
  });
});

const SNAP: ProgressSnapshot = {
  course: 'react-2023',
  takenAt: 0,
  lecturesDone: 1,
  lecturesTotal: 7,
  videoSecondsDone: 600,
  videoSecondsTotal: 4260,
  sectionsDone: [],
  current: { sectionNumber: 3, lectureNumber: 2, title: 'State' },
  days: {},
};

describe('legacyUpdate: a v2 session is sent once, as it was recorded', () => {
  it('its studied seconds, autoClosed true, no note — endedAt = its last studied second', () => {
    expect(legacyUpdate(v2(), { courseId: 'react-2023', progress: SNAP, fallbackSection: 7 })).toEqual({
      id: 'old',
      course: 'react-2023',
      startedAt: new Date(tue).toISOString(),
      endedAt: new Date(tue + 72 * 60_000).toISOString(),
      studyDate: '2026-09-29',
      minutes: 72,
      sectionNumber: 3,
      lecturesCompleted: [{ section: 3, lecture: 1, title: 'Props' }],
      finishedSections: [],
      mood: null,
      note: null,
      stuck: false,
      autoClosed: true,
      progress: SNAP,
    });
  });

  it('caps at 1440 min; no section time → the fallback section', () => {
    const u = legacyUpdate(v2({ seconds: 30 * 3600, sectionSeconds: {} }), { courseId: 'c', progress: null, fallbackSection: 7 });
    expect(u).toMatchObject({ minutes: 1440, sectionNumber: 7 });
  });

  it('one minute is the floor for sending (JS Journey needs minutes > 0 without a note)', () => {
    expect(LEGACY_MIN_SECONDS).toBe(60);
    expect(legacyUpdate(v2({ seconds: 60 }), { courseId: 'c', progress: null, fallbackSection: 1 }).minutes).toBe(1);
  });
});
