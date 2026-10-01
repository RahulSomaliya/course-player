# Course Player — spec

A local, offline course app for video courses on Rahul's SSD. First course: Jonas Schmedtmann's
*Ultimate React Course* at `/Volumes/Rahul's SSD/Courses/Coding FE/React 2023` (31 sections, 405 videos,
67.2 h, 4 article lectures, 1 PDF, ~45 link resources). Two learners share the SSD: **Rahul** and **Mansi**.
Mansi's sessions also flow into her study tracker **JS Journey** (`~/Developer/js-journey`).

Design creed: **"Less, but better"** (Dieter Rams). Every element must earn its place. One primary
action per view. Calm, quiet, precise. The video player feels like Netflix: immersive, dark, controls
that appear when needed and vanish when not.

## 1. How it runs (any Mac, no installs)

```
React 2023/
  🟢 Open React Course.command      <- the ONLY thing the user clicks
  01 Welcome, Welcome, Welcome!/ … 31 The End!/
  .player/                          <- hidden app folder (Finder hides dot-folders)
    bin/course-player-arm64         <- Node 22.19 single-executable app (SEA), Apple Silicon
    bin/course-player-x64           <- same, Intel
    web/                            <- built web app (index.html + a few assets)
    data/config.json                <- course title + profiles (+ Mansi's JS Journey link)
    data/progress-<profile>.json    <- durable copy of each profile's progress
    data/outbox-<profile>.json      <- JS Journey sessions not yet delivered
    data/durations.json             <- mp4 duration cache {relpath: {size, mtimeMs, duration}}
    rename-log.json                 <- undo log of the 2026-10-01 file clean-up (do not delete)
```

