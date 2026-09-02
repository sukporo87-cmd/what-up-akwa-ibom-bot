/* ============================================================
   FILE: src/views/site/ticker.js
   The rolling news bar, shared by every page of the marketing site.

   WHY THIS IS ONE FILE AND NOT TWELVE
   Each site page carries its own copy of WUT_CONFIG and its own inline
   stylesheet. Adding a bar to all of them by hand would mean twelve
   copies of the same CSS drifting apart, and a thirteenth page shipping
   without it because somebody forgot. admin-nav.js already solved this
   exact problem on the dashboard side, and this follows it: include one
   line per page and nothing else.

       <script defer src="/ticker.js"></script>

   It injects its own styles, builds the bar, offsets the fixed header,
   and removes itself cleanly when there is nothing to say.

   BEHAVIOUR WORTH KNOWING
   * No announcements -> no bar at all. Not an empty strip, not a
     placeholder. A news bar with nothing in it is worse than no news bar,
     because it trains people to stop looking at it.
   * Text is set with textContent, never innerHTML. Announcement bodies
     are plain text by contract (see announcements.service.js) and this is
     the second half of that contract.
   * Pauses on hover and on keyboard focus, so a link is actually
     clickable rather than sliding out from under the cursor.
   * prefers-reduced-motion: no scrolling at all. The items cross-fade in
     place on a timer instead, which carries the same information without
     the movement.
   * The bar is dismissible, and a dismissal is remembered against the
     current set of announcements. Post something new and it comes back;
     leave the same three notices up for a week and someone who closed it
     is not nagged every page load.
   ============================================================ */
