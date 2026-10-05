# Course Player v3 — the study timer, real receipts, her plan (2026-10-05)

Supersedes the parts of `docs/spec-v2-coaching.md` and `docs/spec.md` it contradicts (the activity-based
session, the 20-min idle "waiting" dot, `pending` sessions, the 24 h auto-close, "Send without a note").
Contract: `shared/types.ts` (change it first). JS Journey side: section B (repo `~/Developer/js-journey`).
Design creed unchanged: **"Less, but better."** Warm to her, honest to him.

## Why (the incident, 2026-10-05)

Mansi studied ~30 min, clicked Sign off, saw no clear success, and Rahul got nothing.
- Root cause (high confidence): the course id is `slugify(<course folder name>)` (`server/scan.ts`
  `courseIdFor`). Her copy lives in a folder not named `React 2023`, so the id was not `react-2023`.
  JS Journey's prod logs show `GET /api/player/status` and `/feed` → **404 unknown course** at 08:32 UTC
  from a Mac that is not Rahul's. The session POST would 400 the same way, and the outbox **drops a 4xx'd
  item for good** (`server/journey.ts`). The card had already flashed "Sent ✓" for 650 ms — which only
  ever meant "the local server queued it".
- Second silent-loss path: with JS Journey not connected, `deliver()` returns 'skipped' and `signOff()`
  forgets the session; `resume()` also drops a stale live session when not connected.

v3 makes both impossible and gives her a real receipt.

## Rahul's decisions (2026-10-05, verbatim intent)

1. **Start studying** — a clear button when she opens the app (home) and in the header. It starts the
   study session.
2. **Wall-clock timer** — the session runs from Start to Sign off, whatever she does meanwhile (coding,
   GitHub, the player, nothing). No activity detection, no idle pause, no 24 h auto-send.
3. **Header** — while a session runs, a subtle running time ("● 1h 23m") in the header; on hover (and
   keyboard focus) it turns into the **Sign off** button.
4. **Sign-off card** — shows what the timer logged AND lets her edit the time (hours + minutes), max = the
   timer's time (and ≤ 24 h, JS Journey's per-update cap of 1440 min).
5. **One Send button** ("Send to Rahul"), with or without a note. "Send without a note" is gone.
   **Every update must reach Rahul** — nothing is ever dropped silently again.
6. **Clear success** — after Send she sees, unmistakably, that it was sent; the timer stops (header goes
   back to "Start studying") and she can start a new session any time (several a day is normal).
7. **Auto-start** — if she plays a lecture with no session running, the timer starts by itself and a
   small, quiet notice says so ("Study timer started").
8. **Her plan** — the full week-by-week plan (like the coach page's "Plan": each week's goal + Friday
   date, the Diwali break, "This week" marked) is easy to find in her app.
9. **JS course notes** — Rahul's notes from the finished JavaScript course stop filling "Your updates"
   (player + her `/m` page) and his notes list on `/r`; they live behind "JavaScript course history" on
   both web pages.
10. **Ship** after a green QA: commit both repos (branch `study-timer`), deploy to the SSD, merge + push
    JS Journey to main (Vercel deploys prod). Updating Mansi's own copy = copy the app files only, never
    her `.player/data`.

## A. Course Player

### A1. Course id never comes from the folder name
- The id is pinned in `.player/course.json` `{ "id": "react-2023" }`, written by `npm run deploy` (new
  `--course-id` option; default for the React launcher = `react-2023`). Server resolution order:
  `.player/course.json` → `config.json` `courseId` (optional field) → folder slug (last resort; log a loud
  `[scan]` warning that the id was guessed from the folder name).
- `.player/course.json` sits OUTSIDE `data/` so "copy the app files" (bin, web, course.json, launcher)
  carries it to her copy without touching her data. One small file (exFAT: fine).
