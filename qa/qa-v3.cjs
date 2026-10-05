#!/usr/bin/env node
// Headless-Chrome QA for Course Player v3 — the study timer (docs/spec-v3-study-timer.md) — plus the JS
// Journey pages it changed. Proves each spec point with a scripted pass/fail check and a screenshot.
//
//   node qa/qa-v3.cjs <group…>        groups: fresh flow quit over24 offline1 offline2 rejected auto plan
//                                     note unknown jj · servers (start) · stop · gallery
//
// Runs the app from THIS checkout (dist/web + tsx server/main.ts) against the SSD course READ-ONLY for
// media, with its data dir in the scratchpad (QA_SCRATCH) — never the SSD's .player/data — and JS Journey =
// qa/stub-journey.mjs on :8890. The JS Journey pages are static renders of the real /m and /r pages from
// fixtures (js-journey qa-out/v3/render.test.ts → $QA_SCRATCH/qa-v3/jj/*.html); never `next dev` (its
// .env.local is the PRODUCTION database) and never the production /m page (it marks notes read).
//
// Traps this script works around (global CLAUDE.md "Browser Automation"):
// - open the app as http://localhost:<port>: the server 308s 127.0.0.1, and localStorage is per origin;
// - never fullPage / captureBeyondViewport:true — the viewport is grown to the document height instead;
// - the theme is forced with emulateMediaFeatures (this Mac is dark: "light" shots came out dark), and the
//   body background is recorded per shot to prove light ≠ dark;
// - readiness = waitUntil 'load' + the app's own elements, never networkidle0; running animations and
//   transitions are waited out before every shot (document.getAnimations());
// - visibility = getBoundingClientRect + elementFromPoint, never a class check.
// Servers and the stub run detached (pid files in $QA_SCRATCH/qa-v3) so one group per call stays under the
// agent watchdog; `stop` kills them all.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const SCRATCH = process.env.QA_SCRATCH ?? '/private/tmp/claude-503/-Users-rahulsomaliya/f7e6e7c5-0f46-444d-bd16-2136616ac3e4/scratchpad';
const WORK = path.join(SCRATCH, 'qa-v3');
const OUT = path.join(REPO, 'qa', 'out', 'v3');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = "/Volumes/Rahul's SSD/Courses/Coding FE/React 2023";
const APP = { name: 'app', port: 8796, data: path.join(SCRATCH, 'qa-v3-data') };
const UNKNOWN = { name: 'unknown', port: 8797, data: path.join(SCRATCH, 'qa-v3-data-unknown') };
const STUB_PORT = 8890;
const STUB = `http://localhost:${STUB_PORT}`;
const STUDY_KEY = 'cp:react-2023:mansi:study';
const MIN = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// ---- processes ----------------------------------------------------------------------------------------

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}
function spawnDetached(name, cmd, args) {
  const log = fs.openSync(path.join(WORK, `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd: REPO, detached: true, stdio: ['ignore', log, log] });
  fs.writeFileSync(path.join(WORK, `${name}.pid`), String(child.pid));
  child.unref();
}
async function stopProc(name, url) {
  const file = path.join(WORK, `${name}.pid`);
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    try {
      process.kill(-pid, 'SIGTERM'); // the whole group (tsx → node)
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    fs.rmSync(file);
  }
  await waitFor(async () => !(await alive(url)), 15_000, `${name} to stop`);
}
const stubUp = () => alive(`${STUB}/__stub/state`);
async function startStub() {
  if (await stubUp()) return;
  spawnDetached('stub', process.execPath, ['qa/stub-journey.mjs', '--port', String(STUB_PORT)]);
  await waitFor(stubUp, 10_000, 'the stub');
}
const stopStub = () => stopProc('stub', `${STUB}/__stub/state`);
const appUrl = (a) => `http://localhost:${a.port}`;
async function startApp(a) {
  if (await alive(`${appUrl(a)}/api/ping`)) return;
  const tsx = path.join(REPO, 'node_modules', '.bin', 'tsx');
  spawnDetached(a.name, tsx, ['server/main.ts', '--root', ROOT, '--port', String(a.port), '--data', a.data, '--web', path.join(REPO, 'dist', 'web')]);
  await waitFor(() => alive(`${appUrl(a)}/api/ping`), 30_000, `app ${a.name}`);
}
async function stubGet(p) {
  return (await fetch(`${STUB}${p}`)).json();
}
async function stubPost(p, body) {
  return (await fetch(`${STUB}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
}

// ---- results ------------------------------------------------------------------------------------------

let results = null;
function begin(group) {
  results = { group, at: new Date().toISOString(), checks: [], shots: [] };
}
function save() {
  fs.writeFileSync(path.join(OUT, `results-${results.group}.json`), JSON.stringify(results, null, 2));
}
/** A scripted check. `shot` = the file name it is proven by (the gallery marks that shot fail if any fail). */
function check(name, pass, expected, got, shot) {
  results.checks.push({ name, pass: Boolean(pass), expected, got, shot: shot ?? null });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n      expected: ${expected}\n      got:      ${JSON.stringify(got)}`}`);
  return Boolean(pass);
}

// ---- browser ------------------------------------------------------------------------------------------

const VIEW = {
  1440: { width: 1440, height: 900, deviceScaleFactor: 1 },
  390: { width: 390, height: 844, deviceScaleFactor: 2 },
};

async function launch(profile, fresh) {
  const dir = path.join(WORK, 'chrome', profile);
  if (fresh) fs.rmSync(dir, { recursive: true, force: true });
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: dir,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
  });
}
async function newPage(browser, width, theme) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') page.errors.push(`${m.text()}${m.location()?.url ? ` @ ${m.location().url}` : ''}`);
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.setViewport(VIEW[width]);
  await setTheme(page, theme);
  return page;
}
async function setTheme(page, theme) {
  page.theme = theme;
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
}
async function setWidth(page, width) {
  await page.setViewport(VIEW[width]);
}
/** The app is ready: its header (not the loading frame) is up. */
async function appReady(page) {
  await page.waitForSelector('header [data-control="settings-menu"]', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('[data-state="loading"]'), { timeout: 10_000 });
}
async function open(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await appReady(page);
}
/** Waits out running CSS animations/transitions (finite ones) and font loading. */
async function settle(page, extra = 150) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () =>
        document.getAnimations().every((a) => {
          if (a.playState !== 'running') return true;
          const it = a.effect?.getTiming().iterations;
          return it === Infinity;
        }),
      { timeout: 4000, polling: 100 },
    )
    .catch(() => console.log('      (animations still running after 4 s — shooting anyway)'));
  await sleep(extra);
}
/** true when `sel` is rendered with a size and is the topmost element at its centre (after scrolling it in). */
async function onTop(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // a disabled ui Button is `pointer-events:none`, which hit-testing skips: test it as if clickable
    const pe = el.style.pointerEvents;
    el.style.pointerEvents = 'auto';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    el.style.pointerEvents = pe;
    return top !== null && (top === el || el.contains(top));
  }, sel);
}
async function text(page, sel) {
  return page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
}
async function clickSel(page, sel) {
  await page.waitForSelector(sel, { visible: true, timeout: 10_000 });
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
  await page.click(sel);
}
async function typeInto(page, sel, value) {
  // select the field's text the way a user would replace it (puppeteer's clickCount:3 did not select all:
  // "23" + "40" typed became "403")
  await page.click(sel);
  await page.$eval(sel, (e) => e.select());
  await page.keyboard.press('Backspace');
  if (value !== '') await page.keyboard.type(value);
}
async function scrollTop(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Screenshot + the per-screen checks every shot carries: console errors = 0 on this page so far, and at
 * 390 no horizontal scroll. mode 'viewport' (dialogs, header) · 'full' (viewport grown to the document) ·
 * selector (element shot, viewport grown first so nothing scrolls under the next click).
 */
async function shot(page, file, caption, { mode = 'viewport', selector = null, allowErrors = null } = {}) {
  const vp = page.viewport();
  const grow = mode === 'full' || selector !== null;
  if (mode === 'viewport' && selector === null) await scrollTop(page);
  if (grow) {
    await scrollTop(page);
    const h = await page.evaluate(() => Math.ceil(document.scrollingElement.scrollHeight));
    await page.setViewport({ ...vp, height: Math.max(vp.height, Math.min(h, 9000)) });
    await sleep(400);
  }
  await settle(page);
  const out = path.join(OUT, file);
  const meta = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    scrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (selector !== null) {
    const el = await page.$(selector);
    if (el === null) throw new Error(`shot ${file}: ${selector} not found`);
    await el.screenshot({ path: out, captureBeyondViewport: false });
  } else {
    await page.screenshot({ path: out, captureBeyondViewport: false });
  }
  if (grow) {
    await page.setViewport(vp);
    await sleep(200);
  }
  const errors = allowErrors ? page.errors.filter((e) => !allowErrors.test(e)) : page.errors;
  check(`${file}: console errors = 0`, errors.length === 0, '0 console errors', errors, file);
  if (vp.width === 390) check(`${file}: no horizontal scroll at 390`, meta.scrollWidth <= meta.innerWidth, `scrollWidth <= ${meta.innerWidth}`, meta.scrollWidth, file);
  results.shots.push({ file, caption, theme: page.theme, width: vp.width, bg: meta.bg, expectedErrors: allowErrors ? page.errors.filter((e) => allowErrors.test(e)) : [] });
  console.log(`      shot ${file} (${page.theme}, ${vp.width}, bg ${meta.bg})`);
  save();
}

// ---- study-session helpers ----------------------------------------------------------------------------

async function storedSession(page) {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw === null ? null : JSON.parse(raw);
  }, STUDY_KEY);
}
/** Puts 3 real §05 lectures (from /api/boot) and 50 min of §05 player time into the running session, then
 *  reloads — so the card's summary shows what a real session records (Rahul asked to see it, 2026-10-05). */
async function withLectures(page) {
  await page.evaluate(async (k) => {
    const boot = await (await fetch('/api/boot')).json();
    const sec = boot.course.sections.find((x) => x.number === 5);
    const s = JSON.parse(localStorage.getItem(k));
    s.lecturesCompleted = sec.lectures.slice(1, 4).map((l) => ({ section: 5, lecture: l.number, title: l.title }));
    s.sectionSeconds = { 5: 3000 };
    localStorage.setItem(k, JSON.stringify(s));
  }, STUDY_KEY);
  await page.reload({ waitUntil: 'load' });
  await appReady(page);
}
/** Every <time> on the page: 12 h ("9:05 pm") or a date — never a 24 h clock (Rahul, 2026-10-05). */
async function timesAre12h(page) {
  const times = await page.$$eval('time', (ts) => ts.map((t) => t.textContent.trim()));
  const bad = times.filter((t) => /\d{1,2}:\d{2}/.test(t) && !/\b\d{1,2}:\d{2} (am|pm)$/.test(t));
  return { times, bad, any12h: times.some((t) => /\d{1,2}:\d{2} (am|pm)$/.test(t)) };
}
/** Moves the running session's start back to `minutes` (+20 s) ago, then reloads — a long session. */
async function backdate(page, minutes) {
  await page.evaluate(
    (k, ms) => {
      const s = JSON.parse(localStorage.getItem(k));
      s.startedAt = Date.now() - ms;
      localStorage.setItem(k, JSON.stringify(s));
    },
    STUDY_KEY,
    minutes * MIN + 20_000,
  );
  await page.reload({ waitUntil: 'load' });
  await appReady(page);
}
const chipText = (page) => page.evaluate(() => document.querySelector('[data-control="sign-off"] [data-label="timer"]')?.textContent?.trim() ?? null);
async function sendButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /Send/.test(b.textContent ?? '')).map((b) => b.textContent.trim()));
}
async function openCardFromChip(page) {
  await clickSel(page, '[data-control="sign-off"]');
  await page.waitForSelector('[role="dialog"] [data-signoff]', { visible: true });
  await settle(page);
}
async function pickMood(page, label) {
  await page.click(`[role="dialog"] [role="radio"][aria-label="${label}"]`);
}
async function typeNote(page, note) {
  await page.click('[role="dialog"] textarea');
  await page.keyboard.type(note);
}
async function rect(page, sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } : null;
  }, sel);
}
async function labelVisibility(page) {
  return page.evaluate(() => {
    const v = (s) => {
      const el = document.querySelector(`[data-control="sign-off"] [data-label="${s}"]`);
      return el ? getComputedStyle(el).visibility : null;
    };
    return { timer: v('timer'), signOff: v('sign-off') };
  });
}

// ---- groups -------------------------------------------------------------------------------------------

const groups = {};

/** 1. Fresh home, no session: Start studying in the hero AND the header. */
groups.fresh = async () => {
  const b = await launch('main', true);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    await page.waitForSelector('[data-control="start-studying-hero"]');
    check('fresh home: no study session stored', (await storedSession(page)) === null, 'no session in localStorage', await storedSession(page));
    check('fresh home: "Start studying" in the header is visible on top', await onTop(page, 'header [data-control="start-studying"]'), 'visible', false, 'home-fresh-1440-light.png');
    check('fresh home: "Start studying" in the home hero is visible on top', await onTop(page, '[data-control="start-studying-hero"]'), 'visible', false, 'home-fresh-1440-light.png');
    await page.waitForFunction(() => document.querySelector('[data-morph="thumbnail"] video')?.dataset.ready === 'true', { timeout: 15_000 }).catch(() => console.log('      (hero frame not decoded in 15 s)'));
    const t12 = await timesAre12h(page);
    check('home: every time on the page is 12 h ("8:10 am"), none 24 h', t12.bad.length === 0 && t12.any12h, 'all h:mm am|pm', t12.times, 'home-fresh-1440-light.png');
    await shot(page, 'home-fresh-1440-light.png', 'First open, no session: "Start studying" sits in the header and next to Start in the hero', { mode: 'full' });
    await setTheme(page, 'dark');
    await setWidth(page, 390);
    await page.reload({ waitUntil: 'load' });
    await appReady(page);
    check('fresh home 390: header "Start studying" visible on top', await onTop(page, 'header [data-control="start-studying"]'), 'visible', false, 'home-fresh-390-dark.png');
    check('fresh home 390: hero "Start studying" visible on top', await onTop(page, '[data-control="start-studying-hero"]'), 'visible', false, 'home-fresh-390-dark.png');
    await page.waitForFunction(() => document.querySelector('[data-morph="thumbnail"] video')?.dataset.ready === 'true', { timeout: 15_000 }).catch(() => {});
    await shot(page, 'home-fresh-390-dark.png', 'Same at phone width, dark: both buttons fit, no sideways scroll', { mode: 'full' });
  } finally {
    await b.close();
  }
};

/** 2–5. Start → chip; 83 min → "1h 23m"; hover/focus = Sign off, neighbours still; the card; Send. */
groups.flow = async () => {
  await stubPost('/__stub/reset');
  const b = await launch('flow', true);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    // 2. Start studying → the chip
    await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]', { visible: true });
    const started = await storedSession(page);
    check('Start studying: a session is stored (autoStarted false)', started !== null && started.autoStarted === false, 'session with autoStarted:false', started);
    check('Start studying: the chip shows "<1m"', (await chipText(page)) === '<1m', '"<1m"', await chipText(page));
    check('Start studying: hero "Start studying" is gone while the timer runs', (await page.$('[data-control="start-studying-hero"]')) === null, 'no hero button', 'present');
    await backdate(page, 83);
    check('83 min session: the chip reads "1h 23m"', (await chipText(page)) === '1h 23m', '"1h 23m"', await chipText(page), 'chip-1h23m-1440-light.png');
    const aria = await page.$eval('[data-control="sign-off"]', (e) => e.getAttribute('aria-label'));
    check('chip accessible name says both', aria === 'Sign off — studying for 1 h 23 min', '"Sign off — studying for 1 h 23 min"', aria);
    await shot(page, 'chip-1h23m-1440-light.png', 'Timer running for 83 minutes: the header chip reads "● 1h 23m"', { selector: 'header' });

    // 3. hover → "Sign off", neighbours do not move; keyboard focus too
    const sels = { title: 'header a[href="#/"]', chip: '[data-control="sign-off"]', menu: '[data-control="settings-menu"]', quit: 'button[aria-label="Quit the course player"]' };
    const before = {};
    for (const [k, s] of Object.entries(sels)) before[k] = await rect(page, s);
    const visBefore = await labelVisibility(page);
    check('chip at rest: timer label visible, "Sign off" hidden', visBefore.timer === 'visible' && visBefore.signOff === 'hidden', 'timer visible, sign-off hidden', visBefore);
    await page.hover(sels.chip);
    await sleep(250);
    const visHover = await labelVisibility(page);
    check('hover: the chip reads "Sign off" (timer label hidden)', visHover.timer === 'hidden' && visHover.signOff === 'visible', 'timer hidden, sign-off visible', visHover, 'chip-hover-1440-light.png');
    const after = {};
    for (const [k, s] of Object.entries(sels)) after[k] = await rect(page, s);
    check('hover: the chip and its neighbours keep their boxes', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(before), after, 'chip-hover-1440-light.png');
    check('hover: the chip is the topmost element at its centre', await onTop(page, sels.chip), 'on top', false);
    await shot(page, 'chip-hover-1440-light.png', 'Hover: the same chip reads "Sign off" — same box, the title, menu and Quit do not move', { selector: 'header' });
    await page.mouse.move(700, 600);
    await sleep(200);
    // keyboard: Tab from the top of the page until the chip has focus
    await setTheme(page, 'dark');
    // start sequential focus at the course title (the element before the chip), like Tab from the top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.focus('header a[href="#/"]');
    let focused = false;
    for (let i = 0; i < 12 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.matches('[data-control="sign-off"]') ?? false);
    }
    const focusVis = await labelVisibility(page);
    const fv = await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);
    check('keyboard: Tab reaches the chip (focus-visible)', focused && fv, 'chip focused, :focus-visible', { focused, fv });
    check('keyboard focus: the chip reads "Sign off"', focusVis.signOff === 'visible' && focusVis.timer === 'hidden', 'sign-off visible', focusVis, 'chip-focus-1440-dark.png');
    await shot(page, 'chip-focus-1440-dark.png', 'Keyboard: Tab to the chip and it reads "Sign off" too (dark)', { selector: 'header' });
    await page.evaluate(() => document.activeElement?.blur());

    // 2b. the chip at 390, dark
    await setWidth(page, 390);
    await sleep(300);
    check('390: the chip is visible on top', await onTop(page, '[data-control="sign-off"]'), 'visible', false, 'chip-390-dark.png');
    await shot(page, 'chip-390-dark.png', 'The running chip at phone width, dark', { mode: 'viewport' });
    await setWidth(page, 1440);
    await setTheme(page, 'light');

    // 4. the sign-off card: the v2 summary first; the time is read-only until "Edit time" (Rahul, 2026-10-05)
    await withLectures(page);
    await openCardFromChip(page);
    const studied = await text(page, '[data-signoff="studied"]');
    const startedText = await text(page, '[data-signoff="started"]');
    check('card: "1h 23m studied · started h:mm am/pm" (12 h clock)', studied === '1h 23m' && /^started \d{1,2}:\d{2} (am|pm)$/.test(startedText ?? ''), '"1h 23m" + "started h:mm am|pm"', { studied, startedText }, 'card-summary-1440-light.png');
    const fieldsBefore = (await page.$('input[aria-label="Hours"]')) !== null;
    check('card: no time fields until she taps "Edit time"', !fieldsBefore && (await onTop(page, '[data-control="signoff-edit-time"]')), 'no fields; "Edit time" visible', { fieldsBefore }, 'card-summary-1440-light.png');
    const lectures = await page.$$eval('[role="dialog"] ul li', (ls) => ls.map((l) => l.textContent.trim()));
    const sectionLine = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] p')].map((p) => p.textContent.trim()).find((t) => /lectures done/.test(t)));
    check('card: the lectures she finished + the section are listed', lectures.length === 3 && /^3 lectures done · §05 /.test(sectionLine ?? ''), '3 titles, "3 lectures done · §05 …"', { lectures, sectionLine }, 'card-summary-1440-light.png');
    await shot(page, 'card-summary-1440-light.png', 'Sign-off card as she first sees it: "1h 23m studied · started …pm" (12 h), the lectures and section — the time is read-only, "Edit time" only if she wants', { mode: 'viewport' });
    await setTheme(page, 'dark');
    await setWidth(page, 390);
    await sleep(300);
    await scrollTopDialog(page);
    await shot(page, 'card-summary-390-dark.png', 'The same card at phone width, dark', { mode: 'viewport' });
    await setWidth(page, 1440);
    await setTheme(page, 'light');
    await clickSel(page, '[data-control="signoff-edit-time"]');
    await page.waitForSelector('input[aria-label="Hours"]', { visible: true });
    const hrs = await page.$eval('input[aria-label="Hours"]', (e) => e.value);
    const mins = await page.$eval('input[aria-label="Minutes"]', (e) => e.value);
    check('card: Time studied prefilled 1 h 23 m and editable', hrs === '1' && mins === '23' && !(await page.$eval('input[aria-label="Hours"]', (e) => e.disabled)), 'hours 1, minutes 23, enabled', { hrs, mins });
    await typeInto(page, 'input[aria-label="Minutes"]', '40');
    await sleep(150);
    const hint = await page.evaluate(() => document.querySelector('fieldset p[aria-live]')?.textContent?.trim());
    const primaryDisabled = await page.$eval('[data-control="signoff-primary"]', (e) => e.disabled);
    check('card: more than the timer → inline error', /more than the timer \(1h 23m\)/.test(hint ?? ''), '"That’s more than the timer (1h 23m)."', hint, 'card-over-timer-1440-light.png');
    check('card: more than the timer → Send is disabled', primaryDisabled === true, 'disabled', primaryDisabled, 'card-over-timer-1440-light.png');
    const times = await page.evaluate(() => (document.body.textContent ?? '').split('That’s more than the timer (1h 23m).').length - 1);
    check('card: the reason is printed ONCE (not again under Send)', times === 1, '1', times, 'card-over-timer-1440-light.png');
    const sends = await sendButtons(page);
    check('card: exactly ONE send button', sends.length === 1 && sends[0] === 'Send to Rahul', '["Send to Rahul"]', sends, 'card-over-timer-1440-light.png');
    const withoutNote = await page.evaluate(() => /Send without a note/i.test(document.body.textContent ?? ''));
    check('"Send without a note" does not exist anywhere', withoutNote === false, 'absent', withoutNote);
    await shot(page, 'card-over-timer-1440-light.png', 'After "Edit time": 1h 40m is more than the timer → the reason once, beside the fields; Send held; one Send button', { mode: 'viewport' });
    await setTheme(page, 'dark');
    await setWidth(page, 390);
    await sleep(300);
    check('card 390: Send button visible on top', await onTop(page, '[data-control="signoff-primary"]'), 'visible', false, 'card-over-timer-390-dark.png');
    await scrollTopDialog(page);
    await shot(page, 'card-over-timer-390-dark.png', 'The same card at phone width, dark', { mode: 'viewport' });
    await setWidth(page, 1440);

    // 5. Send (edited 1h 10m, a note, a mood)
    await typeInto(page, 'input[aria-label="Minutes"]', '10');
    const note = 'Finished §07 — derived state finally clicked. Still unsure when to lift state up vs keep it in the form; can we go over it on Friday?';
    await typeNote(page, note);
    await pickMood(page, 'Good');
    await page.click('[data-control="signoff-primary"]');
    const tSend = Date.now();
    await page.waitForFunction(() => document.querySelector('header [data-control="start-studying"]') !== null, { timeout: 5000 }).catch(() => {});
    const headerBack = await page.evaluate(() => document.querySelector('header [data-control="start-studying"]') !== null && document.querySelector('[data-control="sign-off"]') === null);
    await page.waitForSelector('[data-signoff-result]', { visible: true, timeout: 15_000 });
    const kind = await page.$eval('[data-signoff-result]', (e) => e.getAttribute('data-signoff-result'));
    await sleep(Math.max(0, 3000 - (Date.now() - tSend)));
    const still = await onTop(page, '[data-signoff-result] h2');
    const conf = await text(page, '[data-signoff-result]');
    check('Send: the result is "delivered"', kind === 'delivered', 'delivered', kind, 'sent-1440-dark.png');
    check('Send: "Sent to Rahul" still on screen 3 s after Send (not a flash)', still && /Sent to Rahul/.test(conf ?? ''), 'visible "Sent to Rahul" at t+3 s', { still, conf, ms: Date.now() - tSend }, 'sent-1440-dark.png');
    check('Send: says time logged + note included', /1h 10m logged · note included/i.test(conf ?? ''), '"1h 10m logged · note included"', conf, 'sent-1440-dark.png');
    check('Send: header is back to "Start studying"', headerBack, 'start-studying in header, no chip', headerBack);
    check('Send: no session left in localStorage', (await storedSession(page)) === null, 'null', await storedSession(page));
    const st = await stubGet('/__stub/state');
    const s0 = st.sessions[0];
    check(
      'stub received exactly ONE session with the edited minutes and the note',
      st.sessions.length === 1 && s0?.minutes === 70 && s0?.note === note && s0?.mood === '🙂',
      '1 session, minutes 70, the note, mood 🙂',
      st.sessions.map((s) => ({ minutes: s.minutes, note: s.note, mood: s.mood })),
    );
    await shot(page, 'sent-1440-dark.png', '3 s after Send: "Sent to Rahul ✓ · 1h 10m logged · note included" is still there; the header is back to Start studying', { mode: 'viewport' });
    await setTheme(page, 'light');
    await setWidth(page, 390);
    await sleep(300);
    await shot(page, 'sent-390-light.png', 'The confirmation at phone width, light — it stays until Done', { mode: 'viewport' });
    await setWidth(page, 1440);
    await clickSel(page, '[data-control="signoff-done"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
    // her update arrives in Your updates from the feed
    await page.waitForFunction((n) => document.querySelector('section[aria-labelledby="updates-title"]')?.textContent?.includes(n.slice(0, 40)), { timeout: 10_000 }, note).catch(() => {});
    const inFeed = await page.evaluate((n) => document.querySelector('section[aria-labelledby="updates-title"]')?.textContent?.includes(n.slice(0, 40)) ?? false, note);
    check('after Done: her update is listed in Your updates', inFeed, 'note text in Your updates', inFeed);
  } finally {
    await b.close();
  }
};

async function scrollTopDialog(page) {
  await page.evaluate(() => document.querySelector('[role="dialog"]')?.scrollTo(0, 0));
}

/** 11. Quit with a running timer → the card in "Send & quit" mode. */
groups.quit = async () => {
  const b = await launch('flow', false);
  try {
    const page = await newPage(b, 1440, 'dark');
    await open(page, `${appUrl(APP)}/#/`);
    if ((await storedSession(page)) === null) await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]');
    await backdate(page, 47);
    await clickSel(page, 'button[aria-label="Quit the course player"]');
    await page.waitForSelector('[role="dialog"] [data-signoff="session"]', { visible: true });
    const primary = await text(page, '[data-control="signoff-primary"]');
    const quietQuit = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].map((x) => x.textContent.trim()).filter((t) => /quit/i.test(t))); // case-insensitive: the primary is "Send & quit"
    check('Quit with a running timer: the card opens with "Send & quit"', primary === 'Send & quit', '"Send & quit"', primary, 'quit-1440-dark.png');
    check('Quit card: no quiet "Quit, keep timer" — "Send & quit" is the only Quit button', quietQuit.length === 1 && quietQuit[0] === 'Send & quit', '["Send & quit"]', quietQuit, 'quit-1440-dark.png');
    await shot(page, 'quit-1440-dark.png', 'Quit while the timer runs: the sign-off card opens first, primary "Send & quit"', { mode: 'viewport' });
    await page.click('[role="dialog"] button[aria-label="Not now — keep studying"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
    check('× = keep studying: the server is still running', await alive(`${appUrl(APP)}/api/ping`), 'ping ok', false);
    check('× = keep studying: the session keeps running', (await storedSession(page)) !== null, 'session kept', null);
  } finally {
    await b.close();
  }
};

/** 10. A timer over 24 h: nothing prefilled; it asks for the real time. */
groups.over24 = async () => {
  const b = await launch('flow', false);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    if ((await storedSession(page)) === null) await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]');
    await backdate(page, 26 * 60);
    check('26 h timer: chip reads "26h" (formatDuration drops "0m")', /^26h( 0m)?$/.test((await chipText(page)) ?? ''), '"26h"', await chipText(page));
    await openCardFromChip(page);
    const hrs = await page.$eval('input[aria-label="Hours"]', (e) => e.value);
    const mins = await page.$eval('input[aria-label="Minutes"]', (e) => e.value);
    const hint = await page.evaluate(() => document.querySelector('fieldset p[aria-live]')?.textContent?.trim());
    const disabled = await page.$eval('[data-control="signoff-primary"]', (e) => e.disabled);
    check('26 h: Time studied is NOT prefilled (no 24h)', hrs === '' && mins === '', 'both fields empty', { hrs, mins }, 'over24-1440-light.png');
    check('26 h: asks her to set the real time', /longer than a day — set the real time/.test(hint ?? ''), '"The timer ran longer than a day — set the real time."', hint, 'over24-1440-light.png');
    check('26 h: Send waits until she types a time', disabled === true, 'disabled', disabled, 'over24-1440-light.png');
    await shot(page, 'over24-1440-light.png', 'A timer left running 26 h: nothing prefilled, "set the real time", Send waits', { mode: 'viewport' });
    await typeInto(page, 'input[aria-label="Hours"]', '2');
    await sleep(150);
    const enabled = await page.$eval('[data-control="signoff-primary"]', (e) => !e.disabled);
    check('26 h: once she types 2h, Send is enabled', enabled, 'enabled', enabled);
    // leave no session behind for later groups: Discard → Yes, discard
    await page.click('[data-control="signoff-discard"]');
    await page.click('[data-control="signoff-discard-confirm"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
    check('Discard: no session left, header back to Start studying', (await storedSession(page)) === null && (await page.$('header [data-control="start-studying"]')) !== null, 'no session', await storedSession(page));
  } finally {
    await b.close();
  }
};