(function () {
  'use strict';

  var ENDPOINT = '/api/public/announcements';
  var POLL_MS = 120000;          // 2 minutes; the service caches for 60s
  var SECONDS_PER_ITEM = 7;      // scroll pace, and the fade dwell time
  var STORAGE_KEY = 'wut_ticker_dismissed';

  // Colours are pulled from the site's own custom properties where they
  // exist, so the bar inherits a theme change rather than needing one.
  var CSS = [
    '.wut-ticker{position:fixed;left:0;right:0;z-index:190;',
    '  background:linear-gradient(90deg,rgba(10,22,42,.97),rgba(14,30,54,.97));',
    '  border-bottom:1px solid rgba(212,175,55,.28);',
    '  box-shadow:0 6px 20px rgba(0,0,0,.28);',
    '  font-family:inherit;overflow:hidden;',
    '  transform:translateY(-100%);transition:transform .35s ease}',
    '.wut-ticker.in{transform:translateY(0)}',
    'body.theme-light .wut-ticker{background:linear-gradient(90deg,#12233B,#1b3253)}',

    '.wut-ticker-row{display:flex;align-items:stretch;height:38px;max-width:100%}',

    /* The standing label. Says what the bar IS, so a first-time visitor
       does not have to infer it from the fact that words are moving. */
    '.wut-ticker-tag{display:flex;align-items:center;gap:7px;flex-shrink:0;',
    '  padding:0 14px;background:rgba(212,175,55,.14);color:#F0C84B;',
    '  font-size:11.5px;font-weight:700;letter-spacing:.04em;',
    '  border-right:1px solid rgba(212,175,55,.25)}',
    '.wut-ticker-tag .dot{width:7px;height:7px;border-radius:50%;background:#F0C84B;',
    '  animation:wutTickerBlink 1.8s infinite}',
    '@keyframes wutTickerBlink{0%,100%{opacity:1}50%{opacity:.25}}',

    '.wut-ticker-view{position:relative;flex:1 1 auto;min-width:0;overflow:hidden;',
    '  display:flex;align-items:center}',

    /* --- scrolling mode --- */
    '.wut-ticker-track{display:flex;align-items:center;white-space:nowrap;',
    '  will-change:transform;animation:wutTickerScroll linear infinite}',
    '.wut-ticker-view:hover .wut-ticker-track,',
    '.wut-ticker-view:focus-within .wut-ticker-track{animation-play-state:paused}',
    '@keyframes wutTickerScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}',

    '.wut-ticker-item{display:inline-flex;align-items:center;gap:9px;',
    '  padding:0 26px;font-size:13.5px;color:#DCE6F5;text-decoration:none}',
    '.wut-ticker-item .pip{width:6px;height:6px;border-radius:50%;flex-shrink:0;',
    '  background:#8FA6C4}',
    '.wut-ticker-item .lbl{font-size:10.5px;font-weight:800;letter-spacing:.07em;',
    '  text-transform:uppercase;flex-shrink:0}',
    '.wut-ticker-item .txt{white-space:nowrap}',
    'a.wut-ticker-item:hover .txt{text-decoration:underline}',
    'a.wut-ticker-item:focus-visible{outline:2px solid #F0C84B;outline-offset:-3px;border-radius:4px}',

    /* Tones colour the pip and the label only. Four fixed classes, because
       an admin-typed string reaching a stylesheet is how that goes wrong. */
    '.wut-ticker-item.t-live .pip{background:#25D366}',
    '.wut-ticker-item.t-live .lbl{color:#25D366}',
    '.wut-ticker-item.t-alert .pip{background:#FF6B6B}',
    '.wut-ticker-item.t-alert .lbl{color:#FF6B6B}',
    '.wut-ticker-item.t-win .pip{background:#F0C84B}',
    '.wut-ticker-item.t-win .lbl{color:#F0C84B}',
    '.wut-ticker-item.t-info .pip{background:#6FA8FF}',
    '.wut-ticker-item.t-info .lbl{color:#6FA8FF}',

    '.wut-ticker-close{flex-shrink:0;width:38px;border:0;background:transparent;',
    '  color:#7E8FA8;font-size:17px;line-height:1;cursor:pointer;',
    '  border-left:1px solid rgba(255,255,255,.07)}',
    '.wut-ticker-close:hover{color:#fff;background:rgba(255,255,255,.06)}',
    '.wut-ticker-close:focus-visible{outline:2px solid #F0C84B;outline-offset:-3px}',

    /* --- reduced motion: cross-fade in place, no travel --- */
    '@media(prefers-reduced-motion:reduce){',
    '  .wut-ticker-track{animation:none;position:relative;width:100%}',
    '  .wut-ticker.fade .wut-ticker-track{display:block}',
    '  .wut-ticker.fade .wut-ticker-item{position:absolute;left:0;top:50%;',
    '    transform:translateY(-50%);opacity:0;transition:opacity .4s ease;',
    '    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '  .wut-ticker.fade .wut-ticker-item.on{opacity:1}',
    '  .wut-ticker{transition:none}',
    '}',

    '@media(max-width:640px){',
    '  .wut-ticker-row{height:34px}',
    '  .wut-ticker-tag{padding:0 10px;font-size:10.5px}',
    '  .wut-ticker-tag .word{display:none}',
    '  .wut-ticker-item{font-size:12.5px;padding:0 18px}',
    '  .wut-ticker-close{width:32px}',
    '}'
  ].join('');

  var reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var bar = null, fadeTimer = null, currentVersion = null;

  function injectStyles() {
    if (document.getElementById('wutTickerStyles')) return;
    var s = document.createElement('style');
    s.id = 'wutTickerStyles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* The header is position:fixed at var(--header-h). The bar sits directly
     under it and pushes the page content down by its own height, so nothing
     is hidden behind it and the hero does not jump when it arrives. */
  function applyOffset(height) {
    var headerH = 0;
    var header = document.querySelector('.site-header');
    if (header) headerH = header.offsetHeight || 0;

    if (bar) bar.style.top = headerH + 'px';
    document.body.style.paddingTop = height ? height + 'px' : '';
  }

  function dismissedVersion() {
    try { return sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function remember(version) {
    try { sessionStorage.setItem(STORAGE_KEY, version); } catch (e) { /* private mode */ }
  }

  function teardown() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
    document.body.style.paddingTop = '';
  }

  function buildItem(item) {
    // An announcement with a link is an anchor; one without is a span.
    // Wrapping plain text in an <a href="#"> to keep the markup uniform
    // would put a keyboard stop on something that does nothing.
    var el = document.createElement(item.url ? 'a' : 'span');
    el.className = 'wut-ticker-item t-' + (item.tone || 'info');

    if (item.url) {
      el.setAttribute('href', item.url);
      // Absolute links leave the site; relative ones stay on it.
      if (/^https?:\/\//i.test(item.url)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      }
    }

    var pip = document.createElement('span');
    pip.className = 'pip';
    el.appendChild(pip);

    if (item.label) {
      var lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = item.label;      // textContent, never innerHTML
      el.appendChild(lbl);
    }

    var txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = item.body;
    el.appendChild(txt);

    return el;
  }

  function render(items, version) {
    teardown();
    if (!items.length) return;

    injectStyles();

    bar = document.createElement('aside');
    bar.className = 'wut-ticker' + (reduced ? ' fade' : '');
    bar.setAttribute('aria-label', 'Announcements');

    var row = document.createElement('div');
    row.className = 'wut-ticker-row';

    var tag = document.createElement('div');
    tag.className = 'wut-ticker-tag';
    var dot = document.createElement('span'); dot.className = 'dot';
    var word = document.createElement('span'); word.className = 'word';
    word.textContent = 'Latest';
    tag.appendChild(dot); tag.appendChild(word);
    row.appendChild(tag);

    var view = document.createElement('div');
    view.className = 'wut-ticker-view';

    var track = document.createElement('div');
    track.className = 'wut-ticker-track';

    // A screen reader should get the announcements once, as a list, not as
    // a stream of duplicated marquee text. The visual duplication below is
    // hidden from the accessibility tree for that reason.
    items.forEach(function (it) { track.appendChild(buildItem(it)); });

    if (!reduced) {
      // The scroll animation translates the track by -50%, so the content
      // has to be there twice for the loop to be seamless. The second copy
      // is presentational only.
      var clone = document.createElement('div');
      clone.style.display = 'contents';
      clone.setAttribute('aria-hidden', 'true');
      items.forEach(function (it) {
        var c = buildItem(it);
        // A duplicated link is a duplicated tab stop. Keep the clone
        // visible and inert.
        if (c.tagName === 'A') c.setAttribute('tabindex', '-1');
        clone.appendChild(c);
      });
      track.appendChild(clone);
      track.style.animationDuration = (items.length * SECONDS_PER_ITEM * 2) + 's';
    }

    view.appendChild(track);
    row.appendChild(view);

    var close = document.createElement('button');
    close.className = 'wut-ticker-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide announcements');
    close.textContent = '\u00d7';
    close.onclick = function () { remember(version); teardown(); };
    row.appendChild(close);

    bar.appendChild(row);
    document.body.appendChild(bar);

    applyOffset(bar.offsetHeight);
    // Next frame, so the slide-down transition has a start state to move from.
    requestAnimationFrame(function () { bar.classList.add('in'); });

    if (reduced) startFade(track);
  }

  /* Reduced-motion mode: one item at a time, cross-faded. Same information,
     no travel. */
  function startFade(track) {
    var nodes = Array.prototype.slice.call(track.children);
    if (!nodes.length) return;
    var i = 0;
    nodes[0].classList.add('on');
    if (nodes.length === 1) return;
    fadeTimer = setInterval(function () {
      nodes[i].classList.remove('on');
      i = (i + 1) % nodes.length;
      nodes[i].classList.add('on');
    }, SECONDS_PER_ITEM * 1000);
  }

  function load() {
    var base = (window.WUT_CONFIG && window.WUT_CONFIG.API_BASE) || '';
    fetch(base + ENDPOINT)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !res.success) return;
        var items = res.items || [];
        var version = res.version || 'empty';

        if (version === currentVersion) return;      // nothing has changed
        currentVersion = version;

        // Someone closed this exact set of notices. Respect that until the
        // set changes.
        if (version === dismissedVersion()) { teardown(); return; }

        render(items, version);
      })
      .catch(function () {
        /* A news bar that cannot load is simply absent. Never an error state
           on a marketing page. */
      });
  }

  function init() {
    load();
    setInterval(load, POLL_MS);
    // The header height changes at breakpoints, so the offset is recomputed
    // rather than measured once at load.
    window.addEventListener('resize', function () {
      if (bar) applyOffset(bar.offsetHeight);
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
