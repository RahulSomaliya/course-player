# Course Player — design system

Creed: **"Less, but better."** The accent is a nod to Rams' Braun: warm, paper-like neutrals and one
burnt-orange accent. Calm, quiet, precise. The data and the next lecture are the only loud things.
Every value below lives in `web/src/index.css` as a CSS variable mapped through Tailwind v4
`@theme inline`. **Components use token classes only** (`bg-surface`, `text-ink-muted`, `bg-accent`…);
a raw colour anywhere in `web/src/**/*.tsx` is a bug (it breaks the other theme).

## Colour tokens (OKLCH; text contrast measured on canvas / surface / fill — text sits on all three)

| Token | Light | Dark | Role |
|---|---|---|---|
| `canvas` | `0.985 0.004 80` | `0.17 0.006 70` | page background |
| `surface` | `0.995 0.002 80` | `0.21 0.007 70` | raised card (hero, menus' base) — dark: lighter = higher |
| `raised` | `0.995 0.002 80` | `0.25 0.008 70` | popovers, dialogs (dark: lighter still) |
| `fill` | `0.955 0.006 80` | `0.26 0.008 70` | hover wash, tracks, skeletons |
| `sunken` | `0.955 0.006 80` | `0.20 0.007 70` | a recessed panel inside a raised card (the sign-off summary). Dark: `fill` (0.26) on `raised` (0.25) vanished — recessed must be DARKER than its card |
| `control` | `0.995 0.002 80` | `0.36 0.008 70` | the selected segment of a segmented control (lighter than its track in both themes) |
| `line` | `0.90 0.008 80` | `0.30 0.008 70` | hairline dividers (low contrast on purpose) |
| `ink` | `0.22 0.01 70` (16.6:1) | `0.93 0.008 80` (15.6:1) | primary text |
| `ink-muted` | `0.45 0.012 70` (7.1 / 7.4 / 6.5:1) | `0.72 0.01 75` (7.7 / 7.1 / 6.3:1) | secondary text, icons |
| `ink-subtle` | `0.53 0.012 70` (5.1 / 5.2 / 4.6:1) | `0.64 0.01 75` (5.7 / 5.3 / 4.6:1) | tertiary TEXT: durations, numbers, axis ticks, stat hints — must stay AA on fill too |
| `accent` | `0.56 0.17 42` | `0.72 0.16 50` | THE accent: primary action, progress, done, today |
| `on-accent` | `0.99 0.005 80` (4.9:1) | `0.18 0.02 50` (7.2:1) | text/icons on an accent fill |
| `accent-ink` | `0.48 0.15 40` | `0.80 0.13 55` | accent-hued text (pace pill, links in articles) |
| `accent-soft` | `0.95 0.035 55` | `0.29 0.05 50` | tinted pill background |
| `chart-bar` | `0.66 0.012 70` (3.1:1) | `0.52 0.01 75` (3.2:1) | past-day bars (today = `accent`) |
| `ring` | = accent | = accent | focus ring |
| `scrim` | ink @ 40% | black-ish @ 60% | dialog backdrop |

**Player tokens are always dark** (`player`, `player-ink`, `player-ink-muted`, `player-track`,
`player-buffer`, `player-panel`, `player-scrim`, `player-accent` = dark accent). The video is the
light source; chrome never competes with it.

Errors are **not red**: calm `ink` text + an icon + plain words ("Can't read this video — is the SSD
connected?"). Status never relies on colour alone (done = ✓ icon + accent; partial = ring).

## Type (system stack — SF Pro on every Mac, zero font files)

`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`. Two weights: 400 and 600
(500 for buttons). Times and counters use `tabular-nums` when they sit in columns or tick live.

| Step | px / line-height | Use |
|---|---|---|
| `text-xs` | 12 / 16, +0.06em caps | overlines, part headings, chart ticks |
| `text-sm` | 14 / 20 | UI text, list rows, meta |
| `text-base` | 16 / 24 | body, buttons |
| `text-lg` | 18 / 28 | article body (reading column 68ch) |
| `text-xl` | 20 / 28 | section titles in dialogs |
| `text-2xl` | 24 / 30, −0.015em | lecture title on Watch, stat numbers |
| `text-3xl` | 30 / 36, −0.02em | hero lecture title |

Rahul's messages ("From Rahul") are `text-lg` at a 68ch measure: his words are the loudest text on home
after the Continue title, but never a wall of 130-character lines.

## Space, size, radius

Tailwind's 4 px ladder only (4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96). More space between groups than
within them. Home column max 1100 px; reading column 68ch; Watch sidebar 360 px (≥1024 px only).
Radius: `rounded-md` 8 px (buttons, inputs, chips), `rounded-lg` 12 px (cards, player), `rounded-full`
(pills, the Sign off button, dots). Never square and rounded side by side.

## Elevation (role-based; dark mode leans on lighter surfaces, shadows only add a little)

| Token | Value (light) | Role |
|---|---|---|
| `shadow-e1` | `0 1px 2px ink/6%, 0 1px 3px ink/10%` | primary button, hero card |
| `shadow-e2` | `0 4px 8px ink/8%, 0 2px 4px ink/6%` | menus, popovers |
| `shadow-e3` | `0 16px 32px ink/14%, 0 4px 8px ink/6%` | dialogs (sign-off card, shortcuts) |

## Motion (v2 — professional, quiet, purposeful)

Motion explains a change; it never decorates. Every moment below is OFF under
`prefers-reduced-motion: reduce` (index.css zeroes durations AND delays, and drops every
`::view-transition-*` animation; JS-driven motion asks `lib/motion.ts prefersReducedMotion()`).

Feedback holds are reading time, not motion: "✓ Got it" (220 ms) and the "Study timer started" notice
(4 s) stay under reduced motion — only the movement around them becomes instant. The sign-off
confirmation is not a hold at all: it stays until she presses Done (v3 — the v2 650 ms "Sent ✓" flash
read as success on a mere 202 while JS Journey refused the update, 2026-10-05).

**Curves.** Entrances: `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`. Exits: `--ease-in: cubic-bezier(0.4, 0,
1, 1)`, about 70 % of the entrance duration. No bounce, no spring overshoot anywhere.
**Durations.** 150 ms hover/press · 200 ms menus, player chrome, chevrons · 220 ms accordion · 250–300 ms
arrivals and dialogs · 340 ms the morph · ≤ 700 ms the first-paint count-up. Only `opacity`, `transform`
(+ `grid-template-rows` for the accordion, `stroke-dashoffset` for ticks) animate.
**Visible start rule.** Anything that can be on screen at first paint animates FROM a visible state
(`arrive` starts at 40 % opacity, bars at 25 % height, numbers at 0): a screenshot, a slow device or a
skipped animation never catches it hidden. Staggered keyframes use `backwards` fill so a delayed row
never flashes in its final state first. **No colour transitions on state indicators** (done ticks, the
study-timer chip and its dot, plan marks, progress) — screenshots catch them mid-fade.

| Moment | What moves | Spec | Where |
|---|---|---|---|
| Home → Watch | the Continue thumbnail morphs into the player | View Transitions API, `view-transition-name: lecture-media` on both; group 340 ms ease-out; the page fades THROUGH, never across: old out 90 ms ease-in, new in 160 ms ease-out from 70 ms (a 180 ms cross-fade layered both pages' titles); header (`app-header`) swaps instantly | `lib/motion.ts navigateWithMorph`, `ContinueHero`, `Player`, `index.css` |
| Section open / close | height 0fr ↔ 1fr, chevron turns 180° | `grid-template-rows` 220 ms; lecture rows `row-in` (opacity + 4 px rise, 220 ms) staggered 15 ms, capped at 12 rows; lectures mount only while open | `components/Collapse.tsx`, `LectureList` |
| Lecture / section becomes done | the ✓ draws in (disc scales in first) | `draw` 260 ms after 60 ms (`stroke-dashoffset` 1 → 0, `pathLength=1`); `disc-in` 180 ms — **only on the change, never on first render** | `ui.tsx LectureMark`, `QuietCheck` |
| First paint of home | Today / Streak / Complete count up; 30-day bars rise | WHEN EACH FIRST COMES INTO VIEW (≥ 40 % visible, `useSeenOnce`) — usually below the fold, so at mount they finished unseen; until then numbers show 0 and bars hold at 25 %. Count-up ≤ 700 ms ease-out-cubic from 0 (rAF; final value for screen readers); `bar-rise` 520 ms from 25 % height, 12 ms stagger. Once per page load, not on every return from Watch | `CountUp.tsx`, `Stats`, `ThirtyDays`, `HomeScreen`, `lib/motion.ts` |
| Continue thumbnail | the still frame settles in | transparent over the `player` box until decoded (`loadeddata`), then opacity 200 ms ease-out — no black box, then a pop | `ContinueHero` (`HeroFrame`) |
| "From Rahul" arrives / Got it | soft rise; ✓ morph, then the block fades while it folds | `arrive` 300 ms; Got it → check 220 ms → fade 150 ms ease-OUT + fold 220 ms ease-IN (it starts 25–40 ms after the hold), done ≈ 470 ms after the click (inside the 500 ms input window, so it adds no CLS — a longer fold for tall cards measured 490–498 ms: too close). Fast fade over a slow-starting fold is why no half-clipped text is ever seen (the reverse pairing showed it at 70 % opacity) | `FromRahul.tsx`, `Collapse` |
| Sign-off card | rises in; Send → "Sending…" → the confirmation, which stays until Done | `rise` 260 ms (opacity + 12 px + 0.985 scale); confirmation `arrive` 300 ms + its ✓ `check-in` 220 ms; close = scrim `fade-out` + card `leave` 180 ms. Busy = `aria-disabled` + no pointer events, never `disabled` (its 50 % look read as "undone"); `disabled` only for "nothing to send", with the reason under the button | `SignOffCard.tsx`, `Dialog.tsx` |
| Study timer started | the quiet notice under the header chip after an auto-start | `pop-in` 200 ms; shown for what is left of 4 s since the start (a remount neither repeats nor loses it) | `components/StudyTimer.tsx` |
| See full plan | her plan folds open under This week; the chevron turns | `Collapse` 220 ms; chevron 200 ms | `ThisWeek.tsx` |
| Watch sidebar ‹ › | the section's lecture list slides in from the side it came from | `step-next` / `step-prev` 220 ms (16 px + opacity from 30 %) | `SectionPanel.tsx` |
| Hover meta | a closed section's length / due date | opacity 150 ms; touch screens (`hover: none`) keep the chevron visible | `CourseContent.tsx` |

## Components (one primary action per view)

- **Buttons** — `primary` (accent fill, `shadow-e1`), `secondary` (surface + line), `ghost` (ink-muted →
  fill on hover). Heights 32 / 40 / 48. Icons from `lucide-react`, stroke 1.5, sized to the text.
- **Focus** — `outline: 2px solid ring; outline-offset: 2px` on `:focus-visible` everywhere; inset
  (`-2px`) inside `.quiet-scroll` scrollers (see Traps).
- **Progress line** — 3 px track (`fill`), accent value, rounded ends; never animated.
- **Lecture status** — done: accent disc + ✓ (`on-accent`); current: accent dot; plain: `line` circle.
  Three states only (v2 dropped the partly-watched arc).
- **Section row (closed)** — number (`ink-subtle`, tabular) · title · a quiet accent ✓ (no disc) when
  100 % done. Length and due date appear on hover/focus in one right-aligned column; the current section
  shows its due date always and a dot on its part's hairline; a skipped section (her plan, §04) is
  `ink-subtle` with "Skipped" — unless she finished it: finished wins (a ✓, never both). No progress
  bars, counts or "Optional" badges.
- **Part header** — overline "PART 1" (`text-xs` caps, `ink-muted`) · title (`text-lg` 600) · quiet
  "4 projects"; its sections nest under a 1 px `line` hairline, the part's intro lectures as a
  "Part introduction" row.
- **Study timer** (v3) — header: no session → "Start studying", a `rounded-full` secondary pill with an
  accent timer icon (on home also a secondary `lg` button beside Continue — Continue stays THE primary);
  running → a `rounded-full` chip "● 1h 23m" (static 8 px accent dot, tabular time, updates every 15 s)
  that reads "Sign off" on hover AND keyboard focus. Both labels share one grid cell, so the swap never
  moves its neighbours; its accessible name always says both ("Sign off — studying for 1 h 23 min").
- **Pills** — pace (`accent-soft` / `accent-ink`; behind = `fill` / `ink`), "Stuck" (same accent pill).

## Screens

- **Home** — header · **From Rahul** (only when something is unread: a raised `surface` card, overline in
  `accent-ink`, his words big, each reply led by her quoted note, one secondary "Got it") · Continue hero
  (THE primary action) · **This week** (week, goal + due, pace pill — the course due date is the Due stat's
  alone; on a break the break replaces the pace) · 4 stats in a quiet row (Today · Streak · Complete · **Due**, no cards,
  hairline dividers) · 30-day bars · **Your updates** (latest 3, replies threaded under a hairline, "See
  all"; a reply still unread is one quiet line "Rahul replied · above" — From Rahul shows it in full;
  updates still in the outbox on top: "Waiting to send" / "Didn't reach Rahul — reason · Try again")
  · course content. This week ends with a quiet "See full plan" (her plan, week by week, the break in
  place — the coach page's plan list in these tokens).
- **#/updates** — every update + replies in the same layout, "Show more" pages with the feed cursor.
- **Watch** — player + details left; the right sidebar (360 px) shows ONLY the current section: overline
  "SECTION 07", title, due date, ‹ › to step sections, lectures, and "Next: §08 …" at the bottom.
  `T` = theatre.
- **Sign-off card** — a dialog (max 512 px): "Nice work, Mansi"; a `sunken` panel with "**1h 23m** studied ·
  started 9:14 am" + a quiet "Edit time" right (opens h + m fields, prefilled unless the timer ran over 24 h,
  ≤ the timer, the reason inline in `ink` beside them only; "Use timer" closes them), then what the session
  recorded (lectures · section, up to 5 ✓ titles, "+N more"); the note (optional), 4 moods,
  "I'm stuck"; a quiet "Discard" (confirmed in place) left, ONE primary "Send to Rahul" / "Send & quit"
  right. After Send a confirmation in place: solid accent ✓ disc + "Sent to Rahul" (delivered) or a soft
  ✓ disc + "Saved" (still queued), and "Done". "Note to Rahul…" (menu) is the same card without time.
- **Player** — Netflix feel: dark, immersive, bottom gradient chrome that fades 2.5 s after the last
  move while playing, accent played-range, centre pulse on click.
- **30-day chart** — single series ⇒ no legend; bars ≤ 20 px wide with a 4 px rounded top, square at the
  baseline; today in `accent`, other days `chart-bar`; one 1 px `ink-subtle` average line labelled at
  its right end, in an 80 px gutter outside the plot (never over the bars); per-bar hover/focus tooltip
  "Tue 29 Sep · 1h 12m"; a visually-hidden table carries every value.

## Traps (found in QA)

- Never put `hidden` in a className next to a component's own display utility (`inline-flex`): Tailwind's
  stylesheet order, not the class string, decides the winner. Use the `wideOnly` / `desktopOnly` props.
- The player clips its children (rounded video corners): any popover inside it must fit between its
  trigger and the player's top edge (see `SpeedMenu`), and dialogs are portaled to `<body>`, which is
  not visible while the player is fullscreen.
- Focusable rows inside a scroller need an inset outline: an outset ring on a full-width row falls outside
  it and `overflow` clips its sides (the Watch sidebar showed loose orange lines). `.quiet-scroll
  :focus-visible` / `.inset-focus :focus-visible` inset it — give any new clipping box one of them
  (`Collapse` panels clip while they animate and carry `.inset-focus`).
- Only ONE element may carry `view-transition-name: lecture-media` at a time (the Continue thumbnail OR
  the player); two on one page and the browser skips the transition. Only the Continue links morph —
  any other route into Watch is a different lecture.
- A hover-revealed label must not change the position of always-visible text next to it: keep both in
  one right-aligned column (the section rows' "due …" / "Skipped" floated row to row before).
- `scrollIntoView({block:'start'})` puts the target UNDER the 56 px sticky header; QA scripts clicked the
  header instead of the section row. Scroll to `top − 72` or `block:'center'`.
- "Subtle" text is still text: `ink-subtle` failed AA (3.2:1 on `fill`) when it was measured on canvas
  only. Check every text token on canvas, surface AND fill after any colour change.