const QUEUED_SEL = 'section[aria-labelledby="updates-title"] [data-outbox="queued"]';
const REJECTED_SEL = 'section[aria-labelledby="updates-title"] [data-outbox="rejected"]';
const UPDATES_SEL = 'section[aria-labelledby="updates-title"]';

/** 6a. Offline: stub down → sign off → "Saved"; Your updates: waiting to send. Restarts the stub at the end. */
groups.offline1 = async () => {
  await stopStub();
  const b = await launch('offline', true);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]');
    await backdate(page, 52);
    await openCardFromChip(page);
    const note = 'Studied on the train with no internet — the useEffect cleanup section. Re-watched the race-condition lecture twice.';
    await typeNote(page, note);
    await pickMood(page, 'Okay');
    await page.click('[data-control="signoff-primary"]');
    await page.waitForSelector('[data-signoff-result]', { visible: true, timeout: 20_000 });
    const kind = await page.$eval('[data-signoff-result]', (e) => e.getAttribute('data-signoff-result'));
    const conf = await text(page, '[data-signoff-result]');
    check('offline Send: "Saved" confirmation', kind === 'saved' && /^Saved/.test(conf ?? ''), 'data-signoff-result=saved, "Saved"', { kind, conf }, 'offline-saved-1440-light.png');
    check('offline Send: says it will reach Rahul', /will reach Rahul as soon as you’re online/.test(conf ?? ''), '"It will reach Rahul as soon as you’re online."', conf, 'offline-saved-1440-light.png');
    check('offline Send: header back to Start studying', (await page.$('header [data-control="start-studying"]')) !== null, 'start-studying', null);
    // the app's own server is up; its JS Journey calls fail (stub down) — the browser logs no errors for that
    await shot(page, 'offline-saved-1440-light.png', 'JS Journey unreachable: Send says "Saved ✓ — it will reach Rahul as soon as you’re online"', { mode: 'viewport' });
    await clickSel(page, '[data-control="signoff-done"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
    await page.waitForSelector(QUEUED_SEL, { timeout: 10_000 }).catch(() => {});
    const row = await page.evaluate((s) => document.querySelector(s)?.closest('article')?.textContent?.replace(/\s+/g, ' ').trim() ?? null, QUEUED_SEL);
    check('Your updates: the update is listed as "Waiting to send" (on top)', row !== null && /Waiting to send/.test(row) && row.includes(note.slice(0, 30)), 'a waiting row with her note', row, 'offline-waiting-390-dark.png');
    const first = await page.evaluate((s) => {
      const sec = document.querySelector(s);
      const firstArticle = sec?.querySelector('article');
      return firstArticle?.querySelector('[data-outbox="queued"]') !== null;
    }, UPDATES_SEL);
    check('Your updates: the waiting row is the first item', first, 'first article holds data-outbox=queued', first);
    await setTheme(page, 'dark');
    await setWidth(page, 390);
    await sleep(300);
    check('390: the waiting row is visible on top', await onTop(page, QUEUED_SEL), 'visible', false, 'offline-waiting-390-dark.png');
    await shot(page, 'offline-waiting-390-dark.png', 'Your updates (phone, dark): her update on top, "Waiting to send"; the feed says it is the offline copy', { selector: UPDATES_SEL });
    const outbox = await (await fetch(`${appUrl(APP)}/api/journey/mansi/outbox`)).json();
    check('outbox: the update is queued (not dropped)', outbox.updates?.some((u) => u.state === 'queued' && u.session?.note === note), 'state queued with the note', outbox.updates?.map((u) => u.state));
    fs.writeFileSync(path.join(WORK, 'offline-note.txt'), note);
  } finally {
    await b.close();
  }
  await startStub(); // back online: the outbox's own retry (every 5 min, server/journey.ts) must deliver it
  fs.writeFileSync(path.join(WORK, 'offline-stub-restarted-at.txt'), new Date().toISOString());
  save();
};

