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
| `text-4xl` | 36 / 40, −0.025em | "Who's studying?" |

## Space, size, radius

Tailwind's 4 px ladder only (4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96). More space between groups than
within them. Home column max 1100 px; reading column 68ch; Watch sidebar 360 px (≥1024 px only).
Radius: `rounded-md` 8 px (buttons, inputs, chips), `rounded-lg` 12 px (cards, player), `rounded-full`
(avatars' focus ring, pills, the session chip). Never square and rounded side by side.

## Elevation (role-based; dark mode leans on lighter surfaces, shadows only add a little)

| Token | Value (light) | Role |
|---|---|---|
| `shadow-e1` | `0 1px 2px ink/6%, 0 1px 3px ink/10%` | primary button, hero card |
| `shadow-e2` | `0 4px 8px ink/8%, 0 2px 4px ink/6%` | menus, popovers |
| `shadow-e3` | `0 16px 32px ink/14%, 0 4px 8px ink/6%` | dialogs (wrap-up, shortcuts) |

## Motion

150 ms for hover/press, 200 ms for menus and the player chrome, 250 ms for dialogs. One curve:
`--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`. Only `opacity` and `transform` animate. No bounce.
`prefers-reduced-motion: reduce` turns every transition/animation to ~0 ms. **No colour transitions on
state indicators** (done ticks, progress, the live dot) — screenshots catch them mid-fade.

## Components (one primary action per view)

- **Buttons** — `primary` (accent fill, `shadow-e1`), `secondary` (surface + line), `ghost` (ink-muted →
  fill on hover). Heights 32 / 40 / 48. Icons from `lucide-react`, stroke 1.5, sized to the text.
- **Focus** — `outline: 2px solid ring; outline-offset: 2px` on `:focus-visible` everywhere; inset
  (`-2px`) inside `.quiet-scroll` scrollers (see Traps).
- **Progress line** — 3 px track (`fill`), accent value, rounded ends; never animated.
- **Lecture status** — done: accent disc + ✓ (`on-accent`); partly watched: accent arc ring on a
  `line` circle; not started: `line` circle.
- **Avatars** — neutral `fill` tiles with the initial in `ink`; selection = accent ring. Nothing else
  is colourful.

## Screens

- **Who's studying?** — centred, 36 px question, 128 px tiles, names under.
- **Home** — header · Continue hero (the one primary action) · plan strip (Mansi) · 4 stats in a quiet
  row (no cards, hairline dividers) · 30-day bars · course content.
- **Watch** — player + details left, 360 px course-content sidebar right; `T` = theatre.
- **Player** — Netflix feel: dark, immersive, bottom gradient chrome that fades 2.5 s after the last
  move while playing, accent played-range, centre pulse on click.
- **30-day chart** — single series ⇒ no legend; bars ≤ 20 px wide with a 4 px rounded top, square at the
  baseline; today in `accent`, other days `chart-bar`; one 1 px `ink-subtle` average line labelled at
  its right end; per-bar hover/focus tooltip "Tue 29 Sep · 1h 12m"; a visually-hidden table carries
  every value.

## Traps (found in QA)

- Never put `hidden` in a className next to a component's own display utility (`inline-flex`): Tailwind's
  stylesheet order, not the class string, decides the winner. Use the `wideOnly` / `desktopOnly` props.
- The player clips its children (rounded video corners): any popover inside it must fit between its
  trigger and the player's top edge (see `SpeedMenu`), and dialogs are portaled to `<body>`, which is
  not visible while the player is fullscreen.
- Focusable rows inside a scroller need an inset outline: an outset ring on a full-width row falls outside
  it and `overflow` clips its sides (the Watch sidebar showed loose orange lines). `.quiet-scroll
  :focus-visible` insets it — give any new clipping scroller that class.
- "Subtle" text is still text: `ink-subtle` failed AA (3.2:1 on `fill`) when it was measured on canvas
  only. Check every text token on canvas, surface AND fill after any colour change.
