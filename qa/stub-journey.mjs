// Stub JS Journey for local QA of Course Player v2 (docs/spec-v2-coaching.md). Node built-ins only.
//   node qa/stub-journey.mjs [--port 8890] [--variant normal|diwali]
// Implements the 5 player routes (Bearer = the student token in the course's config.json link,
// http://localhost:8890/m/stub-mansi-token): GET status, POST sessions, GET feed, POST feed/read,
// PUT progress. Fixture: a week of her updates (relative to today), 2 unread replies quoting her
// notes, 1 unread standalone note, status with sectionDue / skippedSections / planBreak null.
// The "diwali" variant sends the break (1–15 Nov 2026); QA fakes the browser clock into it.
// v3 (docs/spec-v3-study-timer.md): status carries `plan` (the coach page's rows) + the plan calendar;
// an unknown course answers 404 "unknown course" like JS Journey (the player matches that text); and
// POST /__stub/reject {on: true} makes POST sessions refuse every update that way (the "Didn't reach
// Rahul · Try again" path) until {on: false}.
// QA helpers (no auth): GET /__stub/state, POST /__stub/reset, POST /__stub/variant {variant},
// POST /__stub/reject {on}.
// Never point this at real data: everything lives in memory and is gone when it stops.
import http from 'node:http';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg('port', process.env.PORT ?? '8890'));
const TOKEN = 'stub-mansi-token';
const COURSE = 'react-2023';
/** a small page so "See all" / "Show more" have something to page through */
const PAGE = 6;
let variant = arg('variant', 'normal');
/** POST /__stub/reject {on}: every update is refused (404 unknown course) — the rejected path */
let rejectSessions = false;

const SECTION_TITLES = {
  1: 'Welcome, Welcome, Welcome!', 2: 'React Fundamentals', 3: 'A First Look at React', 4: 'Review of Essential JavaScript for React',
  5: 'Working With Components, Props, and JSX', 6: 'State, Events, and Forms - Interactive Components', 7: 'Thinking In React - State Management',
  8: "Practice Project - Eat-'N-Split", 9: 'Intermediate React', 10: 'Thinking in React - Components, Composition, and Reusability',
  11: 'How React Works Behind the Scenes', 12: 'Effects and Data Fetching', 13: 'Custom Hooks, Refs, and More State',
  14: 'React Before Hooks - Class-Based React', 15: 'Advanced React + Redux', 16: 'The Advanced useReducer Hook',
  17: 'React Router - Building Single-Page Applications (SPA)', 18: 'Advanced State Management - The Context API',
  19: 'Performance Optimization and Advanced useEffect', 20: 'Redux and Modern Redux Toolkit (With Thunks)', 21: 'Professional React Development',
  22: 'React Router With Data Loading (v6.4+)', 23: 'Tailwind CSS Crash Course - Styling the App', 24: 'Adding Redux and Advanced React Router',
  25: 'Setting Up Our Biggest Project + Styled Components', 26: 'Supabase Crash Course - Building a Back-End!', 27: 'React Query - Managing Remote State',
  28: 'Advanced React Patterns', 29: 'Implementing More Features - Authentication, Dark Mode, Dashboard, etc.', 30: 'Deployment With Netlify and Vercel', 31: 'The End!',
};

// React plan (JS Journey lib/config.ts): starts Mon 5 Oct 2026, 10 study weeks, Diwali 1–15 Nov off,
// target Fri 25 Dec. A section is due on the Friday of the plan week that finishes it.
const DUE_BY_WEEK = [
  ['2026-10-09', [1, 2, 3, 5, 6, 7]],
  ['2026-10-16', [8, 9, 10, 11]],
  ['2026-10-23', [12, 13]],
  ['2026-10-30', [14, 15, 16, 17]],
  ['2026-11-20', [18, 19]],
  ['2026-11-27', [20, 21, 22]],
  ['2026-12-04', [23, 24]],
  ['2026-12-11', [25, 26]],
  ['2026-12-18', [27, 28]],
  ['2026-12-25', [29, 30, 31]],
];
const sectionDue = Object.fromEntries(DUE_BY_WEEK.flatMap(([due, sections]) => sections.map((n) => [String(n), due])));

const DIWALI = { start: '2026-11-01', end: '2026-11-15' };

/** JS Journey lib/journey-view.ts planRows, roughly: each week's goal = its last section, the break in
 *  place. `current` = the plan week the variant is in. */
function plan(current) {
  const rows = [];
  DUE_BY_WEEK.forEach(([due, sections], i) => {
    const week = i + 1;
    if (due > DIWALI.end && !rows.some((r) => r.kind === 'break')) rows.push({ kind: 'break', label: 'Diwali', ...DIWALI, now: variant === 'diwali' });
    const last = sections[sections.length - 1];
    const state = week < current ? 'done' : week === current ? 'current' : 'upcoming';
    rows.push({ kind: 'week', week, due, goal: `§${last} ${SECTION_TITLES[last]}`, state });
  });
  return rows;
}