/** 6b. After the stub came back: delivered with nothing for her to do, and the waiting row is gone. */
groups.offline2 = async () => {
  const note = fs.readFileSync(path.join(WORK, 'offline-note.txt'), 'utf8');
  const st = await stubGet('/__stub/state');
  const got = st.sessions.filter((s) => s.note === note);
  const restartedAt = fs.readFileSync(path.join(WORK, 'offline-stub-restarted-at.txt'), 'utf8');
  check('back online: the stub received the offline update once (outbox retry, no action from her)', got.length === 1, '1 session with the offline note', { count: got.length, restartedAt, now: new Date().toISOString() });
  const b = await launch('offline', false);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    await page.waitForFunction((n) => document.querySelector('section[aria-labelledby="updates-title"]')?.textContent?.includes(n.slice(0, 30)), { timeout: 10_000 }, note).catch(() => {});
    const waiting = await page.$(QUEUED_SEL);
    const listed = await page.evaluate((n) => document.querySelector('section[aria-labelledby="updates-title"]')?.textContent?.includes(n.slice(0, 30)) ?? false, note);
    check('after reload: no "Waiting to send" row', waiting === null, 'no data-outbox=queued', waiting === null ? null : 'present', 'offline-delivered-1440-light.png');
    check('after reload: the update now comes from JS Journey', listed, 'note in Your updates', listed, 'offline-delivered-1440-light.png');
    await shot(page, 'offline-delivered-1440-light.png', 'Back online: the outbox delivered it by itself; the waiting row is gone and her update is in the feed', { selector: UPDATES_SEL });
  } finally {
    await b.close();
  }
};