- Connect (`POST /api/profiles/:p/journey`) already checks the link; it must also check the course: if JS
  Journey answers 404 unknown course, refuse with a clear message naming the id ("JS Journey doesn't know
  the course 'react-course' — this copy's course id is wrong; ask Rahul").
- Status/feed 404 for an unknown course must surface in the UI (menu shows "JS Journey: course not
  recognised" instead of "Connected"), never just a silent 204.

### A2. The outbox never drops an update
- A session (update) JS Journey rejects with a 4xx is **kept** in the outbox file as `rejected` (with the
  error and time), not deleted. Reads/progress may still be dropped on 4xx as today (they carry no words
  of hers; progress is superseded by the next snapshot anyway).
- Rejected updates are re-queued once on every server start (a fixed course id or a JS Journey fix makes
  them go through) and on demand from the UI ("Try again").
- **Not connected** = updates are accepted and kept in the outbox; they deliver as soon as she connects.
  No path discards an update because JS Journey is not connected.
- Per-update delivery state is readable: the outbox view (`GET /api/journey/:profile/outbox`) gains a
  list of recent updates with `state: 'queued' | 'delivered' | 'rejected'`, `error`, `at` (keep the last
  ~50 delivered receipts; all queued + rejected). Shape is the server agent's call — define it in
  `shared/types.ts` (`OutboxState`) and document it there. Keep `pending` + `lastError` for compatibility.
- Respect the existing failure-log rules in `CLAUDE.md` (202 before any JS Journey call; file lock never
  held across a request; local validation at least as strict as JS Journey's — `canSignOff` there is
  `minutes > 0 || note.trim() !== ''`, minutes ≤ 1440).

### A3. The study session (replaces the v2 activity session)
- One running session at most: `{ id (uuid), startedAt (epoch ms), autoStarted, lecturesCompleted,
  finishedSections, sectionSeconds }`. Persisted in localStorage under a NEW key (do not reuse the v2
  `…:session` shape). Survives reloads, closed tabs, a stopped server and app restarts: it keeps running
  until she signs off (or discards it).
- **Elapsed = now − startedAt** (wall clock). Nothing pauses it.
- `sectionNumber` of the update = the section she spent the most player time in during the session (the
  existing ticker may keep measuring *where* she is — it no longer decides *how long*); no player time →
  her current section (Continue), else last section (never 0 — see `lastSection()`).
- Lectures completed / sections finished during the session are recorded as in v2.
- Start: the "Start studying" button (home + header). Auto-start: playing a video lecture (or opening an
  article/PDF lecture) with no running session starts one (`autoStarted: true`) + a quiet transient notice.
- **Daily study time** (Today stat, streak, 30-day chart, `ProgressState.days`, snapshot `days`): credited
  at sign-off from the minutes she SENDS (her edited time), split across the calendar days the session
  spanned (proportional to the wall-clock time in each local day). While a session runs, the UI adds its
  live elapsed time to today (display only — not written to `days` until sign-off). The v2 ticker no
  longer writes `days` (that would double-count). Existing `days` data stays as is.
- **Legacy v2 state** (`…:session`, `…:pending`, `…:wrap` keys): on first open of v3, each legacy session
  with ≥ 1 min is sent once as-is (its recorded seconds, `autoClosed: true`, no note) — or, if that cannot
  be expressed cleanly, kept in the outbox like any other update — then the legacy keys are removed.
  Nothing is dropped silently.
- Discard: an accidental session can be discarded from the sign-off card (a quiet text action, confirm in
  place: "Discard 3m? · Yes, discard"). This is not a send button.

### A4. Header
- No session: a compact **Start studying** button (primary-ish but calm) where "Sign off" was.
- Session running: a subtle chip "● 1h 23m" (tabular numbers; "<1m" / "12m" / "1h 23m"; updates at
  least every 30 s, no per-second flicker needed). On hover AND on keyboard focus it reads **Sign off**
  (same width or smoothly sized — no layout jump of neighbours); click opens the sign-off card. Its
  accessible name always says both ("Sign off — studying for 1 h 23 min").
- No colour transitions on the state indicator (screenshots must catch it as it is; failure log).
- Menu keeps theme + JS Journey connect, and gains **Note to Rahul…** (the note-only update: no time,
  note required). Quit with a running session opens the sign-off card first ("Send & quit").

### A5. Sign-off card
- Top: "Timer: 1h 23m · started 9:14" (and the date if not today). Then **Time studied** — hours +
  minutes inputs prefilled with the timer (rounded down to the minute, capped at 24 h), max = timer;
  validation inline (never above the timer; a timer over 24 h says "longer than a day — set the real time").
  Review 2026-10-05: a timer over 24 h prefills NOTHING and Send waits until she types her real time — a
  prefilled "24h 0m" let one tap credit a whole day she never studied.
- Lectures completed (compact, "+N more" past 5), section — as in v2.
- Note (optional; placeholder as v2), 4 moods, "I'm stuck".
- **One primary button: "Send to Rahul"** ("Send & quit" when quitting). Disabled only when there is
  nothing to send (0 min and no note) with the reason shown.
- After Send the card becomes a **confirmation**, unmistakable, and stays until she closes it ("Done"):
  - delivered (JS Journey answered 2xx) → "Sent to Rahul ✓" + "1h 23m logged · note included";
  - still queued after a short wait (~8 s; offline / JS Journey slow) → "Saved ✓ — it will reach Rahul as
    soon as you're online" (honest, still calm, she has nothing to do);
  - rejected → stays on the form with the reason and "Try again" (her note is kept in the field).
  The confirmation must be readable without motion (reduced motion = instant) and must not be a
  sub-second flash.
- On Send the timer stops immediately (header → Start studying) — before delivery settles; the update is
  safe in the outbox.
- × / Escape / scrim = "not now": the session keeps running.

### A6. Her updates list shows delivery
- "Your updates" (home + `#/updates`): updates still in the outbox appear at the top marked "Waiting to
  send" (queued) or "Didn't reach Rahul — <reason> · Try again" (rejected). Delivered ones come from the
  JS Journey feed as today.

### A7. Her plan
- Home "This week" block gains a quiet **"See full plan"** toggle that expands (Collapse, ~220 ms, reduced
  motion = instant) the full plan: every week (Week N · goal · due Friday · state: done ✓ / this week /
  behind / upcoming / "keep going"), the Diwali break row in place. Same look family as the coach page's
  plan list, in the course player's tokens (`docs/design.md`).
- Data: `JourneyStatus.plan` (new, optional — section B). Absent (old cached status / old JS Journey) →
  the toggle is hidden. Works offline from the cached status.
- The Watch sidebar's section due date stays as is.

### A8. README + deploy
- `npm run deploy` writes `.player/course.json`. README gains **"Update Mansi's copy"**: replace
  `.player/bin`, `.player/web`, `.player/course.json` and the `🟢 Open React Course.command` launcher from
  the SSD; never touch `.player/data` (her link, progress, outbox). Plus how to read her outbox for
  stuck updates.

## B. JS Journey (`~/Developer/js-journey`, branch `study-timer`)

### B1. `GET /api/player/status` adds `plan`
- `plan: PlanRow[]` — exactly the coach page's rows (`lib/journey-view.ts` `planRows`, the
  `{ kind: 'week', week, due, goal, state } | { kind: 'break', label, start, end, now }` union). Mirror the
  type in course-player `shared/types.ts` `JourneyStatus.plan?` (optional there). Additive; no DB change.
  Keep the route fast (one extra query at most, ~200 ms target).

### B2. JS course notes leave the React views
- Standalone coach notes (`messages`: author coach, `log_entry_id` null) are not course-scoped. Scope them
  by time: notes created before the React course went live — boundary constant in the course registry
  (`lib/courses.ts`), `2026-10-02T00:00:00+05:30` unless the read-only check below shows a reason to move
  it — belong to the JS course.
  - Verify with a READ-ONLY count by day of standalone coach notes (dates + counts only, never bodies; via
    the app's own db module — `.env.local` is PRODUCTION; never print env values).
- Effects: the player feed (`notes`), her `/m` page ("Your updates" via `withNotes`, "From Rahul") and
  the coach's notes list on `/r` show only React-era notes. JS-era notes show on the JS history pages.
- `/r?course=js` (existing "JavaScript course history →") also lists his JS-era notes.
- `/m` gets the same quiet bottom link "JavaScript course history →" (`/m/<token>?course=js`): JS summary,
  her JS updates, his JS notes — read-only, collapsed out of the main page. It must NOT mark anything read.
- Unread logic stays correct: an unread JS-era note (if any) must not be lost — it shows on the JS history
  page; `unreadForStudent` must not count notes she can no longer see on the React pages (keep the two
  consistent; tests).

### B3. Gates
- `pnpm test`, `npx tsc --noEmit`, `pnpm lint`, `pnpm build` (the pre-commit build guard runs it too).
- Update `CLAUDE.md` (architecture map + failure log for the note boundary) and keep `lib/player.ts` the
  mirror of the player contract.
