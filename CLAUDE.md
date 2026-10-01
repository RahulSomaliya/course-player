# Course Player

Local, offline video-course app that runs from Rahul's SSD on any Mac. Full spec: `docs/spec.md`.
Design decisions: `docs/design.md`. First course: `/Volumes/Rahul's SSD/Courses/Coding FE/React 2023`.

## Commands
- install: `npm install --cache <scratchpad>/npm-cache` (`~/.npm` is root-owned; new deps need `--before=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)` — see global CLAUDE.md)
- dev: `COURSE_ROOT="/Volumes/Rahul's SSD/Courses/Coding FE/React 2023" npm run dev:server` + `npm run dev:web` (Vite 5173 proxies to 8795)
- test: `npm test` (vitest) · typecheck: `npm run typecheck` · build web: `npm run build`
- single executables: `npm run build:sea` · ship to SSD: `npm run deploy -- "<course root>"`

## Structure
- `shared/types.ts` — the API contract; change it first, then both ends
- `server/` — Node built-ins only; bundled to one CJS file for Node SEA (no `import.meta.url`, no dynamic import)
- `web/` — React 19 + Tailwind v4 app (Vite root)
- `scripts/` — build-sea.sh, deploy.sh · `launcher/` — the `.command` template · `vendor/` — official Node binaries (gitignored, SHA-verified)

## Naming
- User-facing: "lecture" (not video/lesson), "section", "course content", "study time", "session", "Quit".
- Code: `lectureId` = path relative to the course root.

## Architecture map
| Where is… | |
|---|---|
| course scan / name parsing | `server/scan.ts`, `server/names.ts` |
| mp4 duration | `server/mp4.ts` (+ `data/durations.json` cache) |
| media streaming + path guard | `server/media.ts` |
| progress LWW + atomic writes | `server/store.ts` |
| JS Journey proxy + outbox | `server/journey.ts` (contract: `~/Developer/js-journey/lib/player.ts`) |
| sign-offs, pending sessions, 24 h rule | `web/src/state/study.ts`, `web/src/screens/SignOffCard.tsx` |
| feed, Got it, snapshot push | `web/src/state/journey.ts`, `web/src/lib/feed.ts` |
| study time / sessions / stats | `web/src/lib/` |
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
- The 24 h auto-close runs ONLY from App's hydrate `.then`, before the at-open card reads the queue —
  never from `resume()`: it ran pre-hydrate (snapshot from an empty browser copy) and the session stayed
  in `pending` while its POST flew, so the card asked for a note that was then dropped (2026-10-01).
  `autoClose()` takes sessions out of `pending` synchronously and skips ids the open card `hold()`s.
- A component whose async action can outlive it must not schedule after unmount (the effect cleanup
  only clears timers that exist then) and must fire once-only callbacks once: the sign-off card's late
  timer reported a 2nd, completed outcome and App quit after "keep studying" (`SignOffCard.tsx`).
- Never await JS Journey before a write route's 202, and never hold the outbox FILE lock across a
  request to it — a write queued behind a slow flush is the same slow 202 (`server/journey.ts`
  `locks` vs `flushLocks`). The first feed page waits (bounded) for deliveries in flight instead.
- Local validation must be at least as strict as JS Journey's (`~/Developer/js-journey/lib/player.ts`):
  the outbox drops a 4xx'd item for good. Read ids are uuids, ≤ 500 per POST (the outbox batches);
  sectionNumber ≥ 1 (note-only falls back to her last section); minutes ≤ 1440. QA stub ids are uuids.
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