/** 7. JS Journey refuses the update → "Didn't reach Rahul" + Try again; delivered after the fix. */
groups.rejected = async () => {
  await startStub();
  await stubPost('/__stub/reject', { on: true });
  const b = await launch('rejected', true);
  try {
    const page = await newPage(b, 1440, 'dark');
    await open(page, `${appUrl(APP)}/#/`);
    // A — the card's Try again
    await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]');
    await backdate(page, 38);
    await openCardFromChip(page);
    const noteA = 'Custom hooks: extracted useLocalStorageState from the Usepopcorn app. Felt good!';
    await typeNote(page, noteA);
    await pickMood(page, 'Great');
    await page.click('[data-control="signoff-primary"]');
    await page.waitForFunction(() => /Didn’t reach Rahul/.test(document.querySelector('[data-signoff="error"]')?.textContent ?? ''), { timeout: 20_000 });
    const err = await text(page, '[data-signoff="error"]');
    const primary = await text(page, '[data-control="signoff-primary"]');
    const kept = await page.$eval('[role="dialog"] textarea', (e) => e.value);
    check('rejected: the card says "Didn’t reach Rahul" with the reason', /Didn’t reach Rahul — unknown course \(HTTP 404\)/.test(err ?? ''), '"Didn’t reach Rahul — unknown course (HTTP 404)"', err, 'rejected-card-1440-dark.png');
    check('rejected: the button is "Try again"', primary === 'Try again', '"Try again"', primary, 'rejected-card-1440-dark.png');
    check('rejected: her note is still in the field', kept === noteA, 'the note', kept, 'rejected-card-1440-dark.png');
    check('rejected: no "Sent" anywhere on the card', !(await page.$('[data-signoff-result]')), 'no confirmation', null);
    await shot(page, 'rejected-card-1440-dark.png', 'JS Journey refuses it: the card stays, "Didn’t reach Rahul — unknown course (HTTP 404)", her note kept, Try again', { mode: 'viewport' });
    await stubPost('/__stub/reject', { on: false });
    await page.click('[data-control="signoff-primary"]');
    await page.waitForSelector('[data-signoff-result]', { visible: true, timeout: 15_000 });
    const kindA = await page.$eval('[data-signoff-result]', (e) => e.getAttribute('data-signoff-result'));
    check('card Try again after the fix → "Sent to Rahul"', kindA === 'delivered', 'delivered', kindA);
    await clickSel(page, '[data-control="signoff-done"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });

    // B — closed after the refusal: Your updates holds it with Try again
    await stubPost('/__stub/reject', { on: true });
    await clickSel(page, 'header [data-control="start-studying"]');
    await page.waitForSelector('[data-control="sign-off"]');
    await backdate(page, 25);
    await openCardFromChip(page);
    const noteB = 'Refs vs state: useRef for the input focus, not useState. Question: why does the ref not re-render?';
    await typeNote(page, noteB);
    await page.click('[data-control="signoff-primary"]');
    await page.waitForFunction(() => /Didn’t reach Rahul/.test(document.querySelector('[data-signoff="error"]')?.textContent ?? ''), { timeout: 20_000 });
    await page.click('[role="dialog"] button[aria-label="Not now"]');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
    await page.waitForSelector(REJECTED_SEL, { timeout: 10_000 }).catch(() => {});
    const rowB = await page.evaluate((s) => document.querySelector(s)?.closest('article')?.textContent?.replace(/\s+/g, ' ').trim() ?? null, REJECTED_SEL);
    check('Your updates: the refused update is listed with the reason + Try again', rowB !== null && /Didn’t reach Rahul — unknown course \(HTTP 404\) · Try again/.test(rowB) && rowB.includes(noteB.slice(0, 30)), 'row with reason, Try again and her note', rowB, 'rejected-row-390-light.png');
    await setTheme(page, 'light');
    await setWidth(page, 390);
    await sleep(300);
    check('390: the Try again link is visible on top', await onTop(page, `${REJECTED_SEL} button`), 'visible', false, 'rejected-row-390-light.png');
    await shot(page, 'rejected-row-390-light.png', 'Closed after the refusal: Your updates keeps it — "Didn’t reach Rahul — unknown course · Try again" (phone, light)', { selector: UPDATES_SEL });
    await setWidth(page, 1440);
    await stubPost('/__stub/reject', { on: false });
    await clickSel(page, `${REJECTED_SEL} button`);
    await page.waitForFunction((s) => !document.querySelector(s), { timeout: 15_000 }, REJECTED_SEL).catch(() => {});
    const gone = (await page.$(REJECTED_SEL)) === null;
    const st = await stubGet('/__stub/state');
    const deliveredB = st.sessions.filter((s) => s.note === noteB).length;
    const deliveredA = st.sessions.filter((s) => s.note === noteA).length;
    check('Your updates Try again after the fix: delivered once (stub) and the row is gone', gone && deliveredB === 1, 'row gone, 1 session with note B', { gone, deliveredB });
    check('card Try again: delivered once (stub)', deliveredA === 1, '1 session with note A', deliveredA);
    await page.waitForFunction((n) => document.querySelector('section[aria-labelledby="updates-title"]')?.textContent?.includes(n.slice(0, 30)), { timeout: 10_000 }, noteB).catch(() => {});
    await shot(page, 'rejected-retried-1440-light.png', 'Try again after the fix: delivered — the refused row is gone and both updates are in the feed', { selector: UPDATES_SEL });
  } finally {
    await b.close();
  }
};

