# Course Player

Mansi's offline app for Jonas's React course. It runs from Rahul's SSD on any Mac, with nothing to
install. Her sign-offs go to Rahul's coach page in JS Journey (https://js-journey-ten.vercel.app).
Spec: `docs/spec.md` + `docs/spec-v2-coaching.md` + `docs/spec-v3-study-timer.md`. Developer notes: `CLAUDE.md`.

## Connect the two apps (once)

**Rahul — coach page**
1. Find the coach token: `COACH_TOKEN` in `~/Developer/js-journey/.env.local` (or Vercel → js-journey →
   Settings → Environment Variables). Keep it private.
2. Open `https://js-journey-ten.vercel.app/r/<COACH_TOKEN>` and bookmark it (also on your phone).
   Before Mon 5 Oct it says "Starts Mon 5 Oct"; her updates land there when she signs off.

**Mansi — course app**
1. Plug in the SSD. In Finder open `Rahul's SSD → Courses → Coding FE → React 2023`.
2. Double-click `🟢 Open React Course.command`. The course opens in the browser at
   `http://localhost:8795`. (If macOS ever refuses: right-click it → Open → Open.)
3. Click the settings icon (top right, next to **Start studying**) → **Connect JS Journey…** → paste her link
   `https://js-journey-ten.vercel.app/m/<STUDENT_TOKEN>` (`STUDENT_TOKEN` is in the same `.env.local`).
   It shows **Connected**. This is saved on the SSD, so it works on any Mac.
4. Optional: send her the same `/m/…` link for her phone.

## Every day
- **Mansi:** open the app → read Rahul's feedback (Got it) → **Start studying** (or just play a lecture —
  the timer starts itself) → when done, the timer in the header → **Sign off** → set the real time, a note →
  **Send to Rahul** → wait for "Sent to Rahul ✓" (or "Saved ✓" when offline) → Quit. Studied away from the
  player? Settings menu → **Note to Rahul…**.
- **Rahul:** open the `/r/…` link → read her unread updates → reply.

## Update the app on the SSD
`npm run build && npm run build:sea && npm run deploy -- "/Volumes/Rahul's SSD/Courses/Coding FE/React 2023"`

Deploy also writes `.player/course.json` — `{ "id": "react-2023" }`, the course JS Journey files her
updates under (`--course-id <id>` for any other course). The app reads the id from there, never from the
folder name: a copy in a folder not named `React 2023` once sent updates for a course JS Journey didn't
know, and they never reached Rahul (2026-10-05).

## Update Mansi's copy
Her Mac has its own copy of the course folder. Her link, progress and outbox (updates still to send) live
in its `.player/data` — **never copy, replace or delete `.player/data`**.

1. Deploy to the SSD (above). On her Mac, quit the app (Quit, or close its Terminal window).
2. From the SSD's `React 2023` folder, replace these in her course folder (Finder hides dot-folders —
   Cmd+Shift+. shows them):
   - `.player/bin`
   - `.player/web`
   - `.player/course.json`
   - `🟢 Open React Course.command`

   Or in Terminal on her Mac (set `HER` to her course folder):
   ```sh
   SSD="/Volumes/Rahul's SSD/Courses/Coding FE/React 2023"; HER="<her course folder>"
   rsync -rt --delete --exclude '._*' "$SSD/.player/bin/" "$HER/.player/bin/"
   rsync -rt --delete --exclude '._*' "$SSD/.player/web/" "$HER/.player/web/"
   cp "$SSD/.player/course.json" "$HER/.player/course.json"
   cp "$SSD/🟢 Open React Course.command" "$HER/"
   ```
3. Open the app. The Terminal window shows `[server] id: react-2023 (from course.json)`. Any update JS
   Journey refused earlier is sent again on every start.

### Stuck updates
An update is never thrown away: it is **queued** (not sent yet — offline, or not connected), **rejected**
(JS Journey refused it; the reason is kept) or **delivered**. To look, while the app runs on her Mac:
- `curl -s localhost:8795/api/journey/mansi/outbox` — `updates[]` with `state`, `error`, `at`.
- Send the rejected ones again: restart the app, or
  `curl -s -X POST -H 'x-course-player: 1' localhost:8795/api/journey/mansi/outbox/retry`.
- The file itself: `.player/data/outbox-mansi.json` (`items` = queued, `rejected` = refused + reason,
  `delivered` = the last 50 receipts). It holds no token — her link is in `config.json`; keep that private.
- "course not recognised" / `HTTP 400 — course "…" is not a JS Journey course`: her copy has a wrong
  course id — copy `.player/course.json` from the SSD (step 2), then restart.