function status() {
  const base = {
    targetDate: '2026-12-25',
    deadline: '2027-01-01',
    totalWeeks: 10,
    coachNote: null,
    sectionDue,
    skippedSections: [4],
    studyWeekdays: [1, 2, 3, 4, 5],
    planBreaks: [{ label: 'Diwali break', ...DIWALI }],
  };
  if (variant === 'diwali') {
    return {
      ...base,
      pace: 'on-track',
      daysDelta: 0,
      week: 5,
      goal: { sectionNumber: 19, title: SECTION_TITLES[19], due: '2026-11-20' },
      planBreak: { label: 'Diwali break', start: '2026-11-01', end: '2026-11-15' },
      plan: plan(5),
    };
  }
  return {
    ...base,
    pace: 'ahead',
    daysDelta: 2,
    week: 1,
    goal: { sectionNumber: 7, title: SECTION_TITLES[7], due: '2026-10-09' },
    planBreak: null,
    plan: plan(1),
  };
}

// ---- fixture feed ----------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** local time `daysAgo` days back at hh:mm, as ISO */
function at(daysAgo, hh, mm) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d;
}
const lec = (section, lecture, title) => ({ section, lecture, title });
/** Coach message ids are uuids, as in JS Journey: the course server refuses "Got it" for anything else. */
const msgId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture() {
  const now = new Date().toISOString();
  const u = (daysAgo, hh, mm, over) => {
    const end = at(daysAgo, hh, mm);
    return {
      id: `fx-${daysAgo}`,
      source: 'player',
      studyDate: dayKey(end),
      createdAt: end.toISOString(),
      minutes: 60,
      sectionNumber: 7,
      sectionTitle: SECTION_TITLES[7],
      lectures: [],
      mood: '🙂',
      note: null,
      stuck: false,
      coachReadAt: now,
      replies: [],
      ...over,
    };
  };
  const reply = (id, daysAgo, hh, mm, body, read) => ({ id, body, createdAt: at(daysAgo, hh, mm).toISOString(), readAt: read ? now : null });
  return {
    updates: [
      u(0, 9, 40, {
        minutes: 45,
        lectures: [lec(7, 5, 'Deriving State'), lec(7, 6, 'Calculating Statistics as Derived State')],
        note: 'Derived state — so I should NOT keep numItems in its own useState? Just compute it from items every render?',
        coachReadAt: null,
      }),
      u(1, 21, 15, {
        minutes: 100,
        lectures: [lec(7, 2, 'Fragments'), lec(7, 3, 'What is State in React?'), lec(7, 4, 'Thinking About State and Lifting State Up')],
        note: 'Lifting state up: moved the items array into App and passed setItems down. Makes sense, but the prop names get confusing fast.',
        replies: [reply(msgId(1), 0, 7, 55, 'Good instinct. Name the props onAddItem / onDeleteItem and the functions inside the component handleAddItem — Jonas switches to that in the next lectures, and it keeps the wiring readable.', false)],
      }),
      u(2, 20, 30, {
        minutes: 72,
        sectionNumber: 6,
        sectionTitle: SECTION_TITLES[6],
        mood: '😩',
        stuck: true,
        lectures: [lec(6, 11, 'Updating State Based on Current State')],
        note: 'useState with objects confused me — I changed user.name and nothing re-rendered. Spent 40 min on it.',
        replies: [reply(msgId(2), 1, 8, 10, 'Classic one, and a good thing to hit early! React compares by reference: setUser({ ...user, name }) makes a new object, so it re-renders. Changing user.name keeps the same object and React skips the render.', false)],
      }),
      u(3, 19, 50, {
        minutes: 125,
        sectionNumber: 6,
        sectionTitle: SECTION_TITLES[6],
        mood: '😐',
        lectures: [lec(6, 7, 'Controlled Elements'), lec(6, 8, 'State vs. Props')],
        note: 'Controlled inputs: why does the input need both value and onChange?',
        replies: [reply(msgId(3), 3, 22, 5, 'Because React owns the value now: value shows the state, onChange updates it. Without onChange the input is read-only.', true)],
      }),
      u(4, 11, 0, {
        id: 'fx-manual',
        source: 'manual',
        minutes: 30,
        sectionNumber: 6,
        sectionTitle: SECTION_TITLES[6],
        mood: '🙂',
        note: 'Read the React docs page on state on my phone while travelling.',
      }),
      u(5, 18, 45, {
        minutes: 70,
        sectionNumber: 5,
        sectionTitle: SECTION_TITLES[5],
        mood: '😄',
        lectures: [lec(5, 13, 'Challenge #1: Profile Card (v1)')],
        note: 'Did the Profile Card challenge on my own!',
        replies: [reply(msgId(4), 5, 21, 0, 'That is the way. 🎉', true)],
      }),
      u(6, 20, 10, {
        minutes: 95,
        sectionNumber: 5,
        sectionTitle: SECTION_TITLES[5],
        mood: '😄',
        lectures: [lec(5, 8, 'Components as Building Blocks'), lec(5, 9, 'Passing and Receiving Props')],
        note: 'Props finally clicked — passing data down feels natural now.',
        replies: [reply(msgId(5), 6, 22, 30, 'Love it. Try the Profile Card challenge without peeking at the solution first.', true)],
      }),
      u(8, 19, 0, { minutes: 80, sectionNumber: 5, sectionTitle: SECTION_TITLES[5], note: null, mood: null }),
    ],
    notes: [
      { id: msgId(6), body: 'Proud of this week, Mansi. Six days in a row — keep the evenings short and steady; you are already ahead of the plan.', createdAt: at(0, 8, 10).toISOString(), readAt: null },
      { id: msgId(7), body: 'Welcome to React! One section a day is plenty.', createdAt: at(9, 9, 0).toISOString(), readAt: now },
    ],
  };
}