/** 8. Auto-start: play a lecture with no session → the quiet notice + the chip. */
groups.auto = async () => {
  const b = await launch('auto', true);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    check('auto: no session before playing', (await storedSession(page)) === null, 'null', await storedSession(page));
    await clickSel(page, '[data-control="continue"]');
    await page.waitForSelector('[data-player]', { timeout: 15_000 });
    // the click is a user gesture: the player starts; if the browser held it, press Play like she would
    const playing = await page.waitForFunction(() => document.querySelector('[data-player][data-state="playing"]') !== null, { timeout: 8000 }).then(
      () => true,
      () => false,
    );
    if (!playing) {
      await page.click('[aria-label="Play"]').catch(() => {});
      await page.waitForSelector('[data-state="playing"]', { timeout: 10_000 });
    }
    await page.waitForSelector('[data-notice="timer-started"]', { visible: true, timeout: 5000 });
    // Home → Watch is a View Transition (lib/motion.ts): while it runs, hit-testing lands on the
    // transition root, not the page — let it finish (it is well inside the notice's 4 s)
    const hitBefore = await page.evaluate(() => {
      const r = document.querySelector('[data-control="sign-off"]')?.getBoundingClientRect();
      return r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.tagName ?? null : null;
    });
    console.log(`      hit-test at the chip before the transition settled: ${hitBefore}`);
    await settle(page, 50);
    const notice = await text(page, '[data-notice="timer-started"]');
    const s = await storedSession(page);
    check('auto: playing a lecture starts a session (autoStarted true)', s !== null && s.autoStarted === true, 'autoStarted: true', s);
    check('auto: the quiet notice "Study timer started"', notice === 'Study timer started' && (await onTop(page, '[data-notice="timer-started"]')), 'visible "Study timer started"', notice, 'autostart-1440-light.png');
    check('auto: the chip is there', await onTop(page, '[data-control="sign-off"]'), 'chip visible', false, 'autostart-1440-light.png');
    // the notice lasts 4 s: shoot it now (animations settle within it)
    await shot(page, 'autostart-1440-light.png', 'Playing a lecture with no session: the timer starts itself — "Study timer started" under the chip', { mode: 'viewport' });
    await sleep(4200);
    check('auto: the notice goes away by itself (4 s)', (await page.$('[data-notice="timer-started"]')) === null, 'gone', 'still shown');
    await page.evaluate(() => document.querySelector('video')?.pause());
  } finally {
    await b.close();
  }
};