- The launcher is a bash `.command`: `cd "$(dirname "$0")"`; if `curl -fsS -m 1 http://localhost:8795/api/ping`
  answers `course-player`, just `open` the URL and exit; else pick the binary by `uname -m` and exec
  `"$BIN" --root "$PWD" --port 8795 --open`. It prints one friendly line ("React course is running at
  http://localhost:8795 — press Quit in the app or close this window to stop.") and, when the server
  exits, "Stopped. You can close this window.". `curl`, `open`, `uname`, bash exist on every Mac.
- exFAT: every new file gets a `._` AppleDouble sidecar and a 1 MiB cluster. Keep the deployed file
  count tiny (one JS + one CSS bundle, no font files, no per-video thumbnails). The scanner must ignore
  every name starting with `.` (this covers `._*`).
- The binaries are official Node v22.19.0 (`vendor/node-darwin-{arm64,x64}`, SHA-256 verified against
  nodejs.org SHASUMS256) with the bundled server injected via `postject`, then ad-hoc signed
  (`codesign --sign - --force`). Files on an external drive carry no quarantine flag, so Gatekeeper
  does not block them.

## 2. Server (`server/`, TypeScript, Node built-ins only)

Bundled by esbuild to ONE CommonJS file for SEA. Therefore: **no `import.meta.url`, no dynamic
`import()`, no native addons** in server code — derive paths from CLI args / `process.execPath`.

CLI: `course-player --root <courseDir> [--port 8795] [--open] [--data <dir>] [--web <dir>] [--version]`.
Defaults: `--data <root>/.player/data`; `--web`: `<dirname(execPath)>/../web` when running as SEA,
else `dist/web` (dev uses Vite on 5173 instead, see `vite.config.ts`).

Binds **127.0.0.1 only**. Port taken: if `/api/ping` on it answers course-player → print "already
running", open the browser, exit 0; else print a clear error, exit 1.

**Single origin rule.** localStorage is per origin, and `localhost:8795` ≠ `127.0.0.1:8795`. Any request
whose `Host` header is not exactly `localhost:<port>` gets a `308` to `http://localhost:<port><url>`.
Otherwise opening the app via 127.0.0.1 would show an empty progress history.

**CSRF rule.** Every non-GET `/api/*` request must carry header `x-course-player: 1` (custom header ⇒
a foreign website's request needs a CORS preflight, which we never answer). Missing → 403. Without
this any web page could POST `/api/quit`.

Routes:

| Route | Does |
|---|---|
| `GET /api/ping` | `{app:"course-player", version}` |
| `GET /api/boot` | `BootPayload` (awaits the initial scan) |
| `GET /api/progress/:profile` | stored `ProgressState`, or 204 |
| `PUT /api/progress/:profile` | body `ProgressState`; keep whichever of stored/body has the larger `updatedAt`; reply 200 with the winner |
| `PUT /api/profiles/:profile/journey` | body `{link}` = Mansi's student link `https://<host>/m/<token>`; validate by calling JS Journey status; save to config; reply `Profile` (400 on a bad link, 502 if JS Journey rejects it) |
| `DELETE /api/profiles/:profile/journey` | forget the link |
| `GET /api/journey/:profile/status` | proxy `GET <journeyUrl>/api/player/status?course=<course.id>` with `Authorization: Bearer <token>`, 5 s timeout → `JourneyStatus`; 204 if not connected / unreachable / non-2xx |
| `POST /api/journey/:profile/sessions` | validate a `JourneySession` (at least as strict as JS Journey: a 4xx there drops it); append to the outbox file; reply 202 `OutboxState` as soon as it is saved, then flush in the background (never await JS Journey before replying) |
| `GET /api/journey/:profile/outbox` | `OutboxState` |
| `POST /api/quit` | reply 202, flush outboxes (max 3 s), close, exit 0 |
| `GET /media/<path>` | stream a course file (below) |
| `GET /*` | static files from the web dir; unknown paths → `index.html`; `/assets/*` immutable cache, `index.html` no-cache |

The token never reaches the browser (`Profile.journeyConnected` is all the web app learns).

**Outbox → JS Journey.** `POST <journeyUrl>/api/player/sessions`, `Authorization: Bearer <token>`,
body `JourneySession`. 2xx → remove. 4xx → remove too and keep the message in `lastError` (a permanent
rejection must not retry forever). Network error → keep and stop the flush; 5xx → keep that item and the
rest of its kind, still deliver the other kinds (read receipts, snapshot). Retried on start-up, every
5 min, on each new item, and on quit. Dedup is JS Journey's job (by `session.id`), so retries are safe.

**Scanning** (`--root`): section folders match `^(\d{2}) (.+)$`. Suffix ` (Optional)` → `optional:true`
and is stripped from the title. `^Part (\d+) - (.+?)(?: \((\d+) Projects?\))?$` → `part`. Files match
`^(\d{2})(?:\.(\d+))? (.+)\.(mp4|html|pdf)$`:

- no sub-number → a **lecture**: `.mp4` video, `.html` article, `.pdf` pdf.
- `NN.M` → a **resource** of lecture NN. `.html` containing `window.location = "<url>"` → `{kind:'link', href:url}`;
  `.pdf` → `{kind:'pdf', href:'/media/…'}`; any other `.html` → `{kind:'link', href:'/media/…'}`.
  A resource whose lecture is missing attaches to the nearest earlier lecture (never dropped).
- Course title/subtitle come from `config.json` (`"The Ultimate React Course"`, `"Jonas Schmedtmann · 2023"`),
  falling back to the folder name. `course.id` = slug of the folder name (`react-2023`).

**Durations**: read the `mvhd` box inside the top-level `moov` box (seek box headers; never read `mdat`;
handle 64-bit box sizes and `mvhd` v0/v1). Cache in `durations.json` keyed by relpath and invalidated by
size + mtime. Cold SSD read of 405 files takes ~15 s, so the cache matters; compute misses with
concurrency 8 and print progress in the terminal.

**Media**: resolve `<path>` (URI-decoded per segment) under `--root`; reject anything that escapes the
root or has a segment starting with `.` (404). Range: `bytes=a-b`, `bytes=a-`, `bytes=-n` → 206 with
`Content-Range`; unsatisfiable → 416; no Range → 200. `Accept-Ranges: bytes`. Types: mp4 `video/mp4`,
pdf `application/pdf`, html `text/html; charset=utf-8`. Destroy the read stream when the client
aborts (seeking aborts constantly — leaking fds would exhaust the SSD handle table).

**Writes on exFAT** are atomic: write `<file>.tmp`, then `rename`.

**Logging**: one line per notable event to stdout, with context: `[scan] 405 videos, 67.2 h (12 cached misses)`,
`[media] 404 <relpath>`, `[journey] mansi: sent 1, 0 pending`, `[journey] mansi: HTTP 401 — <message>`.
Never log the token.

## 3. Web app (`web/`, React 19 + TypeScript strict + Tailwind v4)

Hash routes (tiny hand-rolled router): `#/` home, `#/watch/<encodeURIComponent(lectureId)>`, `#/who`.

### Profiles — "Who's studying?"
Netflix-style picker shown when this browser has no chosen profile (`localStorage["cp:profile"]`).
Large initial-letter avatars, names under. Choosing one goes home. Switch later from the avatar menu
in the header. The avatar menu also holds: theme (System / Light / Dark), and for any profile the
JS Journey row — "Connected" or "Connect JS Journey…" (paste link field, inline validation).

### Progress & storage
`localStorage["cp:<course.id>:<profile>:progress"]` holds `ProgressState` (primary, as Rahul asked).
On boot: GET the SSD copy; adopt whichever has the larger `updatedAt`. Every change: save to
localStorage immediately, PUT to the server debounced 2 s, and flush with `fetch(..., {keepalive:true})`
on `pagehide`. Result: progress follows the SSD to any Mac, and survives a cleared browser.
Wrap every localStorage access in try/catch (private windows throw) and keep working in memory.

### Study time (what "time spent" means)
A 1 s ticker (deltas from `performance.now()`, each tick capped at 5 s so a sleeping laptop never adds
hours) adds to `days[today]` while the learner is **studying**: a video is playing, OR an article/pdf
lecture is open with the tab visible and user input within the last 3 min. Local dates (`YYYY-MM-DD`
from the local clock), so a late-night session lands on the right day.

### Study sessions (all profiles; sent to JS Journey only when connected)
- A session starts with the first studied second and tracks: start/end, per-section studied seconds,
  lectures completed during it, sections that became 100% done.
- Persist the live session in localStorage (`cp:<course>:<profile>:session`) so a reload continues it.
- It ends when (a) the learner clicks the session chip → "End session", (b) Quit, or (c) 20 min pass
  with no studying. On app open, a stored session idle > 20 min is finalized silently.
- Sessions under 5 min are not sent (they still count in local stats).
- **Wrap-up card** (journey-connected profile, ends (a) and (b) only): "Nice work, Mansi" · duration ·
  lectures done · section; 4 mood buttons 😄 🙂 😐 😩; optional note; primary **Send**; quiet **Skip**
  (still sends, mood/note null). Idle end (c) sends silently. Then POST to the local server.
- The header shows a live session chip (`● 42m`) while a session is active — click → end session.

### Home `#/` (max-width ~1100 px, generous whitespace)
1. Header: course title (left); session chip, avatar menu, **Quit** (right).
2. **Continue** hero — the one primary action. Next lecture = last unfinished one you touched, else the
   first not-done lecture. Shows section + lecture title, a still frame of the video (a muted
   `<video preload="metadata" src="…#t=<pos>">` — no thumbnail files), a thin progress line, and
   **Resume 12:31** / **Start**. Empty state (fresh profile): "Start the course".
3. Plan strip — only for a journey-connected profile with a status: pace pill (Ahead / On track /
   Behind by N days), "Week 3 of 10 · Goal: finish §07 by Fri 16 Oct", latest coach note as a quote.
   During a plan break (`planBreak`, e.g. Diwali) say so warmly instead of a pace ("Diwali break · back on
   Mon 16 Nov"); show an upcoming break as a quiet line. Hidden on 204. Never blocks the page.
4. Stats — at most 4 numbers: **Today** (study time), **Streak** (consecutive days ≥ 5 min, ending today
   or yesterday), **Complete** (% of video duration done, with "n / 405 lectures"), **Left** (remaining
   video time + "finish ≈ 12 Dec" at the last-14-day content pace; "—" with no pace yet).
5. Last 30 days — bars of daily study minutes, today emphasised, hover/focus tooltip "Tue 29 Sep · 1h 12m",
   one light average line. Load the `dataviz` skill before writing it.
6. Course content — "31 sections · 405 lectures · 67h 10m". Part folders render as quiet group headings
   ("PART 1 · React Fundamentals · 4 projects") with their lectures beneath, not as ordinary sections.
   Section rows: number, title, Optional badge, slim progress bar, "7 / 24 · 2h 54m"; click to expand
   the lecture list (status: done ✓ / partly watched ring / not started), title, duration, resource count.
   The current section starts expanded.

### Watch `#/watch/<id>`
- Layout: player + details on the left; a "Course content" sidebar (~360 px) on the right with the
  current section open and the current lecture scrolled into view. `T` or a button hides the sidebar
  (theatre). Below 1024 px the sidebar moves under the details.
- Under the player: overline "Section 05 · Lecture 13", the title, then **Mark as done** toggle,
  Previous / Next, and resource chips (link ↗ opens a new tab; pdf opens in-app).
- Article lectures: the sanitized HTML (DOMPurify; links get `target=_blank rel=noopener`) in a reading
  column (65–75 ch), with Mark as done. PDF: full-height `<iframe>` viewer + "Open in new tab".
- Lectures auto-complete at ≥ 90 % watched or on `ended`.

### The player (Netflix feel)
- Click video = play/pause with a brief centre icon pulse; double-click = fullscreen (the player
  container, not the `<video>`, so custom controls stay).
- Bottom gradient bar, auto-hides 2.5 s after the last mouse move while playing (cursor hides too);
  always visible while paused. Top-left overlay in fullscreen: lecture title.
- Seek bar: buffered range, played range, hover grows the bar + time tooltip, drag to scrub, keyboard
  accessible (`role="slider"`).
- Buttons: play/pause, back 10 s, forward 10 s, volume (mute + slider on hover), current / total time,
  speed menu (0.5–2 in 0.25 steps; remembered), next lecture, picture-in-picture, fullscreen.
- Keys (ignored while typing in inputs): Space/K play-pause, ←/J −10 s, →/L +10 s, ↑/↓ volume, M mute,
  F fullscreen, Shift+N next, Shift+P previous, `<` / `>` speed, 0–9 jump to 0–90 %, T theatre, `?` shortcut sheet.
- Resume from saved `pos` when 10 s < pos < duration − 15 s. Save `pos` every 5 s and on pause/unload.
- End: "Up next" card with a 5 s ring countdown (Cancel / Play now); obeys `prefs.autoplay`.
- Remembers volume, mute, speed. Errors: "Can't read this video — is the SSD connected?" with Retry.

### Global states
- Boot fails → "The course isn't running. Double-click 🟢 Open React Course in the React 2023 folder."
- After Quit → "Stopped. You can close this tab."
- Loading → quiet skeletons, never spinners for > 300 ms content.

### Visual system
- Load `refactoring-ui` (and its `tailwind-react-playbook.md` + `reference-data.md`) and
  `frontend-design` before designing. Record the decisions in `docs/design.md` (tokens, type scale,
  spacing, elevation, motion) and stick to them.
- Theme tokens as CSS variables mapped through Tailwind v4 `@theme inline`; light + dark; default
  follows the OS, `prefs.theme` overrides via `data-theme` on `<html>`. **No hardcoded colours in
  components** (Rahul's standing rule). The player chrome has its own always-dark tokens.
- System font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`) — SF Pro
  on every Mac, zero font files. Tabular numbers for times.
- Tinted neutrals + ONE accent hue for the primary action, progress and "done". Nothing else is colourful.
- Motion 150–250 ms ease-out; honour `prefers-reduced-motion`. No `transition-colors` on state
  indicators (screenshots catch them mid-fade).
- Icons: `lucide-react`, 1.5 px stroke, sized to the text they sit with.
- WCAG AA contrast; visible focus rings; every icon button has an `aria-label`.

## 4. Tests (vitest; failing test first for each logic unit)

Server: name/section parsing (incl. Part + Optional + resources + orphan resources), scan of a temp
fixture tree, mp4 `mvhd` parsing (synthetic buffers: v0, v1, 64-bit size, moov-at-end), range parsing
+ 206/416 over a real server on port 0, path-traversal + dot-segment rejection, Host redirect, CSRF
header rule, progress LWW, atomic write, outbox (2xx removes, 4xx removes + lastError, 5xx keeps) with
a stub JS Journey server on port 0.

Web (pure modules, `// @vitest-environment jsdom` only where DOM is needed): stats (today, streak edge
cases across midnight/gaps, completion %, time left, ETA), study-time ticker (cap, visibility, idle),
session lifecycle (start, accumulate, idle end, < 5 min discard, finished sections), progress merge
(LWW), next-lecture selection, keyboard map.

## 5. Build & deploy

- `npm run build` → `tsc -b` + `vite build` → `dist/web`.
- `npm run build:sea` → `scripts/build-sea.sh`: esbuild `server/main.ts` → `dist/server.cjs`
  (`--platform=node --format=cjs --target=node22 --bundle`), `node --experimental-sea-config` blob
  (no snapshot / code cache — those are arch-specific), inject into copies of both vendor binaries
  (`codesign --remove-signature` → `postject … --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`
  → `codesign --sign - --force`), smoke-test `--version` on arm64 and via `arch -x86_64` on x64.
- `npm run deploy -- "<course root>"` → `scripts/deploy.sh`: copy `dist/bin/*` → `.player/bin/`,
  `dist/web` → `.player/web/` (`rsync -rt --delete --exclude '._*'`, no perms on exFAT), write the
  launcher `🟢 Open React Course.command` (chmod +x), and seed `data/config.json` only if absent.
  Never touches `data/` otherwise.

## 6. JS Journey side (separate repo, see its docs)

`GET /api/player/status?course=react-2023` → `JourneyStatus`; `POST /api/player/sessions` → store a
session (dedup on `id`). Both authenticate with the student token as a Bearer header. React plan:
start Mon 5 Oct 2026, 2.5 h/day × 5 days/week, multiplier 1.75 × watch time, section 04 (JS review)
excluded, every other section counted, plus a 15-day Diwali break (Sun 1 – Sun 15 Nov 2026) with no
study days.