let db = { ...fixture(), sessions: [], reads: [], progress: null };
const reset = () => {
  db = { ...fixture(), sessions: [], reads: [], progress: null };
};

// ---- HTTP -------------------------------------------------------------------------------------------

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : JSON.parse(text);
}

/** Keyset cursor "<createdAt>|<id>" like the real JS Journey (lib/feed.ts): a new update arriving
 *  between two page loads must not shift page 2 (an offset cursor repeated or skipped rows). */
const newestFirst = (a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1);
function feedPage(cursor, limit) {
  const size = Math.min(limit, PAGE);
  const all = [...db.updates].sort(newestFirst);
  const [cAt, cId] = cursor ? cursor.split('|') : [null, null];
  const rest = cAt === null ? all : all.filter((u) => u.createdAt < cAt || (u.createdAt === cAt && u.id < cId));
  const updates = rest.slice(0, size);
  const lastOnPage = updates.at(-1);
  const next = rest.length > size && lastOnPage ? `${lastOnPage.createdAt}|${lastOnPage.id}` : null;
  const unread = db.notes.filter((n) => n.readAt === null).length + db.updates.flatMap((u) => u.replies).filter((r) => r.readAt === null).length;
  return { updates, notes: db.notes, unreadForStudent: unread, nextCursor: next };
}

function toUpdate(s) {
  return {
    id: s.id,
    source: 'player',
    studyDate: s.studyDate,
    createdAt: new Date().toISOString(),
    minutes: s.minutes,
    sectionNumber: s.sectionNumber,
    sectionTitle: SECTION_TITLES[s.sectionNumber] ?? null,
    lectures: s.lecturesCompleted,
    mood: s.mood,
    note: s.note,
    stuck: s.stuck === true,
    coachReadAt: null,
    replies: [],
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /__stub/state') return send(res, 200, { variant, sessions: db.sessions, reads: db.reads, progress: db.progress });
    if (route === 'POST /__stub/reset') {
      reset();
      rejectSessions = false;
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /__stub/variant') {
      variant = (await readBody(req))?.variant === 'diwali' ? 'diwali' : 'normal';
      return send(res, 200, { variant });
    }
    if (route === 'POST /__stub/reject') {
      rejectSessions = (await readBody(req))?.on === true;
      return send(res, 200, { rejectSessions });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'invalid token' });

    if (route === 'GET /api/player/status') {
      if (url.searchParams.get('course') !== COURSE) return send(res, 404, { error: 'unknown course' });
      return send(res, 200, status());
    }
    if (route === 'GET /api/player/feed') {
      const limit = Number(url.searchParams.get('limit') ?? '30') || 30;
      return send(res, 200, feedPage(url.searchParams.get('cursor'), limit));
    }
    if (route === 'POST /api/player/feed/read') {
      const body = await readBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      db.reads.push(ids);
      const now = new Date().toISOString();
      for (const m of [...db.notes, ...db.updates.flatMap((u) => u.replies)]) if (ids.includes(m.id) && m.readAt === null) m.readAt = now;
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/player/sessions') {
      const s = await readBody(req);
      if (rejectSessions || s?.course !== COURSE) return send(res, 404, { error: 'unknown course' });
      if (!s || typeof s.id !== 'string') return send(res, 400, { error: 'bad session' });
      db.sessions.push(s);
      if (!db.updates.some((u) => u.id === s.id)) db.updates.unshift(toUpdate(s));
      if (s.progress && (!db.progress || s.progress.takenAt > db.progress.takenAt)) db.progress = s.progress;
      return send(res, 200, { ok: true });
    }
    if (route === 'PUT /api/player/progress') {
      const p = await readBody(req);
      if (!p || p.course !== COURSE) return send(res, 400, { error: 'bad snapshot' });
      if (!db.progress || p.takenAt > db.progress.takenAt) db.progress = p;
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: `no route ${route}` });
  } catch (err) {
    console.error(`[stub] ${route} failed`, err);
    return send(res, 500, { error: 'stub failed' });
  }
});

server.listen(PORT, 'localhost', () => console.log(`[stub] JS Journey stub on http://localhost:${PORT} (variant ${variant})`));
