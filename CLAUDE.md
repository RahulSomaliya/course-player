# Course Player

Local, offline video-course app that runs from Rahul's SSD on any Mac. Full spec: `docs/spec.md`.
Design decisions: `docs/design.md`. First course: `/Volumes/Rahul's SSD/Courses/Coding FE/React 2023`.

## Commands
- install: `npm install --cache <scratchpad>/npm-cache` (`~/.npm` is root-owned; new deps need `--before=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)` — see global CLAUDE.md)
- dev: `COURSE_ROOT="/Volumes/Rahul's SSD/Courses/Coding FE/React 2023" npm run dev:server` + `npm run dev:web` (Vite 5173 proxies to 8795)
- test: `npm test` (vitest) · typecheck: `npm run typecheck` · build web: `npm run build`
- single executables: `npm run build:sea` · ship to SSD: `npm run deploy -- "<course root>" [label] [--course-id <id>]`
  (writes `.player/course.json`; updating Mansi's own copy = README "Update Mansi's copy", never her `.player/data`)

## Structure
- `shared/types.ts` — the API contract; change it first, then both ends
- `server/` — Node built-ins only; bundled to one CJS file for Node SEA (no `import.meta.url`, no dynamic import)
- `web/` — React 19 + Tailwind v4 app (Vite root)
- `scripts/` — build-sea.sh, deploy.sh · `launcher/` — the `.command` template · `vendor/` — official Node binaries (gitignored, SHA-verified)

## Naming
- User-facing: "lecture" (not video/lesson), "section", "course content", "study time", "session", "Quit",
  "Start studying", "Sign off", "Send to Rahul", "update" (one sign-off), "Note to Rahul…".
- Clock times are 12 h, "9:14 am", always through `lib/format.ts` `formatTimeOfDay` (= JS Journey `fmtTime`) —
  Rahul: never 24 h (2026-10-05). Hand-built am/pm, never Intl's day-period text (ICU builds disagree).
- Code: `lectureId` = path relative to the course root.

## Architecture map
| Where is… | |
|---|---|
| course id (pinned, never the folder) | `server/course-id.ts` ← `<course>/.player/course.json` (deploy) → config `courseId` → folder slug + WARNING |
| course scan / name parsing | `server/scan.ts`, `server/names.ts` |
| mp4 duration | `server/mp4.ts` (+ `data/durations.json` cache) |
| media streaming + path guard | `server/media.ts` |
| progress LWW + atomic writes | `server/store.ts` |
| JS Journey proxy + outbox | `server/journey.ts` (contract: `~/Developer/js-journey/lib/player.ts`) |
| delivery state of her updates | `GET /api/journey/:p/outbox?wait=` → `OutboxState.updates` (queued / rejected / delivered); "Try again" = `POST …/outbox/retry`; wrappers in `web/src/lib/api.ts`; web: `state/journey.ts` `awaitDelivery` / `retry`, `lib/outbox.ts` |
| "course not recognised" | `JourneyProblem` — 409 from status + connect; `ApiError.problem` in the web |
| study timer (wall clock), Send, Discard, v2 → v3 migration | `web/src/state/study.ts` (+ `lib/session.ts`, `lib/legacy.ts`), `screens/SignOffCard.tsx`, `components/StudyTimer.tsx` (Start studying, chip, notice) |
| feed, Got it, snapshot push | `web/src/state/journey.ts`, `web/src/lib/feed.ts` |
| study time / stats | `ProgressState.days` written ONLY at sign-off (`lib/session.ts` `splitAcrossDays` → `lib/progress.ts` `withStudyDays`); running timer shown via `state/study.ts` `useStudyDays`; stats in `web/src/lib/stats.ts` |
| player | `web/src/player/` |

## Errors & logging
Server logs one context-rich line per event to stdout (`[scan]`, `[media]`, `[journey]`); never logs
the JS Journey token. Clients get a status code + short message. Web shows calm full-page states for
"server not running" and "stopped".

## Failure log
- localStorage is per ORIGIN: `localhost:8795` ≠ `127.0.0.1:8795`. The server 308s every other Host to
  `localhost:<port>`; never open the app via 127.0.0.1 in scripts/QA without expecting the redirect.
- The SSD is exFAT: each new file costs a 1 MiB cluster + a `._` sidecar. Keep deployed files few; the
  scanner ignores every dot-name (covers `._*`).
- Lecture ids are relative paths: renaming course files orphans their progress. The 2026-10-01 rename
  undo log lives at `<course>/.player/rename-log.json`.
- Never let the app write progress before hydrate has read the SSD copy: a child's mount effect runs
  before the parent's hydrate effect, and every change stamps `updatedAt = now`, so a cleared browser's
  empty copy beat and overwrote the SSD copy (2026-10-01). ProfileApp renders no screen until hydrate
  settles, and `ProgressStore.update` queues pre-hydrate changes (`web/src/state/progress.ts`).
- React sets object refs to null BEFORE useEffect cleanups run on unmount: capture `ref.current` when
  the effect runs (the Player's unmount position save never fired, 2026-10-01).
- An update's progress snapshot must come from the HYDRATED (SSD) copy: built from a cleared browser's
  empty copy it is "newest" on JS Journey and wipes the coach's numbers (2026-10-01). `migrateLegacy()`
  awaits `progress.hydrate()` itself; App renders no screen (so no Send) before hydrate.
- Study time = the WALL CLOCK from Start studying / auto-start to Send (spec v3): never pause it on idle,
  hidden tab or no lecture — v2's activity session under-counted her coding and its idle/24 h paths lost
  a sign-off (2026-10-05). `ProgressState.days` is credited ONLY at sign-off, from the minutes she sends,
  split over the days it spanned; the ticker (`lib/ticker.ts`) only picks the section — writing days there
  again double-counts. The timer stops only after the outbox's 202 (`StudyController.signOff`); a failed
  hand-over keeps the session and credits nothing.
- The study session key (`cp:<course>:<profile>:study`) is the ONE truth for every window of the app
  (2026-10-05 review): a 2nd launcher double-click opens a 2nd tab, each tab read the key once, and the
  stale tab re-sent a sent session — JS Journey answered "duplicate" (stored nothing) while the card said
  "Sent ✓ · note included". `StudyController` re-reads the key before every action (`adopt`), follows
  `storage` + `focus`, never writes over a session that ended elsewhere; `signOff`/`discard` take the id
  the card shows. The server refuses a CHANGED copy of a delivered id (409 `AlreadyDelivered`,
  `server/journey.ts` `updateSig`). `ProgressStore` has no such sync: two windows still overwrite each
  other's progress (last write wins).
- A component whose async action can outlive it must not schedule after unmount (the effect cleanup
  only clears timers that exist then) and must fire once-only callbacks once: the sign-off card's late
  timer reported a 2nd, completed outcome and App quit after "keep studying" (`SignOffCard.tsx`). The
  card's outcome carries `quit` itself; App never re-reads its own (stale) card state to decide.
- Never await JS Journey before a write route's 202, and never hold the outbox FILE lock across a
  request to it — a write queued behind a slow flush is the same slow 202 (`server/journey.ts`
  `locks` vs `flushLocks`). The first feed page waits (bounded) for deliveries in flight instead.
- Local validation must be at least as strict as JS Journey's (`~/Developer/js-journey/lib/player.ts`):
  a 4xx'd update sits as "Didn't reach Rahul" until a retry, and a 4xx'd read receipt / snapshot is
  dropped. Read ids are uuids, ≤ 500 per POST (the outbox batches); sectionNumber ≥ 1 (note-only falls
  back to her last section); minutes ≤ 1440. QA stub ids are uuids.
- Course.id NEVER comes from the folder name (2026-10-05): her copy's folder was not `React 2023`, so the
  id was not `react-2023`; JS Journey 404'd "unknown course", the outbox dropped her sign-off and the card
  had flashed "Sent ✓". It is pinned in `.player/course.json` (deploy `--course-id`; outside `data/` so
  copying the app files carries it) → config `courseId` → folder slug only with a loud `[scan] WARNING`
  (`server/course-id.ts`). Browser keys are `cp:<course.id>:…`: a changed id orphans this browser's
  pre-v3 keys — they sit under `BootPayload.folderCourseId`. "Unknown course" is a visible state
  (`JourneyProblem`, 409), never a silent 204; the match is on JS Journey's "unknown course" text.
- NEVER drop an update (her minutes + note): JS Journey 4xx → kept as `rejected` with the reason,
  re-queued once on every server start, on (re)connect and on "Try again"; not connected → accepted and
  kept, delivered on connect; every send uses the CURRENT course id (one queued under a guessed id would
  fail again after the fix). Only read receipts and snapshots may be dropped. A 202 means "in the local
  outbox", never "sent": "Sent ✓" needs a `delivered` entry in `OutboxState.updates` (`server/journey.ts`).
- Home motion below the fold must wait until it is seen (`useSeenOnce`), and the page transition fades
  through, never across — see the docs/design.md motion table before touching any timing.
- Feed and pace are MIRRORS of JS Journey (`lib/journey-view.ts`): "From Rahul" + the read queue + the
  server's `markRead` read `feed.unreadReplies` too (replies to updates older than page 1 — once never
  shown nor acknowledged); his notes sit in "Your updates" (`withNotes`: her web page marks a note read on
  sight, so it is lost here otherwise); the pace pill and the Due word come from `daysDelta` alone
  (`lib/week.ts` paceOf — a separate word map printed a bare "Behind"). Change both apps together.
- The streak counts STUDY days (`web/src/lib/stats.ts` `streak` = JS Journey `lib/stats.ts`, one test table): a
  calendar-day streak reset every weekend and all of Diwali (2026-10-01). It walks `JourneyStatus.studyWeekdays` +
  `planBreaks` (`studyCalendar`; a status cached before them is filled in `state/journey.ts`; no status → Mon–Fri);
  never call `streak` without the calendar, or a quiet Saturday reads as a missed day.
