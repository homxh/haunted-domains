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
    detailBody: $('detail-body'),
    notfoundText: $('notfound-text'),
    errorUrl: $('error-url'),
    errorStatus: $('error-status'),
    errorHint: $('error-hint'),
    status: $('status'),
  };

  const state = {
    meta: null,
    entries: [], // { g, li, link, key }, sorted by last_seen then domain
    byDomain: new Map(), // lower-case domain -> entry
    ready: false,
    failed: false,
    q: '',
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
    const q = state.q.toLowerCase();
    let matched = 0;
    let shown = 0;
    for (const entry of state.entries) {
      const hit = !q || entry.key.indexOf(q) !== -1;
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
    const countText = q
      ? 'Showing ' + fmt(shown) + ' of ' + fmt(matched) + ' matching'
      : 'Showing ' + fmt(shown) + ' of ' + fmt(total);
    els.count.textContent = countText;
    els.count.hidden = false;

    const none = matched === 0;
    els.list.hidden = none;
    els.empty.hidden = !none;
    if (none) els.emptyText.textContent = 'No ghosts match \u201c' + state.q + '\u201d.';

    const remaining = matched - shown;
    els.moreWrap.hidden = remaining <= 0;
    if (remaining > 0) els.more.textContent = 'Show ' + Math.min(PAGE_SIZE, remaining) + ' more';

    return countText;
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

  // ---------- routing ----------

  // #/            graveyard index
  // #/?q=term     index filtered by domain name
  // #/<domain>    ghost detail
  function parseRoute() {
    const raw = window.location.hash.replace(/^#/, '');
    if (raw === '' || raw === '/') return { type: 'index', q: '' };
    const cut = raw.indexOf('?');
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const query = cut === -1 ? '' : raw.slice(cut + 1);
    if (path === '' || path === '/') {
      return { type: 'index', q: (new URLSearchParams(query).get('q') || '').trim() };
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
        if (route.q !== state.q) {
          state.q = route.q;
          state.limit = PAGE_SIZE;
          announce(applyView());
        }
        heading = route.q ? 'Search results for \u201c' + route.q + '\u201d' : 'The graveyard';
        title = route.q ? 'Search \u201c' + route.q + '\u201d' : 'The graveyard';
        els.headings.index.textContent = heading;
      } else {
        const entry = state.byDomain.get(route.name.toLowerCase());
        if (entry) {
          view = 'detail';
          els.headings.detail.textContent = entry.g.domain;
          els.detailBody.textContent = 'The full record for this ghost is coming in the next release.';
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
  window.addEventListener('hashchange', render);

  fetchData().then(init, fail);
})();