/** 9. This week → See full plan. */
groups.plan = async () => {
  await startStub();
  const b = await launch('plan', true);
  try {
    for (const [width, theme] of [
      [1440, 'light'],
      [390, 'dark'],
    ]) {
      const page = await newPage(b, width, theme);
      await open(page, `${appUrl(APP)}/#/`);
      await clickSel(page, '[data-control="full-plan"]');
      await page.waitForSelector('[data-plan]', { visible: true });
      await sleep(400);
      const rows = await page.$$eval('[data-plan] > li', (lis) => lis.map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
      const weeks = rows.filter((r) => /^Week \d+/.test(r));
      const breakRow = rows.find((r) => /Diwali/.test(r));
      const thisWeek = rows.filter((r) => /This week/.test(r));
      const file = `plan-${width}-${theme}.png`;
      check(`plan ${width}: 10 weeks listed with Friday dates`, weeks.length === 10 && weeks.every((w) => /Fri \d{1,2} (Oct|Nov|Dec)/.test(w)), '10 rows "Week N … Fri d Mon"', weeks, file);
      check(`plan ${width}: the Diwali break row sits between week 4 and week 5`, breakRow !== undefined && rows.indexOf(breakRow) === rows.findIndex((r) => /^Week 5/.test(r)) - 1, 'break row right before Week 5', rows.map((r) => r.slice(0, 24)), file);
      check(`plan ${width}: exactly one week marked "This week" (week 1)`, thisWeek.length === 1 && /^Week 1/.test(thisWeek[0]), 'Week 1 · This week', thisWeek, file);
      const expanded = await page.$eval('[data-control="full-plan"]', (e) => e.getAttribute('aria-expanded'));
      check(`plan ${width}: toggle says expanded`, expanded === 'true', 'aria-expanded=true', expanded);
      await shot(page, file, width === 1440 ? 'This week → "See full plan": every week with its goal and Friday, the Diwali break in place, this week marked' : 'The full plan at phone width, dark', { selector: 'section[aria-labelledby="week-title"]' });
      await page.close();
    }
  } finally {
    await b.close();
  }
};

/** 13. Note to Rahul… from the menu → a note-only card (no time); Send works. */
groups.note = async () => {
  await startStub();
  const b = await launch('note', true);
  try {
    const page = await newPage(b, 390, 'light');
    await open(page, `${appUrl(APP)}/#/`);
    await clickSel(page, '[data-control="settings-menu"]');
    await clickSel(page, '[data-control="note-to-rahul"]');
    await page.waitForSelector('[role="dialog"] [data-signoff="note"]', { visible: true });
    const timeFields = await page.$$('[role="dialog"] input[aria-label="Hours"], [role="dialog"] input[aria-label="Minutes"]');
    const reason = await text(page, '[data-signoff="reason"]');
    const disabled = await page.$eval('[data-control="signoff-primary"]', (e) => e.disabled);
    check('note card: no time fields', timeFields.length === 0, '0 time inputs', timeFields.length, 'note-card-390-light.png');
    check('note card: Send waits for a note (reason shown)', disabled && reason === 'Write a note for Rahul.', 'disabled + "Write a note for Rahul."', { disabled, reason });
    const note = 'Read the React docs on "You Might Not Need an Effect" on my phone during lunch — 3 of the examples were exactly my bugs.';
    await typeNote(page, note);
    check('note card: one send button', (await sendButtons(page)).length === 1, '1', await sendButtons(page), 'note-card-390-light.png');
    await shot(page, 'note-card-390-light.png', 'Settings → "Note to Rahul…": a note-only card, no time (phone, light)', { mode: 'viewport' });
    await setWidth(page, 1440);
    await setTheme(page, 'dark');
    await page.click('[data-control="signoff-primary"]');
    await page.waitForSelector('[data-signoff-result]', { visible: true, timeout: 15_000 });
    const conf = await text(page, '[data-signoff-result]');
    const st = await stubGet('/__stub/state');
    const s = st.sessions.find((x) => x.note === note);
    check('note: "Sent to Rahul · Note included"', /Sent to Rahul/.test(conf ?? '') && /Note included/.test(conf ?? ''), '"Sent to Rahul … Note included"', conf, 'note-sent-1440-dark.png');
    check('note: the stub got it with 0 minutes', s !== undefined && s.minutes === 0, 'minutes 0 + the note', s ? { minutes: s.minutes, note: s.note } : null);
    check('note: no study timer was started', (await storedSession(page)) === null, 'null', await storedSession(page));
    await shot(page, 'note-sent-1440-dark.png', 'The note is sent: "Sent to Rahul ✓ · Note included" (no time logged)', { mode: 'viewport' });
  } finally {
    await b.close();
  }
};

/** 12. A course id JS Journey does not know → the menu says so, never "Connected". */
groups.unknown = async () => {
  await startStub();
  await startApp(UNKNOWN);
  const b = await launch('unknown', true);
  try {
    const page = await newPage(b, 1440, 'light');
    await open(page, `${appUrl(UNKNOWN)}/#/`);
    await sleep(800);
    await clickSel(page, '[data-control="settings-menu"]');
    await page.waitForSelector('[data-journey="course-not-recognised"]', { visible: true, timeout: 10_000 }).catch(() => {});
    const row = await page.evaluate(() => document.querySelector('[data-journey="course-not-recognised"]')?.parentElement?.parentElement?.parentElement?.textContent?.replace(/\s+/g, ' ').trim() ?? null);
    const connected = await page.evaluate(() => [...document.querySelectorAll('p')].some((p) => p.textContent.trim() === 'Connected'));
    check('unknown course: the menu shows "Course not recognised"', await onTop(page, '[data-journey="course-not-recognised"]'), 'visible', row, 'unknown-course-1440-light.png');
    check('unknown course: the menu does not say "Connected"', connected === false, 'no "Connected"', connected, 'unknown-course-1440-light.png');
    check('unknown course: the reason names the id', /react-course/.test(row ?? ''), 'mentions "react-course"', row, 'unknown-course-1440-light.png');
    // the status route answers 409 by design (the "course not recognised" state): Chrome logs that response
    await shot(page, 'unknown-course-1440-light.png', 'A copy whose course id JS Journey does not know: the menu says "Course not recognised" and why — not "Connected"', {
      mode: 'viewport',
      allowErrors: /status of 409 \(Conflict\)/,
    });
  } finally {
    await b.close();
    await stopProc(UNKNOWN.name, `${appUrl(UNKNOWN)}/api/ping`);
  }
};

/** 14. JS Journey pages (static renders from fixtures). */
const JS_NOTES = ['Closures took you', 'JavaScript: done', 'Rest this weekend'];
groups.jj = async () => {
  const dir = path.join(WORK, 'jj');
  const html = (n) => fs.readFileSync(path.join(dir, `${n}.html`), 'utf8');
  const plain = (n) => html(n).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'render-meta.json'), 'utf8'));
  check('JS Journey renders: nothing marked read while rendering', meta.markReadCalls === 0, '0 mark-read calls', meta.markReadCalls);
  const mHome = plain('m-home');
  const mJs = plain('m-js');
  const rHome = plain('r-home');
  const rJs = plain('r-js');
  check('/m home: no JS-era notes in Your updates', JS_NOTES.every((n) => !mHome.includes(n)), `none of ${JS_NOTES.join(' | ')}`, JS_NOTES.filter((n) => mHome.includes(n)), 'jj-m-home-1440-light.png');
  check('/m home: his React-era note is still listed ("Three weeks in…")', mHome.includes('Three weeks in'), 'React note present', mHome.includes('Three weeks in'));
  check('/m home: the quiet "JavaScript course history →" link (?course=js)', /<a href="\?course=js"[^>]*>JavaScript course history →<\/a>/.test(html('m-home')), 'link to ?course=js', null, 'jj-m-home-1440-light.png');
  check('/m?course=js: JS summary + her JS updates + his JS notes', ['163h 5m over 68 study days', 'Mapty refactor done', ...JS_NOTES].every((x) => mJs.includes(x)), 'summary, updates and the 3 JS notes', ['163h 5m over 68 study days', 'Mapty refactor done', ...JS_NOTES].filter((x) => !mJs.includes(x)), 'jj-m-js-1440-light.png');
  check('/m?course=js: read-only — no From Rahul, no sign-off, no "New"', !/From Rahul|Sign off|\bNew\b/.test(mJs), 'none', (mJs.match(/From Rahul|Sign off|\bNew\b/g) ?? []));
  check('/r: his notes list holds only React-era notes', JS_NOTES.every((n) => !rHome.includes(n)) && rHome.includes('Three weeks in'), 'React note only', JS_NOTES.filter((n) => rHome.includes(n)), 'jj-r-home-1440-light.png');
  const clock24 = /(Today|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}(?! ?[ap]m)/;
  for (const [n, t] of [['m-home', mHome], ['r-home', rHome]]) {
    check(`${n}: clock times are 12 h, none 24 h`, !clock24.test(t) && /\d{1,2}:\d{2} [ap]m/.test(t), 'h:mm am|pm only', t.match(clock24)?.[0] ?? null, `jj-${n}-1440-light.png`);
  }
  check('/r?course=js: his JS notes are listed', JS_NOTES.every((n) => rJs.includes(n)) && !rJs.includes('Three weeks in'), 'the 3 JS notes, no React note', JS_NOTES.filter((n) => !rJs.includes(n)), 'jj-r-js-1440-light.png');
  const b = await launch('jj', true);
  try {
    for (const [name, label] of [
      ['m-home', '/m (her page): Your updates holds only React-era notes; the quiet "JavaScript course history →" link at the bottom'],
      ['m-js', '/m?course=js: the JS course history — summary, her JS updates, Rahul’s JS notes among them, read-only'],
      ['r-home', '/r (coach page): his notes list holds only React-era notes'],
      ['r-js', '/r?course=js: his JS-era notes among her JS updates'],
    ]) {
      for (const [width, theme] of [
        [1440, 'light'],
        [390, 'dark'],
      ]) {
        const page = await newPage(b, width, theme);
        await page.goto(`file://${path.join(dir, `${name}.html`)}`, { waitUntil: 'load' });
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await page.waitForSelector('main, body > *');
        if (name === 'm-home') {
          const link = await onTop(page, 'a[href="?course=js"]');
          check(`/m ${width} ${theme}: the JS history link is visible`, link, 'visible', link, `jj-${name}-${width}-${theme}.png`);
        }
        await shot(page, `jj-${name}-${width}-${theme}.png`, `${label}${width === 390 ? ' (phone, dark)' : ''}`, { mode: 'full' });
        await page.close();
      }
    }
  } finally {
    await b.close();
  }
};

