# Course Player

Mansi's offline app for Jonas's React course. It runs from Rahul's SSD on any Mac, with nothing to
install. Her sign-offs go to Rahul's coach page in JS Journey (https://js-journey-ten.vercel.app).
Spec: `docs/spec.md` + `docs/spec-v2-coaching.md`. Developer notes: `CLAUDE.md`.

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
3. Click the menu icon next to **Sign off** → **Connect JS Journey…** → paste her link
   `https://js-journey-ten.vercel.app/m/<STUDENT_TOKEN>` (`STUDENT_TOKEN` is in the same `.env.local`).
   It shows **Connected**. This is saved on the SSD, so it works on any Mac.
4. Optional: send her the same `/m/…` link for her phone.

## Every day
- **Mansi:** open the app → read Rahul's feedback (Got it) → study → **Sign off** with a note → Quit.
- **Rahul:** open the `/r/…` link → read her unread updates → reply.

## Update the app on the SSD
`npm run build && npm run build:sea && npm run deploy -- "/Volumes/Rahul's SSD/Courses/Coding FE/React 2023"`
