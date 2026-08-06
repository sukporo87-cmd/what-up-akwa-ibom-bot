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
    { href: '/admin/dashboard',  label: 'Dashboard',   icon: '📊', color: '#6366f1' },
    { href: '/admin',            label: 'Main Admin',  icon: '🏠', color: '#64748b', exact: true },
    { href: '/admin/questions',  label: 'Questions',   icon: '❓', color: '#0ea5e9' },
    { href: '/admin/financials', label: 'Financials',  icon: '💰', color: '#22c55e' },
    { href: '/admin/reviews',    label: 'Reviews',     icon: '⭐', color: '#f59e0b' },
    { href: '/admin/content',    label: 'Site Content',icon: '✏️', color: '#3b82f6' },
    { href: '/admin/tournaments/manage', label: 'Tournaments', icon: '🏆', color: '#eab308' },
    { href: '/admin/messaging',  label: 'Messaging',   icon: '📨', color: '#f97316' },
    { href: '/admin/watchlist',  label: 'Watchlist',   icon: '🎯', color: '#ef4444' },
    { href: '/admin/rotation',   label: 'Rotation',    icon: '🔄', color: '#a855f7' },
    { href: '/admin/audit',      label: 'Audit Trail', icon: '📝', color: '#10b981' }
  ];

  var CSS = [
    '#wutAdminNav{position:sticky;top:0;z-index:900;background:#12121a;',
    '  border-bottom:1px solid rgba(255,255,255,.09);padding:8px 14px;',
    '  box-shadow:0 4px 18px rgba(0,0,0,.35);font-family:inherit}',
    '#wutAdminNav .wan-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
    '  max-width:1400px;margin:0 auto}',
    '#wutAdminNav .wan-brand{font-weight:700;font-size:14px;color:#fff;margin-right:6px;',
    '  white-space:nowrap;display:flex;align-items:center;gap:6px}',
    '#wutAdminNav .wan-links{display:flex;gap:6px;flex-wrap:wrap;flex:1 1 auto}',
    '#wutAdminNav a.wan-link{display:inline-flex;align-items:center;gap:6px;',
    '  padding:8px 13px;border-radius:9px;font-size:13px;font-weight:600;',
    '  text-decoration:none;color:#cbd5e1;background:rgba(255,255,255,.06);',
    '  border:1px solid rgba(255,255,255,.09);white-space:nowrap;transition:all .15s}',
    '#wutAdminNav a.wan-link:hover{color:#fff;transform:translateY(-1px);',
    '  background:rgba(255,255,255,.12)}',
    '#wutAdminNav a.wan-link.active{color:#fff;border-color:transparent}',
    '#wutAdminNav .wan-logout{margin-left:auto;padding:8px 14px;border-radius:9px;',
    '  font-size:13px;font-weight:600;cursor:pointer;color:#fecaca;',
    '  background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.4)}',
    '#wutAdminNav .wan-logout:hover{background:rgba(239,68,68,.24);color:#fff}',
    '#wutAdminNav .wan-toggle{display:none}',
    /* --- phones: two-per-row grid, nothing runs off the edge --- */
    '@media(max-width:760px){',
    '  #wutAdminNav{padding:8px 10px}',
    '  #wutAdminNav .wan-row{gap:6px}',
    '  #wutAdminNav .wan-toggle{display:inline-flex;align-items:center;gap:7px;',
    '    margin-left:auto;padding:8px 12px;border-radius:9px;font-size:13px;',
    '    font-weight:600;cursor:pointer;color:#e2e8f0;background:rgba(255,255,255,.08);',
    '    border:1px solid rgba(255,255,255,.14)}',
    '  #wutAdminNav .wan-links{display:none;width:100%;order:3}',
    '  #wutAdminNav.open .wan-links{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
    '  #wutAdminNav a.wan-link{justify-content:flex-start;padding:10px 11px;font-size:12.5px;',
    '    min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '  #wutAdminNav.open .wan-logout{order:4;width:100%;margin-left:0;text-align:center}',
    '  #wutAdminNav:not(.open) .wan-logout{display:none}',
    '}',
    '@media(max-width:380px){#wutAdminNav.open .wan-links{grid-template-columns:1fr}}',
    /* legacy inline nav rows are hidden rather than fought with */
    '.wan-legacy-hidden{display:none !important}'
  ].join('\n');

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
             (active ? ' style="background:' + it.color + '" aria-current="page"' : '') +
             '><span aria-hidden="true">' + it.icon + '</span>' + it.label + '</a>';
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

  function init() { build(); stripLegacyNav(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
