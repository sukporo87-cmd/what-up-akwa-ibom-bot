/* ============================================================
   FILE: src/views/admin-nav.js
   Shared admin navigation for every dashboard page.

   Why this exists: each admin page carried its own hand-rolled row
   of inline-styled links. They differed page to page, none of them
   wrapped properly on a phone (buttons ran off the right edge), and
   adding a page meant editing every other page by hand. New pages
   were simply missing from most of them.

   This file replaces all of that. Include it once per page:
       <script src="/admin-nav.js"></script>
   It injects its own styles, builds the nav, marks the current page
   active, and removes the legacy link rows so nothing is duplicated.

   Adding a page later = one line in NAV_ITEMS below, nothing else.
   ============================================================ */
(function () {
  'use strict';

  var NAV_ITEMS = [
    { href: '/admin',                   label: 'Main Admin',   icon: '🏠', color: '#6366f1', exact: true },
    { href: '/admin/dashboard',         label: 'Analytics',    icon: '📊', color: '#8b5cf6' },
    { href: '/admin/audit',             label: 'Audit Trail',  icon: '📝', color: '#10b981' },
    { href: '/admin/financials',        label: 'Financials',   icon: '💰', color: '#22c55e' },
    { href: '/admin/tournaments/manage',label: 'Tournaments',  icon: '🏆', color: '#eab308' },
    { href: '/admin/reviews',           label: 'Reviews',      icon: '⭐', color: '#f59e0b' },
    { href: '/admin/toggles',           label: 'Toggles',      icon: '🎚️', color: '#14b8a6' },
    { href: '/admin/messaging',         label: 'Messaging',    icon: '📨', color: '#f97316' },
    { href: '/admin/watchlist',         label: 'Watchlist',    icon: '🎯', color: '#ef4444' },
    { href: '/admin/challenges',        label: 'Challenges',   icon: '⚔️', color: '#ec4899' },
    { href: '/admin/content',           label: 'Site Content', icon: '✏️', color: '#3b82f6' },
    { href: '/admin/questions',         label: 'Questions',    icon: '❓', color: '#0ea5e9' },
    { href: '/admin/rotation',          label: 'Rotation',     icon: '🔄', color: '#a855f7' }
  ];

  var CSS = [
    /* A slim single-line bar: brand, one scrollable strip of sections,
       logout pinned right. Never wraps into a second row on desktop. */
    '#wutAdminNav{position:sticky;top:0;z-index:900;background:#0f1117;',
    '  border-bottom:1px solid rgba(255,255,255,.08);padding:0 16px;',
    '  box-shadow:0 2px 12px rgba(0,0,0,.3);font-family:inherit;',
    '  font-size:13px;line-height:1}',
    '#wutAdminNav .wan-row{display:flex;align-items:center;gap:10px;',
    '  max-width:1500px;margin:0 auto;height:46px}',
    '#wutAdminNav .wan-brand{font-weight:700;font-size:13px;color:#e8eaf0;',
    '  white-space:nowrap;display:flex;align-items:center;gap:6px;',
    '  padding-right:12px;margin-right:2px;border-right:1px solid rgba(255,255,255,.1);',
    '  flex-shrink:0;height:22px}',
    '#wutAdminNav .wan-links{display:flex;gap:2px;flex:1 1 auto;min-width:0;',
    '  overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}',
    '#wutAdminNav .wan-links::-webkit-scrollbar{display:none}',
    '#wutAdminNav a.wan-link{display:inline-flex;align-items:center;gap:6px;',
    '  padding:7px 11px;border-radius:7px;font-size:13px;font-weight:500;',
    '  text-decoration:none;color:#98a2b8;background:transparent;',
    '  border:0;white-space:nowrap;transition:color .12s,background .12s;',
    '  position:relative}',
    '#wutAdminNav a.wan-link .wan-ic{font-size:13px;opacity:.85}',
    '#wutAdminNav a.wan-link:hover{color:#fff;background:rgba(255,255,255,.07)}',
    '#wutAdminNav a.wan-link.active{color:#fff;background:rgba(255,255,255,.1);font-weight:600}',
    '#wutAdminNav a.wan-link.active::after{content:"";position:absolute;left:11px;right:11px;',
    '  bottom:-13px;height:2px;border-radius:2px;background:currentColor}',
    '#wutAdminNav .wan-logout{flex-shrink:0;padding:6px 12px;border-radius:7px;',
    '  font-size:12.5px;font-weight:600;cursor:pointer;color:#f2a2a8;',
    '  background:transparent;border:1px solid rgba(239,68,68,.35);',
    '  font-family:inherit;transition:all .12s}',
    '#wutAdminNav .wan-logout:hover{background:rgba(239,68,68,.16);color:#fff;',
    '  border-color:rgba(239,68,68,.6)}',
    '#wutAdminNav .wan-toggle{display:none}',
    /* --- phones: two-per-row grid, nothing runs off the edge --- */
    '@media(max-width:820px){',
    '  #wutAdminNav{padding:0 10px}',
    '  #wutAdminNav .wan-row{height:44px;flex-wrap:wrap;gap:8px}',
    '  #wutAdminNav .wan-toggle{display:inline-flex;align-items:center;gap:7px;',
    '    margin-left:auto;padding:7px 12px;border-radius:7px;font-size:12.5px;',
    '    font-weight:600;cursor:pointer;color:#dbe2ef;background:rgba(255,255,255,.08);',
    '    border:1px solid rgba(255,255,255,.14);font-family:inherit}',
    '  #wutAdminNav .wan-links{display:none;width:100%;order:3;overflow:visible}',
    '  #wutAdminNav.open{padding-bottom:10px}',
    '  #wutAdminNav.open .wan-row{height:auto;padding-top:8px}',
    '  #wutAdminNav.open .wan-links{display:grid;grid-template-columns:1fr 1fr;gap:4px}',
    '  #wutAdminNav a.wan-link{justify-content:flex-start;padding:10px 11px;',
    '    min-width:0;overflow:hidden;text-overflow:ellipsis;background:rgba(255,255,255,.05)}',
    '  #wutAdminNav a.wan-link.active::after{display:none}',
    '  #wutAdminNav.open .wan-logout{order:4;width:100%;margin-left:0}',
    '  #wutAdminNav:not(.open) .wan-logout{display:none}',
    '}',
    '@media(max-width:400px){#wutAdminNav.open .wan-links{grid-template-columns:1fr}}',
    /* legacy inline nav rows are hidden rather than fought with */
    '.wan-legacy-hidden{display:none !important}'
  ].join('\n');

  // The nav is for signed-in admins. On the login screen there is nothing to
  // navigate to, so it must stay out of the way entirely.
  function isSignedIn() {
    var token;
    try {
      token = localStorage.getItem('adminSessionToken') || localStorage.getItem('adminToken');
    } catch (e) { token = null; }
    if (!token) return false;
    // admin.html keeps both screens in the DOM and toggles them
    var login = document.getElementById('loginPage');
    if (login) {
      var visible = login.offsetParent !== null ||
                    (login.style.display && login.style.display !== 'none');
      if (visible) return false;
    }
    return true;
  }

  function currentPath() {
    return location.pathname.replace(/\/+$/, '') || '/admin';
  }

  function isActive(item) {
    var here = currentPath();
    return item.exact ? here === item.href : here === item.href;
  }

  function build() {
    if (document.getElementById('wutAdminNav')) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var nav = document.createElement('nav');
    nav.id = 'wutAdminNav';
    nav.setAttribute('aria-label', 'Admin sections');

    var links = NAV_ITEMS.map(function (it) {
      var active = isActive(it);
      return '<a class="wan-link' + (active ? ' active' : '') + '" href="' + it.href + '"' +
             (active ? ' style="color:' + it.color + ';background:rgba(255,255,255,.1)" aria-current="page"' : '') +
             '><span class="wan-ic" aria-hidden="true">' + it.icon + '</span>' + it.label + '</a>';
    }).join('');

    nav.innerHTML =
      '<div class="wan-row">' +
        '<span class="wan-brand">🎮 <span>WUT Admin</span></span>' +
        '<button type="button" class="wan-toggle" aria-expanded="false">☰ Menu</button>' +
        '<div class="wan-links">' + links + '</div>' +
        '<button type="button" class="wan-logout">🚪 Logout</button>' +
      '</div>';

    document.body.insertBefore(nav, document.body.firstChild);

    var toggle = nav.querySelector('.wan-toggle');
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.innerHTML = open ? '✕ Close' : '☰ Menu';
    });

    nav.querySelector('.wan-logout').addEventListener('click', function () {
      // Each page defines its own logout(); fall back to clearing the
      // session token ourselves if it doesn't.
      if (typeof window.logout === 'function') return window.logout();
      try {
        localStorage.removeItem('adminSessionToken');
        localStorage.removeItem('adminToken');
      } catch (e) {}
      location.href = '/admin';
    });
  }

  // Remove the old hand-rolled link rows so the page doesn't show two navs.
  // Only anchors pointing at admin pages are touched — buttons, platform
  // filters and everything else are left exactly as they were.
  function stripLegacyNav() {
    var known = {};
    NAV_ITEMS.forEach(function (i) {
      known[i.href] = 1;
      // some pages link to the raw file (/admin-audit) rather than the route
      known[i.href.replace('/admin/', '/admin-')] = 1;
    });

    var parents = [];
    Array.prototype.forEach.call(document.querySelectorAll('a[href^="/admin"]'), function (a) {
      if (a.closest('#wutAdminNav')) return;
      var href = (a.getAttribute('href') || '').replace(/\/+$/, '');
      if (!known[href]) return;
      var parent = a.parentElement;
      if (parents.indexOf(parent) === -1) parents.push(parent);
      a.classList.add('wan-legacy-hidden');
    });

    // If a container held nothing but those links, hide the container too,
    // so no empty box is left behind.
    parents.forEach(function (p) {
      var meaningful = Array.prototype.filter.call(p.children, function (c) {
        return !c.classList.contains('wan-legacy-hidden');
      });
      if (meaningful.length === 0) p.classList.add('wan-legacy-hidden');
    });
  }

  function init() {
    if (!isSignedIn()) {
      // Poll briefly: admin.html logs in without a page reload, so the nav
      // should appear the moment the dashboard does.
      var tries = 0;
      var timer = setInterval(function () {
        if (isSignedIn()) { clearInterval(timer); build(); stripLegacyNav(); }
        else if (++tries > 600) clearInterval(timer);   // ~10 minutes, then stop
      }, 1000);
      return;
    }
    build();
    stripLegacyNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();