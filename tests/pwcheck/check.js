#!/usr/bin/env node
'use strict';
/*
 * Haunted Domains: Playwright checks (headless Chromium).
 *
 *   node tests/pwcheck/check.js                 run everything
 *   node tests/pwcheck/check.js --only search   run chosen sections (comma list)
 *   node tests/pwcheck/check.js --list          list the sections
 *
 * The suite starts its own static server on a free port and serves only the
 * site files, so nothing else needs to be running. Expected values are worked
 * out here from data/ghosts.json by different code than the app uses.
 *
 * Setup, once:  cd tests/pwcheck && npm install && npx playwright install chromium
 *
 * Environment:
 *   PW_MODULE       path to a playwright or playwright-core package to use
 *   CHROMIUM_PATH   path to a Chromium or headless-shell binary to launch
 *   PWCHECK_SHOTS   directory to write screenshots to (off when unset)
 *   AXE_MODULE      path to an axe-core package (axe runs only when it can be found)
 *
 * Exit status is 0 when every check passes and 1 otherwise.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// check bookkeeping
// ---------------------------------------------------------------------------

const results = [];
let currentSection = '';

function check(name, ok, detail) {
  const pass = Boolean(ok);
  results.push({ section: currentSection, name, ok: pass });
  const extra = detail === undefined || detail === '' ? '' : '  [' + String(detail).slice(0, 220) + ']';
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : extra));
  return pass;
}

function skip(name, reason) {
  console.log('SKIP ' + name + '  [' + reason + ']');
}

// ---------------------------------------------------------------------------
// the data, and expected values derived from it
// ---------------------------------------------------------------------------

const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ghosts.json'), 'utf8'));
const GHOSTS = DATA.ghosts;
const TOTAL = GHOSTS.length;
const SORTED = [...GHOSTS].sort((a, b) => {
  if (a.last_seen !== b.last_seen) return a.last_seen < b.last_seen ? -1 : 1;
  return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
});
const SNAPSHOT_MS = Date.parse(DATA.meta.rdap_checked_at);

const fmt = (n) => n.toLocaleString('en-US');
const count = (pred) => SORTED.filter(pred).length;
const domainsWhere = (pred) => SORTED.filter(pred).map((g) => g.domain);

// "11/19/2026 10:28 AM (PST)" as an instant, through an ISO string with an explicit offset.
function listingEndMs(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM) \((PDT|PST)\)$/.exec(text);
  let h = parseInt(m[4], 10);
  if (m[6] === 'AM' && h === 12) h = 0;
  if (m[6] === 'PM' && h !== 12) h += 12;
  const hh = String(h).padStart(2, '0');
  return Date.parse(`${m[3]}-${m[1]}-${m[2]}T${hh}:${m[5]}:00${m[7] === 'PDT' ? '-07:00' : '-08:00'}`);
}
const expectedListingLabel = (g) => (listingEndMs(g.last_ends) <= SNAPSHOT_MS ? 'Listing ended' : 'Listing set to end');
// 0.5 x score + 25 x (min(age, 20) / 20) + 25 if backlinks are present
const expectedRadar = (g) => 0.5 * g.last_score + 25 * (Math.min(g.age_years, 20) / 20) + (g.backlinks === 'n/a' ? 0 : 25);
const tierFor = (days) => (days < 7 ? 'fresh' : days <= 30 ? 'cold' : 'ancient');

// Words the product must never use, and tool names that must not appear in the
// repo's code. They are split here so this file stays clean when it is scanned.
const BANNED_WORDS = ['exp' + 'ired', 'del' + 'eted'];
const BANNED_TOOLS = ['mu' + 'se', 'ag' + 'y', 'anti' + 'gravity'];
const bannedWordsRe = new RegExp(BANNED_WORDS.join('|'), 'i');
const bannedToolsRe = new RegExp(BANNED_TOOLS.join('|'), 'i');

// ---------------------------------------------------------------------------
// static server: serves the site files only, and can hide the data file
// ---------------------------------------------------------------------------

const SERVED = [/^\/index\.html$/, /^\/favicon\.svg$/, /^\/assets\/[\w.-]+$/, /^\/data\/ghosts\.json$/];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function startServer() {
  const control = { hideData: false, requested: [] };
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (err) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    control.requested.push(urlPath);
    const allowed = SERVED.some((re) => re.test(urlPath));
    const file = path.join(ROOT, urlPath);
    if (!allowed || (control.hideData && urlPath === '/data/ghosts.json') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, control, base: 'http://127.0.0.1:' + server.address().port + '/' });
    });
  });
}

// ---------------------------------------------------------------------------
// finding Playwright and a browser
// ---------------------------------------------------------------------------

function loadPlaywright() {
  const attempts = [];
  const tryRequire = (id) => {
    try {
      return require(id);
    } catch (err) {
      attempts.push(id);
      return null;
    }
  };
  let lib = null;
  if (process.env.PW_MODULE) lib = tryRequire(process.env.PW_MODULE);
  lib = lib || tryRequire('playwright') || tryRequire('playwright-core');
  if (!lib) {
    let globalRoot = '';
    try {
      globalRoot = cp.execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      // no npm on the path
    }
    if (globalRoot) lib = tryRequire(path.join(globalRoot, 'playwright')) || tryRequire(path.join(globalRoot, 'playwright-core'));
  }
  if (!lib) {
    console.error('Could not load Playwright (tried: ' + attempts.join(', ') + ').');
    console.error('Run once:  cd tests/pwcheck && npm install && npx playwright install chromium');
    process.exit(2);
  }
  return lib;
}

// ---------------------------------------------------------------------------
// page helpers
// ---------------------------------------------------------------------------

let browser;
let baseUrl;
let serverControl;
const problems = []; // console errors and warnings, page errors, and dialogs, across all pages
const external = []; // requests to anything other than the local server

async function newPage(opts, extra) {
  const options = { viewport: { width: 1440, height: 900 }, ...(opts || {}) };
  const expectErrors = Boolean(extra && extra.expectErrors);
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => {
    if (!expectErrors && ['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(baseUrl) && !/^(about|data|blob):/.test(u)) external.push(u);
  });
  page.on('dialog', (d) => {
    problems.push('dialog: ' + d.message());
    d.dismiss();
  });
  return { ctx, page };
}

async function open(page, hash) {
  await page.goto('about:blank');
  await page.goto(baseUrl + (hash || '#/'));
  await page.waitForSelector('section.view:not([hidden])');
}

// Waits for a condition in the page. Resolves to true or false instead of throwing.
function until(page, fn, arg, timeout) {
  return page.waitForFunction(fn, arg, { timeout: timeout || 4000 }).then(() => true, () => false);
}

const textOf = (page, sel) => page.textContent(sel);
const countText = (page) => page.textContent('#result-count');
const visibleCards = (page) => page.$$eval('.ghost-card', (n) => n.filter((x) => !x.hidden).length);
const allCards = (page) => page.$$eval('.ghost-card', (n) => n.length);
const hashOf = (page) => page.evaluate(() => location.hash);
const activeId = (page) => page.evaluate(() => document.activeElement.id);
const isHidden = (page, sel) => page.$eval(sel, (e) => e.hidden);
const listingLabel = (page) => page.$eval('#detail-content .field-listing-end', (e) => e.previousElementSibling.textContent);

// Waits until the count line reads `expected`, then reports whether it did.
const countIs = (page, expected) => until(page, (t) => document.getElementById('result-count').textContent === t, expected);

// Serves the data file with `mutate` applied to a copy of it.
async function withMutatedData(mutate, fn) {
  const { ctx, page } = await newPage({ viewport: { width: 1000, height: 800 } });
  await page.route('**/data/ghosts.json', (route) => {
    const copy = JSON.parse(JSON.stringify(DATA));
    mutate(copy);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(copy) });
  });
  await page.goto(baseUrl);
  await page.waitForSelector('#ghost-list:not([hidden])');
  await fn(page);
  await ctx.close();
}

// Runs a section and checks that it logged no console problems.
async function section(name, fn) {
  currentSection = name;
  console.log('\n=== ' + name + ' ===');
  const before = problems.length;
  await fn();
  const fresh = problems.slice(before);
  check(name + ': no console errors, warnings, page errors or dialogs', fresh.length === 0, fresh.join(' | '));
}

const SHOTS = process.env.PWCHECK_SHOTS ? path.resolve(process.env.PWCHECK_SHOTS) : '';
async function shot(page, name, opts) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), ...(opts || {}) });
}

// ===========================================================================
// section: repo (static checks on files; no browser)
// ===========================================================================

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listFiles(rel, pattern) {
  return fs.readdirSync(path.join(ROOT, rel)).filter((f) => pattern.test(f)).map((f) => rel + '/' + f);
}

