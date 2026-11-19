/* Haunted Domains: graveyard index, hash routing, and view state.
 *
 * Rules this file follows (see .kiro/steering/product.md):
 *  - Everything shown comes from data/ghosts.json. Prices are shown verbatim.
 *  - "Death" means last seen on the board, and the UI says so.
 *  - Data is only ever written to the page with textContent or setAttribute.
 *    No HTML strings are ever built or injected from data.
 *  - The browser never looks up registration data. Anything about it comes
 *    from the shipped snapshot.
 */
(function () {
  'use strict';

  const DATA_URL = 'data/ghosts.json';
  const PAGE_SIZE = 60;
  const SITE_NAME = 'Haunted Domains';
  const ANNOUNCE_DELAY_MS = 400;
  const SEARCH_DELAY_MS = 250;
  const RDAP_STATUSES = ['registered', 'available', 'unknown'];
  const FILTER_KEYS = ['q', 'tld', 'risk', 'rdap'];
  const TIER_LABELS = { fresh: 'Fresh', cold: 'Cold', ancient: 'Ancient' };

  const $ = (id) => document.getElementById(id);
  const els = {
    skip: $('skip-link'),
    main: $('main'),
    views: {
      index: $('view-index'),
      detail: $('view-detail'),
      notfound: $('view-notfound'),
      error: $('view-error'),
    },
    headings: {
      index: $('index-heading'),
      detail: $('detail-heading'),
      notfound: $('notfound-heading'),
      error: $('error-heading'),
    },
    meta: $('meta-line'),
    loading: $('loading'),
    count: $('result-count'),
    empty: $('empty-state'),
    emptyText: $('empty-text'),
    list: $('ghost-list'),
    moreWrap: $('more-wrap'),
    more: $('show-more'),
    detailContent: $('detail-content'),
    notfoundText: $('notfound-text'),
    errorUrl: $('error-url'),
    errorStatus: $('error-status'),
    errorHint: $('error-hint'),
    status: $('status'),
    filterBar: $('filter-bar'),
    filterFields: $('filter-fields'),
    search: $('search-input'),
    tld: $('filter-tld'),
    risk: $('filter-risk'),
    rdap: $('filter-rdap'),
    clear: $('filter-clear'),
  };

  const state = {
    meta: null,
    entries: [], // { g, li, link, key }, sorted by last_seen then domain
    byDomain: new Map(), // lower-case domain -> entry
    known: { tld: new Set(), risk: new Set(), rdap: new Set(RDAP_STATUSES) }, // values the filters can take
    ready: false,
    failed: false,
    filters: { q: '', tld: '', risk: '', rdap: '' },
    limit: PAGE_SIZE,
    matched: 0,
    shown: 0,
    view: null,
    firstRoute: true,
    indexScrollY: 0,
  };

  // ---------- helpers ----------

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US');
  }

  function filtersActive(f) {
    return FILTER_KEYS.some((k) => f[k] !== '');
  }

  function sameFilters(a, b) {
    return FILTER_KEYS.every((k) => a[k] === b[k]);
  }

  // Recency tiers are display buckets by days missing, not claims about a domain.
  function tierOf(daysMissing) {
    if (daysMissing < 7) return 'fresh';
    if (daysMissing <= 30) return 'cold';
    return 'ancient';
  }

  function focusWasLost() {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return true;
    return Boolean(a.closest('[hidden]'));
  }

  // The status element is the only live region. Announcements are debounced and
  // a message identical to the previous one is dropped.
  let announceTimer = null;
  let lastAnnounced = '';
  function announce(message) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (message === lastAnnounced) return;
      lastAnnounced = message;
      els.status.textContent = message;
    }, ANNOUNCE_DELAY_MS);
  }

  // ---------- cards ----------

  function fact(label, value, fieldClass) {
    const row = make('div');
    row.appendChild(make('dt', null, label));
    row.appendChild(make('dd', fieldClass, value));
    return row;
  }

  function buildCard(g) {
    const tier = tierOf(g.days_missing);
    const li = make('li', 'ghost-card tier-' + tier);
    const tomb = make('article', 'tomb');

    tomb.appendChild(make('span', 'tier-badge', TIER_LABELS[tier]));

    const heading = make('h3', 'tomb-domain');
    const link = make('a', 'tomb-link', g.domain);
    link.href = '#/' + encodeURIComponent(g.domain);
    heading.appendChild(link);
    tomb.appendChild(heading);

    const seen = make('p', 'tomb-seen');
    seen.appendChild(make('span', 'label', 'Last seen on the board'));
    const when = make('time', null, g.last_seen);
    when.setAttribute('datetime', g.last_seen);
    seen.appendChild(when);
    tomb.appendChild(seen);

    const facts = make('dl', 'tomb-facts');
    facts.appendChild(fact('Days missing', String(g.days_missing), 'field-days'));
    facts.appendChild(fact('Last offering', g.last_price, 'field-price')); // verbatim
    facts.appendChild(fact('Last score', String(g.last_score), 'field-score'));
    tomb.appendChild(facts);

    li.appendChild(tomb);
    return { g, li, link, key: g.domain.toLowerCase() };
  }

  // Meta line: ghost count and window come from meta in the data file. Each date
  // sits in its own span so it never breaks across lines at a hyphen.
  function renderMetaLine(meta) {
    els.meta.textContent = '';
    els.meta.appendChild(document.createTextNode(fmt(meta.ghost_count) + ' ghosts \u00b7 Observed window '));
    for (const piece of meta.window.split(/(\d{4}-\d{2}-\d{2})/)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(piece)) els.meta.appendChild(make('span', 'nowrap', piece));
      else if (piece) els.meta.appendChild(document.createTextNode(piece));
    }
    els.meta.appendChild(document.createTextNode(' \u00b7 For research use \u2014 not investment advice.'));
  }

  // ---------- list state: search, reveal, count ----------

  // Applies the current search text to all ghosts, then reveals the first
  // `state.limit` matches. Every card stays in the DOM; non-matching and
  // not-yet-revealed cards are hidden with the hidden attribute.
  function applyView() {
    const f = state.filters;
    const q = f.q.toLowerCase();
    const active = filtersActive(f);
    let matched = 0;
    let shown = 0;
    for (const entry of state.entries) {
      const hit = (!q || entry.key.indexOf(q) !== -1) &&
        (!f.tld || entry.g.tld === f.tld) &&
        (!f.risk || entry.g.risk === f.risk) &&
        (!f.rdap || entry.g.rdap_status === f.rdap);
      let visible = false;
      if (hit) {
        matched += 1;
        visible = matched <= state.limit;
        if (visible) shown += 1;
      }
      if (entry.li.hidden === visible) entry.li.hidden = !visible;
    }
    state.matched = matched;
    state.shown = shown;

    const total = state.entries.length;
    const countText = active
      ? 'Showing ' + fmt(shown) + ' of ' + fmt(matched) + ' matching'
      : 'Showing ' + fmt(shown) + ' of ' + fmt(total);
    els.count.textContent = countText;
    els.count.hidden = false;

    const none = matched === 0;
    els.list.hidden = none;
    els.empty.hidden = !none;
    const emptyMessage = emptyMessageFor(f);
    if (none) els.emptyText.textContent = emptyMessage;

    const remaining = matched - shown;
    els.moreWrap.hidden = remaining <= 0;
    if (remaining > 0) els.more.textContent = 'Show ' + Math.min(PAGE_SIZE, remaining) + ' more';

    // The same text is shown on screen and sent to the live region.
    return none ? emptyMessage : countText;
  }

  function emptyMessageFor(f) {
    const filtering = Boolean(f.tld || f.risk || f.rdap);
    if (f.q && !filtering) return 'No ghosts match \u201c' + f.q + '\u201d.';
    if (f.q) return 'No ghosts match \u201c' + f.q + '\u201d and the selected filters.';
    return 'No ghosts match the selected filters.';
  }

  // ---------- search and filter controls ----------

  // The URL is the single source of truth: the controls write the hash, and the
  // router reads it back. #/?q=88&tld=.com&risk=Low+risk&rdap=registered
  let searchTimer = null;
  function commitFilters() {
    clearTimeout(searchTimer);
    const params = new URLSearchParams();
    const q = els.search.value.trim();
    if (q) params.set('q', q);
    if (els.tld.value) params.set('tld', els.tld.value);
    if (els.risk.value) params.set('risk', els.risk.value);
    if (els.rdap.value) params.set('rdap', els.rdap.value);
    const qs = params.toString();
    // replace, not assign: typing and picking filters should not fill the back button
    window.location.replace('#/' + (qs ? '?' + qs : ''));
  }

  function syncControls() {
    const f = state.filters;
    // Leave the text box alone while it already holds the same search, so a
    // trailing space the visitor is still typing is not trimmed away.
    if (els.search.value.trim() !== f.q) els.search.value = f.q;
    els.tld.value = f.tld;
    els.risk.value = f.risk;
    els.rdap.value = f.rdap;
    els.clear.hidden = !filtersActive(f);
  }

  function addOptions(select, counts, labelFor) {
    for (const [value, n] of counts) {
      const option = make('option', null, labelFor(value) + ' (' + fmt(n) + ')');
      option.value = value;
      select.appendChild(option);
    }
  }

  // Options come from the data: TLDs and risk labels that occur, and the three
  // registration statuses the snapshot can hold. Counts cover the whole data set.
  function buildFilterOptions() {
    const tlds = new Map();
    const risks = new Map();
    const statuses = new Map(RDAP_STATUSES.map((s) => [s, 0]));
    for (const { g } of state.entries) {
      tlds.set(g.tld, (tlds.get(g.tld) || 0) + 1);
      risks.set(g.risk, (risks.get(g.risk) || 0) + 1);
      if (statuses.has(g.rdap_status)) statuses.set(g.rdap_status, statuses.get(g.rdap_status) + 1);
    }
    const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const sortedTlds = [...tlds].sort(byKey);
    const sortedRisks = [...risks].sort(byKey);
    state.known.tld = new Set(sortedTlds.map((e) => e[0]));
    state.known.risk = new Set(sortedRisks.map((e) => e[0]));
    addOptions(els.tld, sortedTlds, (v) => v);
    addOptions(els.risk, sortedRisks, (v) => v);
    addOptions(els.rdap, [...statuses], (v) => RDAP_COPY[v][0]);
  }

  // A hash can carry values the controls cannot show (a TLD that is not in the
  // data, say). Those are dropped rather than silently matching nothing.
  function sanitizeFilters(f) {
    const clean = { q: f.q, tld: f.tld, risk: f.risk, rdap: f.rdap };
    for (const key of ['tld', 'risk', 'rdap']) {
      if (clean[key] && !state.known[key].has(clean[key])) clean[key] = '';
    }
    return clean;
  }

  function showMore() {
    const before = state.shown;
    state.limit += PAGE_SIZE;
    const text = applyView();
    announce(text);
    // Keep keyboard users in place: focus the first newly revealed card.
    let seen = 0;
    for (const entry of state.entries) {
      if (entry.li.hidden) continue;
      if (seen === before) {
        entry.link.focus();
        break;
      }
      seen += 1;
    }
  }

  // ---------- detail view ----------

  // Value radar: a display score for browsing, not an appraisal or a price
  // prediction. Weights come from design.md: last score 0.5, age 0.25 (counted
  // up to 20 years), backlinks presence 0.25 ("n/a" counts as none). The last
  // price is shown next to the score and never enters it. 25 points over a
  // 20 year cap is 1.25 points per year, so every part is a multiple of 0.25
  // and the parts add up exactly.
  const AGE_CAP_YEARS = 20;
  function radar(g) {
    const scorePart = g.last_score * 0.5;
    const ageCounted = Math.min(g.age_years, AGE_CAP_YEARS);
    const agePart = ageCounted * 1.25;
    const hasBacklinks = g.backlinks !== 'n/a';
    const backlinksPart = hasBacklinks ? 25 : 0;
    const total = scorePart + agePart + backlinksPart;
    return { scorePart, ageCounted, agePart, hasBacklinks, backlinksPart, total, shown: Math.round(total) };
  }

  // last_ends looks like "11/19/2026 10:28 AM (PST)". Returns the instant in
  // milliseconds, or null when the text is not in that shape.
  function parseListingEnd(text) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM) \((PDT|PST)\)$/.exec(text);
    if (!m) return null;
    const hour24 = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
    const utcOffsetHours = m[7] === 'PDT' ? 7 : 8;
    const ms = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour24 + utcOffsetHours, Number(m[5]));
    return Number.isNaN(ms) ? null : ms;
  }

  // The label is relative to the registration snapshot time (meta.rdap_checked_at):
  // on or before it the listing had ended by then; after it, it was still set
  // to end later. The text of last_ends itself is always shown unchanged.
  function listingEndLabel(g) {
    const ends = parseListingEnd(g.last_ends);
    const snapshot = Date.parse(state.meta.rdap_checked_at);
    if (ends === null || Number.isNaN(snapshot)) return 'Listing end';
    return ends <= snapshot ? 'Listing ended' : 'Listing set to end';
  }

  const RDAP_COPY = {
    registered: ['Registered', 'The snapshot found this domain registered.'],
    available: ['Available', 'The snapshot found no registration record, so the domain may be open to register. Confirm with a registrar before acting on it.'],
    unknown: ['Unknown', 'The snapshot could not tell whether this domain is registered. No guess is made here.'],
  };

  function section(title, className) {
    const node = make('section', 'detail-section' + (className ? ' ' + className : ''));
    node.appendChild(make('h3', null, title));
    return node;
  }

  function factList(rows) {
    const dl = make('dl', 'detail-facts');
    for (const [label, value, fieldClass] of rows) dl.appendChild(fact(label, value, fieldClass));
    return dl;
  }

  // Every radar part is a multiple of 0.25, so String() prints it exactly:
  // 39.5, 25, 21.25.
  function num(n) {
    return String(n);
  }

  function renderRadar(g) {
    const r = radar(g);
    const node = section('Value radar', 'radar');

    const headline = make('p', 'radar-value');
    headline.appendChild(document.createTextNode('Resurrection value: '));
    headline.appendChild(make('strong', 'field-radar', r.shown + '/100'));
    node.appendChild(headline);
    node.appendChild(make('p', 'radar-inputs',
      '(score ' + g.last_score + ' \u00b7 age ' + g.age_years + ' yrs \u00b7 backlinks ' + g.backlinks + ')'));

    const meter = make('div', 'meter');
    meter.setAttribute('aria-hidden', 'true');
    const fill = make('div', 'meter-fill');
    fill.style.width = r.shown + '%';
    meter.appendChild(fill);
    node.appendChild(meter);

    const parts = make('ul', 'radar-parts');
    parts.appendChild(make('li', null,
      'Last score ' + g.last_score + ' \u00d7 0.5 = ' + num(r.scorePart) + ' of 50'));
    parts.appendChild(make('li', null,
      'Age ' + g.age_years + ' yrs' + (g.age_years > AGE_CAP_YEARS ? ', counted up to ' + AGE_CAP_YEARS : '') +
      ': ' + r.ageCounted + ' \u00d7 1.25 = ' + num(r.agePart) + ' of 25'));
    parts.appendChild(make('li', null,
      'Backlinks ' + g.backlinks + (r.hasBacklinks ? ': counts as 25 of 25' : ': counts as 0 of 25')));
    const rounded = Number.isInteger(r.total) ? '' : ', shown rounded to ' + r.shown;
    parts.appendChild(make('li', 'radar-total', 'Total ' + num(r.total) + rounded));
    node.appendChild(parts);

    node.appendChild(make('p', 'radar-price',
      'Last offering ' + g.last_price + ' is shown for reference only. It is not part of the score.'));
    node.appendChild(make('p', 'radar-disclaimer',
      'A display score for browsing: not an appraisal and not a price prediction. For research use \u2014 not investment advice.'));
    return node;
  }

  function renderRdap(g) {
    const copy = RDAP_COPY[g.rdap_status] || ['Unknown', 'The snapshot holds a status this page does not recognise. No guess is made here.'];
    const node = section('Resurrection check', 'rdap');
    const line = make('p', 'rdap-line');
    line.appendChild(make('span', 'rdap-pill rdap-' + (RDAP_COPY[g.rdap_status] ? g.rdap_status : 'unknown'), copy[0]));
    node.appendChild(line);
    node.appendChild(make('p', 'rdap-text', copy[1]));
    const checked = make('p', 'rdap-checked');
    checked.appendChild(document.createTextNode('Checked at '));
    const when = make('time', 'field-checked', g.rdap_checked_at);
    when.setAttribute('datetime', g.rdap_checked_at);
    checked.appendChild(when);
    checked.appendChild(document.createTextNode(' (UTC). This is a saved snapshot, not a live lookup, and the status may have changed since.'));
    node.appendChild(checked);
    return node;
  }

  function renderDetail(g) {
    const root = els.detailContent;
    root.replaceChildren();

    const tier = tierOf(g.days_missing);
    const intro = make('p', 'detail-intro tier-' + tier);
    intro.appendChild(make('span', 'tier-badge', TIER_LABELS[tier]));
    intro.appendChild(document.createTextNode(' Last seen on the board '));
    const seen = make('time', 'nowrap', g.last_seen);
    seen.setAttribute('datetime', g.last_seen);
    intro.appendChild(seen);
    intro.appendChild(document.createTextNode(', ' + g.days_missing + (g.days_missing === 1 ? ' day' : ' days') +
      ' missing. The data shows nothing more than that.'));
    root.appendChild(intro);

    const board = section('On the board', 'board');
    board.appendChild(factList([
      ['First seen', g.first_seen, 'field-first'],
      ['Last seen on the board', g.last_seen, 'field-last'],
      ['Days on board', String(g.days_on_board), 'field-onboard'],
      ['Days missing', String(g.days_missing), 'field-days'],
      ['Last rank', String(g.last_rank), 'field-rank'],
      ['Last score', String(g.last_score), 'field-score'],
      ['Risk label', g.risk, 'field-risk'],
      ['Age', g.age_years + ' years', 'field-age'],
      ['Backlinks', g.backlinks, 'field-backlinks'],
    ]));
    const history = make('p', 'history-line');
    history.appendChild(make('span', 'label', 'History'));
    history.appendChild(make('span', 'field-history', g.history)); // verbatim
    board.appendChild(history);
    root.appendChild(board);

    const listing = section('Last listing', 'listing');
    listing.appendChild(factList([
      ['Last offering', g.last_price, 'field-price'], // verbatim
      [listingEndLabel(g), g.last_ends, 'field-listing-end'], // verbatim
    ]));
    listing.appendChild(make('p', 'note',
      'The listing end is the time the last listing was set to close, as the data lists it. It is not a registration date.'));
    root.appendChild(listing);

    root.appendChild(renderRdap(g));
    root.appendChild(renderRadar(g));
  }

  // ---------- routing ----------

  // #/            graveyard index
  // #/?q=term     index filtered by domain name (also tld=, risk=, rdap=)
  // #/<domain>    ghost detail
  function parseRoute() {
    const raw = window.location.hash.replace(/^#/, '');
    if (raw === '' || raw === '/') return { type: 'index', filters: { q: '', tld: '', risk: '', rdap: '' } };
    const cut = raw.indexOf('?');
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const query = cut === -1 ? '' : raw.slice(cut + 1);
    if (path === '' || path === '/') {
      const params = new URLSearchParams(query);
      return {
        type: 'index',
        filters: {
          q: (params.get('q') || '').trim(),
          tld: params.get('tld') || '',
          risk: params.get('risk') || '',
          rdap: params.get('rdap') || '',
        },
      };
    }
    let name = path.replace(/^\//, '');
    try {
      name = decodeURIComponent(name);
    } catch (err) {
      // Keep the raw text when the hash holds a bad escape sequence.
    }
    return { type: 'detail', name };
  }

  function render() {
    if (!state.ready) return;

    let view;
    let heading;
    let title;

    if (state.failed) {
      view = 'error';
      title = 'Data unavailable';
    } else {
      const route = parseRoute();
      if (route.type === 'index') {
        view = 'index';
        const f = sanitizeFilters(route.filters);
        if (!sameFilters(f, state.filters)) {
          state.filters = f;
          state.limit = PAGE_SIZE;
          announce(applyView());
        }
        syncControls();
        const filtering = Boolean(f.tld || f.risk || f.rdap);
        heading = f.q ? 'Search results for \u201c' + f.q + '\u201d' : filtering ? 'Filtered graveyard' : 'The graveyard';
        title = f.q ? 'Search \u201c' + f.q + '\u201d' : filtering ? 'Filtered graveyard' : 'The graveyard';
        els.headings.index.textContent = heading;
      } else {
        const entry = state.byDomain.get(route.name.toLowerCase());
        if (entry) {
          view = 'detail';
          els.headings.detail.textContent = entry.g.domain;
          renderDetail(entry.g);
          title = entry.g.domain;
        } else {
          view = 'notfound';
          els.notfoundText.textContent = 'No ghost named \u201c' + route.name + '\u201d is in the graveyard.';
          title = 'Ghost not found';
        }
      }
    }

    const previous = state.view;
    if (previous === 'index' && view !== 'index') state.indexScrollY = window.scrollY;

    for (const name of Object.keys(els.views)) {
      els.views[name].hidden = name !== view;
    }
    state.view = view;
    els.filterBar.hidden = view !== 'index' && view !== 'error';
    document.title = title + ' \u00b7 ' + SITE_NAME;

    if (!state.firstRoute && previous !== view) {
      window.scrollTo(0, view === 'index' ? state.indexScrollY : 0);
    }
    // Move focus to the view heading only when the previous focus target is gone.
    // A failed data load is the exception: the page has nothing else to read, so
    // the error heading takes focus even on the first render.
    if (view === 'error' || (!state.firstRoute && focusWasLost())) {
      els.headings[view].focus({ preventScroll: true });
    }
    state.firstRoute = false;
  }

  // ---------- loading ----------

  function describeFailure(err) {
    if (err && err.status) {
      return { text: err.status + (err.statusText ? ' ' + err.statusText : ''), hint: false };
    }
    if (err instanceof SyntaxError) return { text: 'The file is not valid JSON', hint: false };
    if (err && err.shape) return { text: 'The file does not have the expected shape', hint: false };
    return { text: 'Network error: the request did not complete', hint: true };
  }

  function fail(err) {
    const info = describeFailure(err);
    els.errorUrl.textContent = DATA_URL;
    els.errorStatus.textContent = info.text;
    els.errorHint.hidden = !info.hint;
    els.loading.hidden = true;
    els.filterFields.disabled = true; // the bar stays visible but inert
    state.failed = true;
    state.ready = true;
    render();
  }

  function fetchData() {
    return fetch(DATA_URL).then((res) => {
      if (!res.ok) {
        const e = new Error('HTTP ' + res.status);
        e.status = res.status;
        e.statusText = res.statusText;
        throw e;
      }
      return res.json();
    }).then((data) => {
      const ok = data && typeof data === 'object' && Array.isArray(data.ghosts) &&
        data.meta && typeof data.meta.window === 'string' && Number.isInteger(data.meta.ghost_count);
      if (!ok) {
        const e = new Error('unexpected shape');
        e.shape = true;
        throw e;
      }
      return data;
    });
  }

  function init(data) {
    state.meta = data.meta;
    const sorted = data.ghosts.slice().sort((a, b) => {
      if (a.last_seen !== b.last_seen) return a.last_seen < b.last_seen ? -1 : 1;
      if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
      return 0;
    });
    const fragment = document.createDocumentFragment();
    for (const g of sorted) {
      const entry = buildCard(g);
      state.entries.push(entry);
      state.byDomain.set(entry.key, entry);
      fragment.appendChild(entry.li);
    }
    els.list.appendChild(fragment);
    buildFilterOptions();

    renderMetaLine(state.meta);
    els.loading.hidden = true;

    // Initial count text is set without an announcement.
    const initial = applyView();
    lastAnnounced = initial;

    state.ready = true;
    render();
  }

  // ---------- wiring ----------

  // The skip link would otherwise change the hash and trigger the router.
  els.skip.addEventListener('click', (event) => {
    event.preventDefault();
    els.main.focus();
  });
  els.more.addEventListener('click', showMore);
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(commitFilters, SEARCH_DELAY_MS);
  });
  for (const select of [els.tld, els.risk, els.rdap]) select.addEventListener('change', commitFilters);
  els.filterBar.addEventListener('submit', (event) => {
    event.preventDefault();
    commitFilters();
  });
  window.addEventListener('hashchange', render);

  fetchData().then(init, fail);
})();