groups.servers = async () => {
  await startStub();
  await startApp(APP);
  console.log(`stub ${STUB} · app ${appUrl(APP)}`);
};
groups.stop = async () => {
  await stopProc(UNKNOWN.name, `${appUrl(UNKNOWN)}/api/ping`);
  await stopProc(APP.name, `${appUrl(APP)}/api/ping`);
  await stopStub();
  console.log('stopped: app, unknown, stub');
};

/** Builds qa/shots-v3.json from every results-*.json (light ≠ dark is checked here across all shots). */
groups.gallery = async () => {
  const order = ['fresh', 'flow', 'quit', 'over24', 'offline1', 'offline2', 'rejected', 'auto', 'plan', 'note', 'unknown', 'jj'];
  const all = order.filter((g) => fs.existsSync(path.join(OUT, `results-${g}.json`))).map((g) => JSON.parse(fs.readFileSync(path.join(OUT, `results-${g}.json`), 'utf8')));
  const checks = all.flatMap((r) => r.checks);
  const shots = all.flatMap((r) => r.shots);
  // light vs dark really differ (this Mac is dark): per app (course player vs JS Journey)
  const bgs = (pred, theme) => [...new Set(shots.filter((s) => pred(s) && s.theme === theme).map((s) => s.bg))];
  for (const [label, pred] of [
    ['course player', (s) => !s.file.startsWith('jj-')],
    ['JS Journey', (s) => s.file.startsWith('jj-')],
  ]) {
    const light = bgs(pred, 'light');
    const dark = bgs(pred, 'dark');
    checks.push({ name: `${label}: light and dark shots have different backgrounds`, pass: light.length > 0 && dark.length > 0 && light.every((l) => !dark.includes(l)), expected: 'light bg ≠ dark bg', got: { light, dark }, shot: null });
  }
  const passed = checks.filter((c) => c.pass).length;
  const byShot = (f) => checks.filter((c) => c.shot === f);
  const G = [
    ['Start studying', ['fresh']],
    ['The running timer', ['flow:chip']],
    ['Sign off and Send', ['flow:card', 'quit', 'over24']],
    ['Never lost: offline and refused', ['offline1', 'offline2', 'rejected']],
    ['Auto-start, plan, note, course id', ['auto', 'plan', 'note', 'unknown']],
    ['JS Journey: JS notes moved to the history', ['jj']],
  ];
  const flowChip = new Set(['chip-1h23m-1440-light.png', 'chip-hover-1440-light.png', 'chip-focus-1440-dark.png', 'chip-390-dark.png']);
  const pick = (key) => {
    const [g, part] = key.split(':');
    const r = all.find((x) => x.group === g);
    if (!r) return [];
    if (part === 'chip') return r.shots.filter((s) => flowChip.has(s.file));
    if (part === 'card') return r.shots.filter((s) => !flowChip.has(s.file));
    return r.shots;
  };
  const manifest = {
    title: 'Study Timer QA',
    subtitle: 'Course Player v3 in headless Chrome against the SSD course and a stand-in JS Journey, plus the JS Journey pages rendered from test data.',
    meta: {
      'App build': `0.1.0 · study-timer ${process.env.QA_SHA ?? ''} (web built ${process.env.QA_BUILT ?? 'today'})`.replace(/\s+/g, ' '),
      Tests: '460 app · 346 JS Journey',
      Checks: `${passed}/${checks.length} passed`,
      Date: '5 Oct 2026',
    },
    groups: G.map(([name, keys]) => ({
      name,
      shots: keys.flatMap(pick).map((s) => {
        const cs = byShot(s.file);
        const failed = cs.filter((c) => !c.pass);
        return {
          file: path.join(OUT, s.file),
          caption: s.caption,
          check: failed.length === 0 ? 'pass' : 'fail',
          note: failed.length > 0 ? `Failed: ${failed.map((c) => c.name).join('; ')}` : `${cs.length} checks${s.expectedErrors?.length ? ` · expected: ${s.expectedErrors.length} console line(s) for the deliberate 409` : ''}`,
        };
      }),
    })),
  };
  fs.writeFileSync(path.join(REPO, 'qa', 'shots-v3.json'), JSON.stringify(manifest, null, 1));
  const failed = checks.filter((c) => !c.pass);
  console.log(`checks ${passed}/${checks.length}`);
  for (const c of failed) console.log(`FAILED: ${c.name}\n  expected ${c.expected}\n  got ${JSON.stringify(c.got)}${c.shot ? `\n  shot ${path.join(OUT, c.shot)}` : ''}`);
  console.log(`shots: ${manifest.groups.reduce((n, g) => n + g.shots.length, 0)}`);
};

(async () => {
  const names = process.argv.slice(2);
  if (names.length === 0 || names.some((n) => !groups[n])) {
    console.error(`usage: node qa/qa-v3.cjs <${Object.keys(groups).join('|')}>…`);
    process.exit(2);
  }
  for (const name of names) {
    console.log(`\n== ${name}`);
    const noResults = ['servers', 'stop', 'gallery'].includes(name);
    if (!noResults) {
      begin(name);
      if (!['jj'].includes(name)) {
        await startStub();
        await startApp(APP);
      }
    }
    try {
      await groups[name]();
    } catch (err) {
      if (noResults) throw err;
      check(`${name}: group ran to the end`, false, 'no exception', String(err?.stack ?? err));
    }
    if (!noResults) save();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