async function repoChecks() {
  // data validator
  let run = null;
  for (const cmd of ['python3', 'python']) {
    const r = cp.spawnSync(cmd, ['-B', 'scripts/validate_data.py'], { cwd: ROOT, encoding: 'utf8' });
    if (!r.error) {
      run = r;
      break;
    }
  }
  if (!run) skip('scripts/validate_data.py', 'python is not installed');
  else check('scripts/validate_data.py exits 0 with zero warnings', run.status === 0 && /\(0 warning\(s\)\)/.test(run.stdout), run.stdout.trim().split('\n').slice(-2).join(' / '));

  // data file facts the app relies on
  check('meta.ghost_count equals the number of ghosts', DATA.meta.ghost_count === TOTAL, DATA.meta.ghost_count + ' vs ' + TOTAL);
  check('meta.sample is false and no domain ends in .example', DATA.meta.sample === false && !GHOSTS.some((g) => g.domain.endsWith('.example')));
  check('data/ghosts.sample.json is not in the repo', !fs.existsSync(path.join(ROOT, 'data', 'ghosts.sample.json')));
  check('every ghost has an rdap status and a checked_at, and meta holds the latest checked_at',
    GHOSTS.every((g) => ['registered', 'available', 'unknown'].includes(g.rdap_status) && g.rdap_checked_at) &&
      DATA.meta.rdap_checked_at === GHOSTS.map((g) => g.rdap_checked_at).sort().pop());
  check('window text in meta looks like "YYYY-MM-DD to YYYY-MM-DD"', /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/.test(DATA.meta.window), DATA.meta.window);

  // repository evidence for the contest and the handoff
  const gitignore = read('.gitignore');
  check('.kiro is not in .gitignore', !/^\s*\/?\.kiro\b/m.test(gitignore));
  check('ghosts.csv stays ignored, and no csv is tracked', /^ghosts\.csv$/m.test(gitignore) && (() => {
    const r = cp.spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    return r.error || r.status !== 0 ? true : !r.stdout.split('\n').some((f) => /\.csv$/i.test(f));
  })());
  const spec = ['requirements', 'design', 'tasks'].map((f) => '.kiro/specs/haunted-domains/' + f + '.md');
  check('spec files and steering exist', spec.every((f) => fs.existsSync(path.join(ROOT, f))) && fs.existsSync(path.join(ROOT, '.kiro/steering/product.md')));
  let hook = null;
  try {
    hook = JSON.parse(read('.kiro/hooks/validate-ghosts.json'));
  } catch (err) {
    hook = null;
  }
  check('the Kiro validation hook is valid JSON and runs the validator',
    Boolean(hook) && hook.version === 'v1' && hook.hooks.some((h) => h.action && /validate_data\.py/.test(h.action.command || '') && /ghosts/.test(h.matcher || '')));
  check('LICENSE is MIT', /MIT License/.test(read('LICENSE')));
  check('DATA-README carries the true ghost count in its coverage section', read('data/DATA-README.md').includes('Ghosts found: ' + fmt(TOTAL)), 'expected "Ghosts found: ' + fmt(TOTAL) + '"');

  // what ships: index.html, assets, scripts and this file
  const site = ['index.html', ...listFiles('assets', /\.(js|css)$/)];
  const code = [...site, ...listFiles('scripts', /\.py$/), 'tests/pwcheck/check.js'];
  check('no forbidden product words in the site files or scripts', !code.some((f) => bannedWordsRe.test(read(f))), code.filter((f) => bannedWordsRe.test(read(f))).join(','));
  check('no non-Kiro tool names anywhere in code', !code.some((f) => bannedToolsRe.test(read(f))), code.filter((f) => bannedToolsRe.test(read(f))).join(','));
  const app = read('assets/app.js');
  check('app.js never builds HTML from data (no innerHTML and friends, no eval)', !/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\(|\beval\(|new Function\(/.test(app));
  check('site files load nothing from outside the repo', !site.some((f) => /https?:\/\/|@import|\/\/cdn\./.test(read(f))));
  const html = read('index.html');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
  check('index.html references only local files', refs.length > 0 && refs.every((u) => /^(assets\/|favicon\.svg$)/.test(u)), refs.join(', '));
  check('app.js makes one network request, for the data file, and nothing else',
    (app.match(/\bfetch\(/g) || []).length === 1 && !/XMLHttpRequest|WebSocket|EventSource|sendBeacon|rdap\.org/.test(app) && /DATA_URL\s*=\s*'data\/ghosts\.json'/.test(app));
}

// ===========================================================================
// section: index (first paint, cards against the data, theme)
// ===========================================================================

async function indexChecks() {
  const { ctx, page } = await newPage();
  await open(page, '#/');

  check('one card per ghost is in the DOM (' + fmt(TOTAL) + ')', (await allCards(page)) === TOTAL, await allCards(page));
  check('the first 60 are revealed', (await visibleCards(page)) === 60, await visibleCards(page));
  check('count line reads "Showing 60 of ' + fmt(TOTAL) + '"', (await countText(page)) === 'Showing 60 of ' + fmt(TOTAL), await countText(page));
  check('meta line renders meta.ghost_count and meta.window from the data, with the disclaimer',
    (await textOf(page, '#meta-line')) === fmt(DATA.meta.ghost_count) + ' ghosts \u00b7 Observed window ' + DATA.meta.window + ' \u00b7 For research use \u2014 not investment advice.', await textOf(page, '#meta-line'));
  check('document title and h2', (await page.title()) === 'The graveyard \u00b7 Haunted Domains' && (await textOf(page, '#index-heading')) === 'The graveyard');
  check('hero names "Haunted Domains" and Kiroween 2026', (await textOf(page, 'h1')) === 'Haunted Domains' && /Kiroween 2026/.test(await textOf(page, '.eyebrow')));
  const tagline = await textOf(page, '.tagline');
  check('tagline promises no live or "today" status, and points to the saved check', !/today/i.test(tagline) && /saved registration check/.test(tagline), tagline);
  check('hero art is inline SVG hidden from assistive technology, favicon is local',
    (await page.$eval('.hero-art', (e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('aria-hidden') === 'true')) && (await page.$eval('link[rel=icon]', (l) => l.getAttribute('href'))) === 'favicon.svg');
  const theme = await page.evaluate(() => {
    const lum = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const root = getComputedStyle(document.documentElement);
    return { bg: lum(getComputedStyle(document.body).backgroundColor), violet: root.getPropertyValue('--violet').trim(), orange: root.getPropertyValue('--orange').trim() };
  });
  check('dark theme with violet and orange accents', theme.bg < 0.05 && /^#/.test(theme.violet) && /^#/.test(theme.orange), JSON.stringify(theme));

  // every card against the data, in order
  const mismatches = await page.$$eval('.ghost-card', (nodes, expected) => nodes.map((li, i) => {
    const g = expected[i];
    const link = li.querySelector('.tomb-link');
    const ok = link.textContent === g.domain && link.getAttribute('href') === '#/' + encodeURIComponent(g.domain) &&
      li.querySelector('time').textContent === g.last_seen && li.querySelector('time').getAttribute('datetime') === g.last_seen &&
      li.querySelector('.field-days').textContent === String(g.days_missing) &&
      li.querySelector('.field-price').textContent === g.last_price &&
      li.querySelector('.field-score').textContent === String(g.last_score) &&
      li.querySelector('.label').textContent === 'Last seen on the board';
    return ok ? null : g.domain;
  }).filter(Boolean), SORTED.map((g) => ({ domain: g.domain, last_seen: g.last_seen, days_missing: g.days_missing, last_price: g.last_price, last_score: g.last_score })));
  check('every card matches the data, in last-seen order: domain, link, last seen, days missing, price verbatim, score', mismatches.length === 0, mismatches.slice(0, 5).join(','));

  const tiers = await page.$$eval('.ghost-card', (n) => n.map((li) => [li.className.match(/tier-(\w+)/)[1], li.querySelector('.tier-badge').textContent]));
  const label = { fresh: 'Fresh', cold: 'Cold', ancient: 'Ancient' };
  check('tier tags follow days missing: fresh under 7, cold 7 to 30, ancient over 30',
    tiers.length === TOTAL && tiers.every(([cls, text], i) => cls === tierFor(SORTED[i].days_missing) && text === label[cls]));
  check('page says the tiers are display buckets only', /display buckets only/.test(await textOf(page, '.tier-note')));
  check('disclaimer is in the footer', /For research use \u2014 not investment advice/.test(await textOf(page, '.site-footer')));
  check('no forbidden product words anywhere in the rendered page, all cards included', !bannedWordsRe.test(await textOf(page, 'body')));
  check('first load does not steal focus', (await page.evaluate(() => document.activeElement === document.body)));
  await ctx.close();
}

// ===========================================================================
// section: showmore (reveal 60 at a time)
// ===========================================================================

async function showMoreChecks() {
  const { ctx, page } = await newPage();
  await open(page, '#/');
  check('button reads "Show 60 more" and is named "Show 60 more ghosts" (visible text inside the name)',
    (await textOf(page, '#show-more')) === 'Show 60 more' && (await page.$eval('#show-more', (b) => b.getAttribute('aria-label'))) === 'Show 60 more ghosts');

  await page.click('#show-more');
  check('one click reveals 120', (await visibleCards(page)) === 120 && (await countText(page)) === 'Showing 120 of ' + fmt(TOTAL), await countText(page));
  check('focus moves to the first newly revealed card', (await page.evaluate(() => document.activeElement.textContent)) === SORTED[60].domain, await page.evaluate(() => document.activeElement.textContent));
  check('the new count reaches the live region', await until(page, () => document.getElementById('status').textContent.startsWith('Showing 120 of ')));

  // keep going to the end, checking the label and count at every step
  const wrong = [];
  let guard = 0;
  while (!(await isHidden(page, '#more-wrap')) && guard++ < 200) {
    const visible = await visibleCards(page);
    const expected = 'Show ' + Math.min(60, TOTAL - visible) + ' more';
    const actual = await textOf(page, '#show-more');
    const name = await page.$eval('#show-more', (b) => b.getAttribute('aria-label'));
    if (actual !== expected || name !== expected + ' ghosts') wrong.push(visible + ': ' + actual + ' / ' + name);
    await page.click('#show-more');
  }
  check('the button label and name follow the real number left at every step', wrong.length === 0, wrong.slice(0, 3).join(' | '));
  check('everything is revealed in the end and the button is gone', (await visibleCards(page)) === TOTAL && (await isHidden(page, '#more-wrap')));
  check('final count line', (await countText(page)) === 'Showing ' + fmt(TOTAL) + ' of ' + fmt(TOTAL), await countText(page));
  check('hidden and revealed cards were all in the DOM throughout', (await allCards(page)) === TOTAL);
  await ctx.close();
}

// ===========================================================================
// section: search (text search, filters, URL state, announcements)
// ===========================================================================

async function searchChecks() {
  const { ctx, page } = await newPage();
  await open(page, '#/');
  const matchLine = (shown, matched) => 'Showing ' + fmt(shown) + ' of ' + fmt(matched) + ' matching';
  const options = (id) => page.$$eval('#' + id + ' option', (n) => n.map((o) => o.textContent));
  const tally = (key) => { const t = {}; GHOSTS.forEach((g) => { t[g[key]] = (t[g[key]] || 0) + 1; }); return t; };

  // structure
  check('filter bar is visible, is a search landmark, and every control has a label',
    !(await isHidden(page, '#filter-bar')) && (await page.getByRole('search').count()) === 1 &&
      (await page.getByLabel('Search domains').count()) === 1 && (await page.getByLabel('TLD').count()) === 1 &&
      (await page.getByLabel('Risk label').count()) === 1 && (await page.getByLabel('Registration (saved snapshot)').count()) === 1);
  const tlds = tally('tld');
  const risks = tally('risk');
  check('TLD options come from the data, with counts',
    JSON.stringify(await options('filter-tld')) === JSON.stringify(['All TLDs', ...Object.keys(tlds).sort().map((k) => k + ' (' + fmt(tlds[k]) + ')')]), JSON.stringify(await options('filter-tld')));
  check('risk options come from the data, with counts',
    JSON.stringify(await options('filter-risk')) === JSON.stringify(['All risk labels', ...Object.keys(risks).sort().map((k) => k + ' (' + fmt(risks[k]) + ')')]), JSON.stringify(await options('filter-risk')));
  const statuses = tally('rdap_status');
  check('registration options are the three snapshot statuses, with counts over the whole data',
    JSON.stringify(await options('filter-rdap')) === JSON.stringify(['Any status', 'Registered (' + fmt(statuses.registered || 0) + ')', 'Available (' + fmt(statuses.available || 0) + ')', 'Unknown (' + fmt(statuses.unknown || 0) + ')']), JSON.stringify(await options('filter-rdap')));
  check('Clear link is hidden while nothing is active', await isHidden(page, '#filter-clear'));

  // typing
  const historyBefore = await page.evaluate(() => history.length);
  await page.click('#search-input');
  await page.keyboard.type('88', { delay: 40 });
  const n88 = count((g) => g.domain.toLowerCase().includes('88'));
  check('typing "88" counts matches over all ghosts', await countIs(page, matchLine(Math.min(60, n88), n88)), await countText(page));
  check('the URL carries the search', (await hashOf(page)) === '#/?q=88', await hashOf(page));
  check('heading and title name the search', (await textOf(page, '#index-heading')) === 'Search results for \u201c88\u201d' && (await page.title()) === 'Search \u201c88\u201d \u00b7 Haunted Domains');
  check('typing does not add history entries', (await page.evaluate(() => history.length)) === historyBefore);
  check('every revealed card contains the term', await page.$$eval('.ghost-card:not([hidden]) .tomb-link', (n) => n.every((a) => a.textContent.toLowerCase().includes('88'))));
  check('all cards stay in the DOM while searching', (await allCards(page)) === TOTAL);
  check('focus stays in the search box, and the Clear link appears', (await activeId(page)) === 'search-input' && !(await isHidden(page, '#filter-clear')));

  await page.fill('#search-input', '');
  await page.keyboard.type('QW', { delay: 40 });
  const nqw = count((g) => g.domain.toLowerCase().includes('qw'));
  check('search ignores case ("QW")', await countIs(page, matchLine(Math.min(60, nqw), nqw)), await countText(page));

  await page.fill('#search-input', '');
  await page.keyboard.type('ab ', { delay: 40 });
  await until(page, () => location.hash === '#/?q=ab');
  check('a trailing space survives while typing, and the URL carries the trimmed term', (await page.inputValue('#search-input')) === 'ab ' && (await hashOf(page)) === '#/?q=ab', JSON.stringify(await page.inputValue('#search-input')) + ' ' + (await hashOf(page)));

  await page.fill('#search-input', '   ');
  await until(page, () => location.hash === '#/');
  check('a search of only spaces is no search', (await countText(page)) === 'Showing 60 of ' + fmt(TOTAL) && (await hashOf(page)) === '#/', (await countText(page)) + ' ' + (await hashOf(page)));

  await page.fill('#search-input', '');
  await page.keyboard.type('88');
  await page.keyboard.press('Enter');
  check('Enter applies at once and does not reload the page', await until(page, () => location.hash === '#/?q=88', undefined, 1000) && (await allCards(page)) === TOTAL);

  // hostile and malformed input
  const payload = '<img src=x onerror=alert(1)>';
  await page.fill('#search-input', payload);
  await until(page, (t) => document.getElementById('empty-text').textContent.includes(t), payload);
  check('markup typed into the search is shown as text and never parsed',
    (await textOf(page, '#empty-text')) === 'No ghosts match \u201c' + payload + '\u201d.' && (await page.$$('#empty-text img, #index-heading img, #filter-bar img')).length === 0, await textOf(page, '#empty-text'));
  await open(page, '#/?q=%E0%A4%A');
  check('a malformed percent escape in the URL does not break the page', (await allCards(page)) === TOTAL);

  // filters, one at a time and together
  await open(page, '#/');
  const risky = risks;
  const riskNames = Object.keys(risky).sort();
  const smallRisk = riskNames.reduce((a, b) => (risky[a] <= risky[b] ? a : b));
  const bigRisk = riskNames.reduce((a, b) => (risky[a] >= risky[b] ? a : b));
  const nSmall = count((g) => g.risk === smallRisk);
  const nBig = count((g) => g.risk === bigRisk);
  await page.selectOption('#filter-risk', smallRisk);
  check('risk filter "' + smallRisk + '" shows exactly its ghosts', await countIs(page, matchLine(Math.min(60, nSmall), nSmall)), await countText(page));
  check('every revealed card really has that risk label in the data',
    await page.$$eval('.ghost-card:not([hidden]) .tomb-link', (links, set) => links.every((a) => set.includes(a.textContent)), domainsWhere((g) => g.risk === smallRisk).slice(0, 60 * 20)));
  check('filter URL, heading and title', (await hashOf(page)) === '#/?risk=' + smallRisk.replace(/ /g, '+') && (await textOf(page, '#index-heading')) === 'Filtered graveyard' && (await page.title()) === 'Filtered graveyard \u00b7 Haunted Domains', await hashOf(page));
  await page.selectOption('#filter-risk', bigRisk);
  check('risk filter "' + bigRisk + '" (more than one page) offers Show more', (await countIs(page, matchLine(Math.min(60, nBig), nBig))) && (nBig > 60 ? !(await isHidden(page, '#more-wrap')) : true), await countText(page));
  const tld = Object.keys(tlds).sort()[0];
  await page.selectOption('#filter-tld', tld);
  check('TLD and risk combine with AND', (await countIs(page, matchLine(Math.min(60, count((g) => g.risk === bigRisk && g.tld === tld)), count((g) => g.risk === bigRisk && g.tld === tld)))) && (await hashOf(page)) === '#/?tld=' + tld + '&risk=' + bigRisk.replace(/ /g, '+'), (await countText(page)) + ' ' + (await hashOf(page)));

  if (nBig > 60) {
    await page.click('#show-more');
    check('Show more works inside a filter', (await countText(page)) === matchLine(Math.min(120, nBig), nBig), await countText(page));
    await page.selectOption('#filter-risk', smallRisk);
    await countIs(page, matchLine(Math.min(60, nSmall), nSmall));
    check('changing a filter resets the reveal to the first 60 matches', (await visibleCards(page)) === Math.min(60, nSmall));
    await page.selectOption('#filter-risk', bigRisk);
    await countIs(page, matchLine(Math.min(60, nBig), nBig));
    check('changing it back shows 60 again, not the earlier 120', (await visibleCards(page)) === Math.min(60, nBig));
  }

  // registration status
  await open(page, '#/');
  for (const status of ['registered', 'available', 'unknown']) {
    const n = count((g) => g.rdap_status === status);
    await page.selectOption('#filter-rdap', status);
    if (n > 0) {
      check('registration = ' + status + ' matches ' + fmt(n), await countIs(page, matchLine(Math.min(60, n), n)), await countText(page));
    } else {
      await until(page, () => !document.getElementById('empty-state').hidden);
      check('registration = ' + status + ' (none in the data) shows an explicit empty state, not a blank page',
        !(await isHidden(page, '#empty-state')) && (await isHidden(page, '#ghost-list')) && (await textOf(page, '#empty-text')) === 'No ghosts match the selected filters.' && (await countText(page)) === matchLine(0, 0), await textOf(page, '#empty-text'));
    }
  }
  const noneStatus = ['available', 'unknown', 'registered'].find((s) => count((g) => g.rdap_status === s) === 0);
  if (noneStatus) {
    await page.selectOption('#filter-rdap', noneStatus);
    await until(page, () => !document.getElementById('empty-state').hidden);
    check('the empty state keeps every card in the DOM and offers a way out', (await allCards(page)) === TOTAL && (await textOf(page, '#empty-state a')) === 'Clear search and filters');
    await page.fill('#search-input', 'zz');
    await until(page, () => document.getElementById('empty-text').textContent.includes('\u201czz\u201d'));
    check('the empty message names both the search and the filters', (await textOf(page, '#empty-text')) === 'No ghosts match \u201czz\u201d and the selected filters.', await textOf(page, '#empty-text'));
  }
  await open(page, '#/?q=zzzzzz');
  check('a search with no match shows its own empty message', (await textOf(page, '#empty-text')) === 'No ghosts match \u201czzzzzz\u201d.' && (await countText(page)) === matchLine(0, 0));

  // search and filter together, Clear, deep links
  await open(page, '#/');
  await page.selectOption('#filter-risk', bigRisk);
  await page.fill('#search-input', '1');
  const nCombo = count((g) => g.risk === bigRisk && g.domain.toLowerCase().includes('1'));
  check('search and a filter combine', await countIs(page, matchLine(Math.min(60, nCombo), nCombo)), await countText(page));
  await page.click('#filter-clear');
  await countIs(page, 'Showing 60 of ' + fmt(TOTAL));
  check('Clear resets the URL, the controls and the count',
    (await hashOf(page)) === '#/' && (await page.inputValue('#search-input')) === '' && (await page.inputValue('#filter-risk')) === '' && (await countText(page)) === 'Showing 60 of ' + fmt(TOTAL) && (await isHidden(page, '#filter-clear')),
    (await hashOf(page)) + ' | ' + JSON.stringify(await page.inputValue('#search-input')) + ' | ' + (await page.inputValue('#filter-risk')) + ' | ' + (await countText(page)));
  check('after Clear, focus moves to the heading instead of being lost', await until(page, () => document.activeElement.id === 'index-heading', undefined, 1000));

  await open(page, '#/?q=1&risk=' + bigRisk.replace(/ /g, '+') + '&tld=' + tld + '&rdap=registered');
  const nDeep = count((g) => g.risk === bigRisk && g.domain.includes('1') && g.tld === tld && g.rdap_status === 'registered');
  check('a deep link applies every parameter and fills the controls',
    (await countText(page)) === matchLine(Math.min(60, nDeep), nDeep) && (await page.inputValue('#search-input')) === '1' && (await page.inputValue('#filter-risk')) === bigRisk && (await page.inputValue('#filter-tld')) === tld && (await page.inputValue('#filter-rdap')) === 'registered', await countText(page));
  await open(page, '#/?tld=.org&risk=Nope&rdap=live');
  check('values the data does not have are ignored, not silently matched against', (await countText(page)) === 'Showing 60 of ' + fmt(TOTAL) && (await page.inputValue('#filter-tld')) === '' && (await page.inputValue('#filter-risk')) === '', await countText(page));

  // browser back restores the filtered list
  await open(page, '#/?risk=' + smallRisk.replace(/ /g, '+'));
  await page.click('.ghost-card:not([hidden]) .tomb-link');
  await until(page, () => location.hash.length > 3 && !location.hash.startsWith('#/?'));
  check('the filter bar is hidden on the detail view', await isHidden(page, '#filter-bar'));
  await page.goBack();
  await countIs(page, matchLine(Math.min(60, nSmall), nSmall));
  check('browser back returns to the filtered list with the controls filled in', (await page.inputValue('#filter-risk')) === smallRisk && (await countText(page)) === matchLine(Math.min(60, nSmall), nSmall), await countText(page));

  // live region: debounce and de-duplication
  await open(page, '#/');
  await page.evaluate(() => {
    window.__announced = [];
    new MutationObserver(() => window.__announced.push(document.getElementById('status').textContent))
      .observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
  });
  await page.selectOption('#filter-tld', tld);
  await page.selectOption('#filter-tld', '');
  await page.waitForTimeout(900);
  check('switching a filter on and off inside the debounce window announces nothing', (await page.evaluate(() => window.__announced.length)) === 0, JSON.stringify(await page.evaluate(() => window.__announced)));
  await page.selectOption('#filter-risk', smallRisk);
  await page.waitForTimeout(900);
  check('a real change is announced once, with the visible count', JSON.stringify(await page.evaluate(() => window.__announced)) === JSON.stringify([matchLine(Math.min(60, nSmall), nSmall)]), JSON.stringify(await page.evaluate(() => window.__announced)));
  for (let i = 0; i < 2; i++) {
    await page.selectOption('#filter-risk', bigRisk);
    await page.selectOption('#filter-risk', smallRisk);
  }
  await page.waitForTimeout(900);
  check('rapid changes that end where they began are not announced again', (await page.evaluate(() => window.__announced.length)) === 1);
  await page.fill('#search-input', 'zzzzzz');
  await until(page, (t) => document.getElementById('status').textContent === t, 'No ghosts match \u201czzzzzz\u201d and the selected filters.', 3000);
  check('the empty state is announced in words', (await textOf(page, '#status')) === 'No ghosts match \u201czzzzzz\u201d and the selected filters.', await textOf(page, '#status'));

  // keyboard order
  await open(page, '#/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const order = [];
  for (let i = 0; i < 4; i++) {
    order.push(await activeId(page));
    await page.keyboard.press('Tab');
  }
  check('tab order after the skip link: search, TLD, risk, registration', JSON.stringify(order) === JSON.stringify(['search-input', 'filter-tld', 'filter-risk', 'filter-rdap']), JSON.stringify(order));
  await ctx.close();
}

// ===========================================================================
// section: routing (index to detail and back, focus, titles, unknown routes)
// ===========================================================================

async function routingChecks() {
  const { ctx, page } = await newPage();
  await open(page, '#/');

  await page.keyboard.press('Tab');
  check('the first Tab stop is the skip link', (await activeId(page)) === 'skip-link');
  await page.keyboard.press('Enter');
  check('the skip link focuses main and leaves the hash alone', (await activeId(page)) === 'main' && (await hashOf(page)) === '#/');

  // index -> detail -> back, with a revealed list and a scrolled page
  await open(page, '#/');
  await page.click('#show-more');
  await page.click('#show-more');
  const target = SORTED[100].domain;
  await page.evaluate((d) => document.querySelector('.tomb-link[href="#/' + encodeURIComponent(d) + '"]').scrollIntoView({ block: 'center' }), target);
  const yBefore = await page.evaluate(() => Math.round(window.scrollY));
  await page.click('.tomb-link[href="#/' + encodeURIComponent(target) + '"]');
  await until(page, () => document.activeElement.id === 'detail-heading', undefined, 2000);
  check('a card link opens the detail view with its domain as the heading, and focus moves there',
    (await textOf(page, '#detail-heading')) === target && (await activeId(page)) === 'detail-heading', await activeId(page));
  check('the detail title names the domain', (await page.title()) === target + ' \u00b7 Haunted Domains', await page.title());
  check('the detail view opens scrolled to the top', (await page.evaluate(() => window.scrollY)) === 0);
  check('the index and the filter bar are hidden, the footer disclaimer stays',
    (await isHidden(page, '#view-index')) && (await isHidden(page, '#filter-bar')) && /For research use/.test(await textOf(page, '.site-footer')));
  await page.click('.back a');
  await until(page, () => document.activeElement.id === 'index-heading', undefined, 2000);
  check('Back to the graveyard restores the reveal (180 cards)', (await visibleCards(page)) === 180, await visibleCards(page));
  check('...and the scroll position', await until(page, (y) => Math.abs(window.scrollY - y) < 3, yBefore, 2000), 'before ' + yBefore + ', after ' + (await page.evaluate(() => Math.round(window.scrollY))));
  check('...and puts focus on the index heading', (await activeId(page)) === 'index-heading');

  // browser history works too
  await page.click('.tomb-link[href="#/' + encodeURIComponent(target) + '"]');
  await until(page, (d) => document.getElementById('detail-heading').textContent === d, target);
  await page.goBack();
  await until(page, () => !document.getElementById('view-index').hidden);
  check('the browser back button returns to the index', (await textOf(page, '#index-heading')) === 'The graveyard' && (await visibleCards(page)) === 180);

  // direct links
  await open(page, '#/' + SORTED[0].domain.toUpperCase());
  check('a detail link works in any letter case', (await textOf(page, '#detail-heading')) === SORTED[0].domain, await textOf(page, '#detail-heading'));
  await open(page, '#/NOT-A-GHOST.com');
  check('an unknown domain gets a clear not-found view with a way back',
    !(await isHidden(page, '#view-notfound')) && /NOT-A-GHOST\.com/.test(await textOf(page, '#notfound-text')) && (await page.title()).startsWith('Ghost not found') && (await textOf(page, '#view-notfound a')) === 'Back to the graveyard');
  check('the not-found view hides the filter bar and keeps the disclaimer', (await isHidden(page, '#filter-bar')) && /For research use/.test(await textOf(page, '.site-footer')));
  await open(page, '#/%E0%A4%A');
  check('a malformed escape in a detail link does not crash the page', !(await isHidden(page, '#view-notfound')));
  await ctx.close();
}

// ===========================================================================
// section: detail (fields, listing end, registration snapshot, value radar)
// ===========================================================================

// Formats an instant the way last_ends is written, in Pacific time.
function formatListing(ms, tz) {
  const d = new Date(ms - (tz === 'PDT' ? 7 : 8) * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '/' + d.getUTCFullYear() + ' ' + pad(h12) + ':' + pad(d.getUTCMinutes()) + ' ' + (h24 < 12 ? 'AM' : 'PM') + ' (' + tz + ')';
}

async function detailChecks() {
  const { ctx, page } = await newPage();
  const setToEnd = domainsWhere((g) => expectedListingLabel(g) === 'Listing set to end');
  const endedCount = TOTAL - setToEnd.length;

  // one page in depth
  const focus = GHOSTS.find((g) => g.domain === setToEnd[0]) || GHOSTS[0];
  await open(page, '#/' + focus.domain);
  const f = (sel) => textOf(page, '#detail-content ' + sel);
  check('four sections, in order', JSON.stringify(await page.$$eval('#detail-content h3', (n) => n.map((x) => x.textContent))) === JSON.stringify(['On the board', 'Last listing', 'Resurrection check', 'Value radar']));
  check('every field from requirement 2.1 is shown, verbatim from the data',
    (await f('.field-first')) === focus.first_seen && (await f('.field-last')) === focus.last_seen && (await f('.field-onboard')) === String(focus.days_on_board) &&
      (await f('.field-days')) === String(focus.days_missing) && (await f('.field-rank')) === String(focus.last_rank) && (await f('.field-score')) === String(focus.last_score) &&
      (await f('.field-risk')) === focus.risk && (await f('.field-age')) === focus.age_years + ' years' && (await f('.field-backlinks')) === focus.backlinks && (await f('.field-history')) === focus.history);
  check('the price is the last_price string, exactly', (await f('.field-price')) === focus.last_price);
  check('the intro says the data shows nothing more than a last sighting', /Last seen on the board/.test(await f('.detail-intro')) && /shows nothing more than that/.test(await f('.detail-intro')));
  check('the page carries the "not a registration date" note and the disclaimer', /not a registration date/.test(await f('.note')) && /For research use/.test(await textOf(page, '.site-footer')));
  check('the registration check shows status and its own checked_at, and says it is a saved snapshot',
    (await f('.rdap-pill')) === 'Registered' && (await f('.field-checked')) === focus.rdap_checked_at && /saved snapshot, not a live lookup/.test(await f('.rdap')));
  check('the radar says it is a display score, not an appraisal, and keeps the price out of the score',
    /not an appraisal and not a price prediction/.test(await f('.radar-disclaimer')) && new RegExp('Last offering ' + focus.last_price.replace('$', '\\$') + ' is shown for reference only\\. It is not part of the score\\.').test(await f('.radar-price')));

  // every ghost
  const expectations = SORTED.map((g) => {
    const total = expectedRadar(g);
    const shown = Math.round(total);
    return { g, label: expectedListingLabel(g), shown, totalText: 'Total ' + total + (Number.isInteger(total) ? '' : ', shown rounded to ' + shown) };
  });
  const sweep = await page.evaluate(async (list) => {
    const bad = [];
    const labels = { ended: 0, setToEnd: 0, other: 0 };
    const waitFor = async (pred) => {
      for (let i = 0; i < 400; i++) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return false;
    };
    for (const { g, label, shown, totalText } of list) {
      location.hash = '#/' + encodeURIComponent(g.domain);
      const ready = await waitFor(() => document.getElementById('detail-heading').textContent === g.domain && !document.getElementById('view-detail').hidden);
      const q = (s) => document.querySelector('#detail-content ' + s);
      const t = (s) => (q(s) ? q(s).textContent : null);
      const got = q('.field-listing-end') ? q('.field-listing-end').previousElementSibling.textContent : null;
      if (got === 'Listing ended') labels.ended++; else if (got === 'Listing set to end') labels.setToEnd++; else labels.other++;
      const ok = ready &&
        t('.field-first') === g.first_seen && t('.field-last') === g.last_seen && t('.field-onboard') === String(g.days_on_board) &&
        t('.field-days') === String(g.days_missing) && t('.field-rank') === String(g.last_rank) && t('.field-score') === String(g.last_score) &&
        t('.field-risk') === g.risk && t('.field-age') === g.age_years + ' years' && t('.field-backlinks') === g.backlinks && t('.field-history') === g.history &&
        t('.field-price') === g.last_price && t('.field-listing-end') === g.last_ends && got === label &&
        t('.field-checked') === g.rdap_checked_at && t('.rdap-pill') === 'Registered' &&
        t('.field-radar') === shown + '/100' && q('.meter-fill').style.width === shown + '%' && t('.radar-total') === totalText;
      if (!ok) bad.push(g.domain);
    }
    return { bad, labels };
  }, expectations);
  check('all ' + fmt(TOTAL) + ' detail pages match the data: fields, price, listing end text, label, snapshot time, radar, meter, total', sweep.bad.length === 0, sweep.bad.slice(0, 5).join(','));
  check('the listing-end labels split as the data says: ' + setToEnd.length + ' "Listing set to end", ' + fmt(endedCount) + ' "Listing ended"',
    sweep.labels.setToEnd === setToEnd.length && sweep.labels.ended === endedCount && sweep.labels.other === 0, JSON.stringify(sweep.labels));
  const radars = SORTED.map((g) => Math.round(expectedRadar(g)));
  check('the radar stays inside 0 to 100', radars.every((n) => n >= 0 && n <= 100) && Math.max(...radars) <= 100);
  await ctx.close();

  // listing end around the snapshot time
  const minuteMs = Math.floor(SNAPSHOT_MS / 60000) * 60000;
  const g0 = DATA.ghosts;
  await withMutatedData((d) => {
    // Put the snapshot on an exact minute so a listing end can tie with it.
    d.meta.rdap_checked_at = new Date(minuteMs).toISOString().replace('.000Z', 'Z');
    d.ghosts[0].last_ends = formatListing(minuteMs, 'PST');
    d.ghosts[1].last_ends = formatListing(minuteMs, 'PDT');
    d.ghosts[2].last_ends = formatListing(minuteMs + 60000, 'PST');
    d.ghosts[3].last_ends = formatListing(minuteMs + 60000, 'PDT');
    d.ghosts[4].last_ends = 'sometime in November';
  }, async (p) => {
    const label = async (domain) => { await p.evaluate((x) => { location.hash = '#/' + x; }, domain); await until(p, (x) => document.getElementById('detail-heading').textContent === x, domain); return listingLabel(p); };
    check('a listing end at exactly the snapshot time (Pacific standard time) is "Listing ended": on or before counts', (await label(g0[0].domain)) === 'Listing ended');
    check('...and the same minute written in daylight time is "Listing ended" too', (await label(g0[1].domain)) === 'Listing ended');
    check('one minute after the snapshot is "Listing set to end" in both zones', (await label(g0[2].domain)) === 'Listing set to end' && (await label(g0[3].domain)) === 'Listing set to end');
    check('text that is not a time gets the neutral "Listing end" and is still shown as written', (await label(g0[4].domain)) === 'Listing end' && (await textOf(p, '.field-listing-end')) === 'sometime in November');
  });
  await withMutatedData((d) => { d.meta.rdap_checked_at = 'garbage'; }, async (p) => {
    await p.evaluate((x) => { location.hash = '#/' + x; }, g0[0].domain);
    await until(p, (x) => document.getElementById('detail-heading').textContent === x, g0[0].domain);
    check('an unreadable snapshot time gives the neutral label, with no crash', (await listingLabel(p)) === 'Listing end');
  });

  // registration statuses
  await withMutatedData((d) => {
    d.ghosts[0].rdap_status = 'unknown';
    d.ghosts[1].rdap_status = 'available';
    d.ghosts[2].rdap_status = 'mystery';
  }, async (p) => {
    const go = async (domain) => { await p.evaluate((x) => { location.hash = '#/' + x; }, domain); await until(p, (x) => document.getElementById('detail-heading').textContent === x, domain); };
    await go(g0[0].domain);
    check('unknown says so plainly, makes no guess, and still shows checked_at',
      (await textOf(p, '.rdap-pill')) === 'Unknown' && /could not tell whether this domain is registered\. No guess is made here\./.test(await textOf(p, '.rdap-text')) && (await textOf(p, '.field-checked')) === g0[0].rdap_checked_at);
    await go(g0[1].domain);
    check('available is worded as "may be open to register", with checked_at', (await textOf(p, '.rdap-pill')) === 'Available' && /may be open to register/.test(await textOf(p, '.rdap-text')) && (await textOf(p, '.field-checked')) === g0[1].rdap_checked_at);
    await go(g0[2].domain);
    check('a status the page does not know is shown as unknown, without a guess', (await textOf(p, '.rdap-pill')) === 'Unknown' && /does not recognise/.test(await textOf(p, '.rdap-text')));
  });

  // value radar edge cases
  const cases = [
    { age: 0, score: 0, backlinks: 'n/a' },
    { age: 20, score: 100, backlinks: '1 referring domain' },
    { age: 17, score: 70, backlinks: 'n/a' },
    { age: 5, score: 80, backlinks: '500+ referring domains' },
    { age: 30, score: 50, backlinks: 'n/a' },
    { age: 1, score: 1, backlinks: 'n/a' },
  ];
  await withMutatedData((d) => {
    cases.forEach((c, i) => { Object.assign(d.ghosts[i], { age_years: c.age, last_score: c.score, backlinks: c.backlinks }); });
  }, async (p) => {
    for (const [i, c] of cases.entries()) {
      const domain = g0[i].domain;
      await p.evaluate((x) => { location.hash = '#/' + x; }, domain);
      await until(p, (x) => document.getElementById('detail-heading').textContent === x, domain);
      const total = expectedRadar({ last_score: c.score, age_years: c.age, backlinks: c.backlinks });
      const shown = Math.round(total);
      check('radar for score ' + c.score + ', age ' + c.age + ', backlinks "' + c.backlinks + '" is ' + total + ' and shows ' + shown + '/100',
        (await textOf(p, '.field-radar')) === shown + '/100' && (await p.$eval('.meter-fill', (e) => e.style.width)) === shown + '%' && (await textOf(p, '.radar-inputs')) === '(score ' + c.score + ' \u00b7 age ' + c.age + ' yrs \u00b7 backlinks ' + c.backlinks + ')' &&
          new RegExp('^Total ' + String(total).replace('.', '\\.')).test(await textOf(p, '.radar-total')), await textOf(p, '.radar'));
    }
    await p.evaluate((x) => { location.hash = '#/' + x; }, g0[4].domain);
    await until(p, (x) => document.getElementById('detail-heading').textContent === x, g0[4].domain);
    check('an age above 20 is counted up to 20 and the page says so', /counted up to 20/.test(await textOf(p, '.radar-parts')));
    await p.evaluate((x) => { location.hash = '#/' + x; }, g0[1].domain);
    await until(p, (x) => document.getElementById('detail-heading').textContent === x, g0[1].domain);
    check('an age of exactly 20 does not claim it was capped', !/counted up to/.test(await textOf(p, '.radar-parts')));
  });
}

// ===========================================================================
// section: errors (data file missing, broken, wrong shape, unreachable)
// ===========================================================================

async function errorChecks() {
  const cases = [
    {
      name: 'the data file is missing (real HTTP 404)',
      prepare: async () => { serverControl.hideData = true; },
      cleanup: async () => { serverControl.hideData = false; },
      status: /^404/,
      hint: false,
    },
    {
      name: 'the data file is not valid JSON',
      route: (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{oops' }),
      status: /not valid JSON/,
      hint: false,
    },
    {
      name: 'the data file has the wrong shape',
      route: (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ghosts":"nope"}' }),
      status: /expected shape/,
      hint: false,
    },
    {
      name: 'the data file cannot be reached',
      route: (r) => r.abort(),
      status: /Network error/,
      hint: true,
    },
  ];
  for (const c of cases) {
    if (c.prepare) await c.prepare();
    const { ctx, page } = await newPage({ viewport: { width: 1000, height: 800 } }, { expectErrors: true });
    if (c.route) await page.route('**/data/ghosts.json', c.route);
    await page.goto(baseUrl);
    await page.waitForSelector('#view-error:not([hidden])');
    const state = await page.evaluate(() => ({
      url: document.getElementById('error-url').textContent,
      status: document.getElementById('error-status').textContent,
      hint: !document.getElementById('error-hint').hidden,
      focus: document.activeElement.id,
      title: document.title,
      indexHidden: document.getElementById('view-index').hidden,
      barVisible: !document.getElementById('filter-bar').hidden,
      barDisabled: document.getElementById('filter-fields').disabled,
      controlsDisabled: [...document.querySelectorAll('#filter-bar input, #filter-bar select')].every((x) => x.matches(':disabled')),
      cards: document.querySelectorAll('.ghost-card').length,
      alerts: document.querySelectorAll('[role=alert], [aria-live]').length,
    }));
    check('error state, ' + c.name + ': the panel names the file and the status', state.url === 'data/ghosts.json' && c.status.test(state.status), state.url + ' / ' + state.status);
    check('error state, ' + c.name + ': ' + (c.hint ? 'a hint about serving over HTTP is shown' : 'no serving hint'), state.hint === c.hint);
    check('error state, ' + c.name + ': focus goes to the error heading, the title says so, no ghosts are shown',
      state.focus === 'error-heading' && state.title === 'Data unavailable \u00b7 Haunted Domains' && state.indexHidden && state.cards === 0, JSON.stringify(state));
    check('error state, ' + c.name + ': the filter bar stays visible but inert', state.barVisible && state.barDisabled && state.controlsDisabled);
    check('error state, ' + c.name + ': the disclaimer is still there and only the status element is a live region',
      /For research use/.test(await textOf(page, '.site-footer')) && state.alerts === 1);
    await ctx.close();
    if (c.cleanup) await c.cleanup();
  }

  // synthetic events cannot rewrite the URL outside the index view
  {
    const { ctx, page } = await newPage({ viewport: { width: 1000, height: 800 } }, { expectErrors: true });
    await page.route('**/data/ghosts.json', (r) => r.abort());
    await page.goto(baseUrl);
    await page.waitForSelector('#view-error:not([hidden])');
    const before = await page.evaluate(() => location.href);
    await page.evaluate(() => {
      const s = document.getElementById('search-input');
      s.value = 'sneaky';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('filter-risk').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('filter-bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      document.getElementById('show-more').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    check('synthetic input, change, submit and click events leave the error view and the URL alone',
      (await page.evaluate(() => location.href)) === before && !(await isHidden(page, '#view-error')));
    await ctx.close();
    const second = await newPage();
    await open(second.page, '#/' + SORTED[0].domain);
    const before2 = await second.page.evaluate(() => location.href);
    await second.page.evaluate(() => {
      const s = document.getElementById('search-input');
      s.value = 'sneaky';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('filter-tld').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await second.page.waitForTimeout(600);
    check('the same events cannot rewrite the URL from the detail view either', (await second.page.evaluate(() => location.href)) === before2);
    await open(second.page, '#/');
    await second.page.fill('#search-input', '88');
    check('and real typing on the index still filters', await countIs(second.page, 'Showing ' + fmt(Math.min(60, count((g) => g.domain.includes('88')))) + ' of ' + fmt(count((g) => g.domain.includes('88'))) + ' matching'));
    await second.ctx.close();
  }
}

// ===========================================================================
// section: layout (widths, columns, no horizontal scrolling)
// ===========================================================================

async function layoutChecks() {
  const views = [
    ['index', '#/'],
    ['search results', '#/?q=1'],
    ['filtered', '#/?risk=' + Object.keys(GHOSTS.reduce((t, g) => ({ ...t, [g.risk]: 1 }), {})).sort()[0].replace(/ /g, '+')],
    ['empty state', '#/?q=zzzzzz'],
    ['detail', '#/' + SORTED[Math.floor(TOTAL / 2)].domain],
    ['not found', '#/nope'],
  ];
  const columns = {};
  for (const [width, height] of [[1440, 900], [1000, 800], [360, 740]]) {
    const { ctx, page } = await newPage({ viewport: { width, height } });
    for (const [name, hash] of views) {
      await open(page, hash);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check('no horizontal scrolling at ' + width + 'px: ' + name, m.sw <= m.cw, JSON.stringify(m));
    }
    await open(page, '#/');
    columns[width] = await page.evaluate(() => new Set([...document.querySelectorAll('.ghost-card:not([hidden])')].slice(0, 24).map((e) => Math.round(e.getBoundingClientRect().left))).size);
    await shot(page, 'index-' + width + '.png');
    await open(page, '#/' + SORTED[0].domain);
    await shot(page, 'detail-' + width + '.png', { fullPage: true });
    await ctx.close();
  }
  check('the card grid adapts: one column at 360px, more at 1000px, more again at 1440px',
    columns[360] === 1 && columns[1000] > columns[360] && columns[1440] >= columns[1000], JSON.stringify(columns));

  // wide card grid with everything revealed still fits
  {
    const { ctx, page } = await newPage({ viewport: { width: 360, height: 740 } });
    await open(page, '#/');
    for (let i = 0; i < 5; i++) await page.click('#show-more');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check('no horizontal scrolling at 360px with 360 cards revealed', m.sw <= m.cw, JSON.stringify(m));
    await ctx.close();
  }
  // error panel at narrow widths
  for (const width of [360, 1440]) {
    const { ctx, page } = await newPage({ viewport: { width, height: 800 } }, { expectErrors: true });
    await page.route('**/data/ghosts.json', (r) => r.abort());
    await page.goto(baseUrl);
    await page.waitForSelector('#view-error:not([hidden])');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check('no horizontal scrolling at ' + width + 'px: error state', m.sw <= m.cw, JSON.stringify(m));
    await ctx.close();
  }
}

// ===========================================================================
// section: a11y (structure, focus, targets, motion, forced colors, reflow, contrast)
// ===========================================================================

function resolveAxe() {
  const candidates = [];
  if (process.env.AXE_MODULE) candidates.push(path.join(process.env.AXE_MODULE, 'axe.min.js'));
  try { candidates.push(require.resolve('axe-core/axe.min.js')); } catch (err) { /* not installed next to this file */ }
  try {
    const globalRoot = cp.execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(path.join(globalRoot, 'axe-core', 'axe.min.js'));
  } catch (err) { /* no npm */ }
  return candidates.find((p) => fs.existsSync(p)) || '';
}

// Measures contrast on rendered pixels: hides all text, screenshots the real
// backgrounds, then compares each text run's colour with the worst pixel behind it.
async function measureContrast(page) {
  const runs = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('[hidden], script, style, noscript, .sr-only, [aria-hidden="true"], :disabled')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const clipped = cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.color === 'rgba(0, 0, 0, 0)';
      out.push({ text: n.nodeValue.trim().slice(0, 36), color: cs.color, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), clipped, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  });
  await page.addStyleTag({ content: '*{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important} ::placeholder{color:transparent !important}' });
  const shot = await page.screenshot({ type: 'png' });
  const backs = await page.evaluate(async ({ b64, list }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const dpr = img.width / innerWidth;
    return list.map((r) => {
      const x = Math.max(0, Math.floor(r.x * dpr));
      const y = Math.max(0, Math.floor(r.y * dpr));
      const w = Math.max(1, Math.min(img.width - x, Math.ceil(r.w * dpr)));
      const h = Math.max(1, Math.min(img.height - y, Math.ceil(r.h * dpr)));
      const d = ctx.getImageData(x, y, w, h).data;
      let lo = 2;
      let hi = -1;
      for (let i = 0; i < d.length; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]); if (L < lo) lo = L; if (L > hi) hi = L; }
      return { lo, hi };
    });
  }, { b64: shot.toString('base64'), list: runs });
  const lumOf = (css) => { const [r, g, b] = (css.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const rows = runs.filter((r) => !r.clipped).map((r) => {
    const i = runs.indexOf(r);
    const lt = lumOf(r.color);
    const ratio = Math.min((Math.max(lt, backs[i].hi) + 0.05) / (Math.min(lt, backs[i].hi) + 0.05), (Math.max(lt, backs[i].lo) + 0.05) / (Math.min(lt, backs[i].lo) + 0.05));
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
    return { ...r, ratio, need: large ? 3 : 4.5 };
  });
  return rows;
}

async function a11yChecks() {
  // structure and the accessibility tree
  {
    const { ctx, page } = await newPage();
    await open(page, '#/');
    const tree = await page.locator('body').ariaSnapshot();
    check('landmarks: banner, main, search, contentinfo', ['banner', 'main', 'search', 'contentinfo'].every((r) => new RegExp('^\\s*- ' + r + '\\b', 'm').test(tree)));
    check('exactly one h1, and heading levels never skip a level', await page.evaluate(() => {
      const hs = [...document.querySelectorAll('h1, h2, h3, h4')].filter((h) => !h.closest('[hidden]'));
      const levels = hs.map((h) => Number(h.tagName[1]));
      return levels.filter((l) => l === 1).length === 1 && levels.every((l, i) => i === 0 || l - levels[i - 1] <= 1);
    }));
    check('only the revealed cards are in the accessibility tree, each as a named article', (tree.match(/- article "[^"]+"/g) || []).length === 60 && !/- article:/.test(tree), String((tree.match(/- article "[^"]+"/g) || []).length));
    check('each article is named by its visible domain heading', await page.$$eval('.ghost-card:not([hidden]) article', (n) => n.every((a) => { const h = document.getElementById(a.getAttribute('aria-labelledby')); return h && h.tagName === 'H3' && h.textContent === a.querySelector('.tomb-link').textContent; })));
    check('every id on the page is unique', await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); return new Set(ids).size === ids.length; }));
    check('exactly one live region, a polite status element that exists from page load',
      (await page.$$eval('[aria-live], [role=status], [role=alert]', (n) => n.length)) === 1 && (await page.$eval('#status', (e) => e.getAttribute('aria-live') === 'polite' && e.getAttribute('role') === 'status')));
    check('the page language is declared', (await page.evaluate(() => document.documentElement.lang)) === 'en');
    check('the meter is decoration: hidden from assistive technology, the value is in text', await (async () => {
      await open(page, '#/' + SORTED[0].domain);
      return (await page.$eval('.meter', (e) => e.getAttribute('aria-hidden') === 'true')) && /\d+\/100/.test(await textOf(page, '.radar-value'));
    })());
    await ctx.close();
  }

  // focus rings and target sizes
  {
    const { ctx, page } = await newPage();
    await open(page, '#/');
    const stops = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const e = document.activeElement;
        const cs = getComputedStyle(e);
        return { id: e.id || e.className || e.tagName, ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && e.matches(':focus-visible') };
      }));
    }
    check('the first 12 Tab stops each show a focus ring of at least 2px', stops.every((s) => s.ring), JSON.stringify(stops.filter((s) => !s.ring)));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({ viewport: { width: 360, height: 800 } });
    await open(page, '#/?q=1');
    const sizes = await page.evaluate(() => [...document.querySelectorAll('a, button, input, select')]
      .filter((e) => !e.closest('[hidden]') && e.getBoundingClientRect().width > 0 && !e.classList.contains('skip-link'))
      .map((e) => { const r = e.getBoundingClientRect(); return { name: (e.id || e.className || e.tagName), w: Math.round(r.width), h: Math.round(r.height), inline: getComputedStyle(e).display === 'inline' }; }));
    check('no control is smaller than 24 by 24 CSS px at 360px', sizes.filter((s) => !s.inline && (s.w < 24 || s.h < 24)).length === 0, JSON.stringify(sizes.filter((s) => !s.inline && (s.w < 24 || s.h < 24))));
    check('form controls, the Clear link and Show more are at least 44px tall', sizes.filter((s) => /search-input|filter-|show-more|clear-link/.test(s.name)).every((s) => s.h >= 44), JSON.stringify(sizes.filter((s) => /search-input|filter-|show-more|clear-link/.test(s.name))));
    await ctx.close();
  }

  // motion and forced colors
  {
    const reduced = await newPage({ reducedMotion: 'reduce' });
    await open(reduced.page, '#/');
    const m = await reduced.page.evaluate(() => ({ art: getComputedStyle(document.querySelector('.hero-art')).animationName, tomb: getComputedStyle(document.querySelector('.tomb')).transitionDuration }));
    check('reduced motion switches off the hero drift and the card transitions', m.art === 'none' && /^0s/.test(m.tomb), JSON.stringify(m));
    await reduced.ctx.close();
    const normal = await newPage({ reducedMotion: 'no-preference' });
    await open(normal.page, '#/');
    check('motion stays when the visitor has no preference', (await normal.page.evaluate(() => getComputedStyle(document.querySelector('.hero-art')).animationName)) === 'drift');
    await normal.ctx.close();
    const forced = await newPage({ forcedColors: 'active' });
    await open(forced.page, '#/' + SORTED[0].domain);
    const f = await forced.page.evaluate(() => ({
      color: getComputedStyle(document.querySelector('.site-title')).color,
      fill: getComputedStyle(document.querySelector('.site-title')).webkitTextFillColor,
      meterFill: getComputedStyle(document.querySelector('.meter-fill')).backgroundColor,
      badgeBorder: getComputedStyle(document.querySelector('.tier-badge')).borderTopStyle,
      pillBorder: getComputedStyle(document.querySelector('.rdap-pill')).borderTopStyle,
    }));
    check('forced colors: the title text is painted, the meter fill is a system colour, badges and pills have outlines',
      f.color !== 'rgba(0, 0, 0, 0)' && f.fill !== 'rgba(0, 0, 0, 0)' && !/rgba\(\d+, \d+, \d+, 0\)$/.test(f.meterFill) && f.badgeBorder === 'solid' && f.pillBorder === 'solid', JSON.stringify(f));
    await forced.ctx.close();
  }

  // reflow: 400% and 200% zoom, and the WCAG text-spacing overrides
  for (const [label, width, spacing] of [['320px wide (400% zoom)', 320, false], ['640px wide (200% zoom)', 640, false], ['text-spacing overrides at 360px', 360, true]]) {
    const { ctx, page } = await newPage({ viewport: { width, height: 800 } });
    for (const hash of ['#/', '#/?q=1&risk=' + encodeURIComponent(SORTED[0].risk).replace(/%20/g, '+'), '#/' + SORTED[0].domain, '#/zzz']) {
      await open(page, hash);
      if (spacing) await page.addStyleTag({ content: '*{line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important} p{margin-bottom:2em !important}' });
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        overflowing: [...document.querySelectorAll('main *, header *, footer *')].filter((e) => !e.closest('[hidden], .sr-only') && !e.classList.contains('sr-only') && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').length,
        clipped: [...document.querySelectorAll('.tomb, .detail-section, .panel')].filter((e) => !e.closest('[hidden]') && e.scrollHeight > e.clientHeight + 1).length,
      }));
      check(label + ' ' + hash + ': nothing scrolls sideways or is clipped', m.sw <= m.cw && m.overflowing === 0 && m.clipped === 0, JSON.stringify(m));
    }
    await ctx.close();
  }

  // contrast measured on rendered pixels
  for (const [label, width, hash] of [['index at 1440px', 1440, '#/'], ['index at 360px', 360, '#/'], ['search and empty state at 1000px', 1000, '#/?q=zzzz&risk=' + encodeURIComponent(SORTED[0].risk).replace(/%20/g, '+')], ['detail at 1440px', 1440, '#/' + SORTED[0].domain], ['detail at 360px', 360, '#/' + SORTED[1].domain], ['not found at 1000px', 1000, '#/nope']]) {
    const { ctx, page } = await newPage({ viewport: { width, height: 1200 } });
    await open(page, hash);
    await page.waitForTimeout(250);
    const rows = await measureContrast(page);
    const fails = rows.filter((r) => r.ratio < r.need);
    check('text contrast, ' + label + ': ' + rows.length + ' text runs, none below WCAG AA (lowest ' + Math.min(...rows.map((r) => r.ratio)).toFixed(2) + ':1)', rows.length > 5 && fails.length === 0, fails.slice(0, 3).map((r) => r.ratio.toFixed(2) + ' "' + r.text + '"').join(' | '));
    await ctx.close();
  }
  // non-text colours the design depends on
  {
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const css = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
    const border = (/border: 2px solid (#[0-9a-f]{6}); \/\* field border/i.exec(css) || [])[1];
    const placeholder = (/::placeholder \{ color: (#[0-9a-f]{6})/i.exec(css) || [])[1];
    const focus = (/--focus: (#[0-9a-f]{6})/i.exec(css) || [])[1];
    const ancient = (/\.tier-ancient \.tomb \{ border-color: (#[0-9a-f]{6})/i.exec(css) || [])[1];
    check('field borders are at least 3:1 against the panel and the input fill', Boolean(border) && ratio(border, '#1e1030') >= 3 && ratio(border, '#160c27') >= 3, border);
    check('placeholder text is at least 4.5:1 on the input fill', Boolean(placeholder) && ratio(placeholder, '#160c27') >= 4.5, placeholder);
    check('the focus ring is at least 3:1 on the page, card and panel colours', Boolean(focus) && ['#120a1f', '#2d1e49', '#1e1030'].every((b) => ratio(focus, b) >= 3), focus);
    check('the ancient-tier card border is at least 3:1 against both card fills', Boolean(ancient) && ratio(ancient, '#2d1e49') >= 3 && ratio(ancient, '#1e1030') >= 3, ancient);
  }

  // axe-core, when it can be found
  const axePath = resolveAxe();
  if (!axePath) {
    skip('axe-core scan', 'axe-core not found (npm install in tests/pwcheck, or set AXE_MODULE)');
  } else {
    const states = [['index', '#/'], ['search results', '#/?q=88'], ['empty state', '#/?q=zzzzzz'], ['detail', '#/' + SORTED[0].domain], ['not found', '#/nope']];
    for (const width of [1440, 360]) {
      const { ctx, page } = await newPage({ viewport: { width, height: 900 } });
      for (const [name, hash] of states) {
        await open(page, hash);
        await page.addScriptTag({ path: axePath });
        const r = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] }));
        check('axe-core, ' + name + ' at ' + width + 'px: no violations', r.violations.length === 0, r.violations.map((v) => v.id + '[' + v.nodes.length + ']').join(', '));
      }
      await ctx.close();
    }
  }
}

// ===========================================================================
// section: network (what the browser actually asked for)
// ===========================================================================

async function networkChecks() {
  const allowed = new Set(['/index.html', '/assets/app.js', '/assets/style.css', '/favicon.svg', '/data/ghosts.json']);
  const asked = [...new Set(serverControl.requested)];
  check('the server was only asked for the page, its two assets, the icon and the data file', asked.every((p) => allowed.has(p)), asked.filter((p) => !allowed.has(p)).join(', '));
  check('the browser never asked for a registration lookup', !serverControl.requested.some((p) => /rdap/i.test(p)) && !external.some((u) => /rdap/i.test(u)));
  check('the browser never asked any other host for anything', external.length === 0, external.slice(0, 3).join(', '));
}

// ===========================================================================
// main
// ===========================================================================

const SECTIONS = [
  ['repo', repoChecks, false],
  ['index', indexChecks, true],
  ['showmore', showMoreChecks, true],
  ['search', searchChecks, true],
  ['routing', routingChecks, true],
  ['detail', detailChecks, true],
  ['errors', errorChecks, true],
  ['layout', layoutChecks, true],
  ['a11y', a11yChecks, true],
  ['network', networkChecks, true],
];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log(SECTIONS.map((s) => s[0]).join('\n'));
    return 0;
  }
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1].split(',') : null;
  if (only) {
    const unknown = only.filter((n) => !SECTIONS.some((s) => s[0] === n));
    if (unknown.length) {
      console.error('Unknown section(s): ' + unknown.join(', ') + '. Use --list to see them.');
      return 2;
    }
  }
  const chosen = SECTIONS.filter((s) => !only || only.includes(s[0]));
  const needsBrowser = chosen.some((s) => s[2]);

  const started = Date.now();
  const srv = await startServer();
  baseUrl = srv.base;
  serverControl = srv.control;
  if (needsBrowser) {
    const pw = loadPlaywright();
    try {
      browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    } catch (err) {
      console.error('Could not start Chromium: ' + String(err.message).split('\n')[0]);
      console.error('Run once:  cd tests/pwcheck && npx playwright install chromium   (or set CHROMIUM_PATH)');
      srv.server.close();
      return 2;
    }
  }
  console.log('Haunted Domains checks against ' + baseUrl + ' (' + fmt(TOTAL) + ' ghosts)');

  let crashed = null;
  try {
    for (const [name, fn] of chosen) await section(name, fn);
  } catch (err) {
    crashed = err;
  }
  if (browser) await browser.close();
  srv.server.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((r) => console.log('  [' + r.section + '] ' + r.name));
  }
  if (crashed) {
    console.error('\nThe run stopped early: ' + (crashed.stack || crashed));
    return 1;
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
