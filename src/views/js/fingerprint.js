/* ============================================
   FILE: src/views/js/fingerprint.js
   Served at /js/fingerprint.js by the existing express.static(views) mount,
   the same way /admin-nav.js is.

   Collects components that describe the MACHINE and posts them to
   /web/auth/device. The server hashes them — this file never computes an id,
   because a client-computed id could simply be randomised per account.

   What this catches: one person, one machine, two accounts. Every strong
   component below is identical across a second browser profile, an incognito
   window, or a switch from Chrome to Edge on the same computer.

   What it does not catch: two different people on identical laptops. That is a
   false-positive risk, not a miss, which is why the server never links two
   accounts on a fingerprint alone.

   Everything is wrapped so a browser that blocks any single API degrades to
   one missing component rather than an exception.
   ============================================ */
(function (global) {
  'use strict';

  function safe(fn) {
    try {
      var value = fn();
      return (value === undefined || value === null) ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  /* A small FNV-1a so canvas and WebGL arrive as short tokens rather than
     kilobytes of base64. The server hashes again; this is only to keep the
     request small. */
  function shorten(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  /* STRONG — GPU, driver and font stack all feed the rasterised output. */
  function canvasToken() {
    return safe(function () {
      var c = document.createElement('canvas');
      c.width = 240; c.height = 60;
      var ctx = c.getContext('2d');
      if (!ctx) return '';
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('WhatsUp Trivia 0123456789', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('WhatsUp Trivia 0123456789', 4, 17);
      return shorten(c.toDataURL());
    });
  }

  /* STRONG — the GPU string is one of the most stable signals available. */
  function webglToken() {
    return safe(function () {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      var renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return shorten(String(vendor) + '~' + String(renderer));
    });
  }

  /* STRONG — physical display. */
  function screenToken() {
    return safe(function () {
      var s = global.screen || {};
      return [s.width, s.height, s.colorDepth, global.devicePixelRatio || 1].join('x');
    });
  }

  /* STRONG — core count and RAM tier. */
  function hardwareToken() {
    return safe(function () {
      var n = global.navigator || {};
      return [n.hardwareConcurrency || '', n.deviceMemory || ''].join('/');
    });
  }

  function collect() {
    var n = global.navigator || {};
    return {
      canvas: canvasToken(),
      webgl: webglToken(),
      screen: screenToken(),
      hardware: hardwareToken(),
      timezone: safe(function () {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      }),
      languages: safe(function () {
        return (n.languages && n.languages.length) ? n.languages.join(',') : n.language;
      }),
      platform: safe(function () { return n.platform; }),
      touch: safe(function () { return n.maxTouchPoints || 0; })
    };
  }

  /* Once per page load at most. The server throttles too, but there is no
     reason to make the request twice. */
  var sent = false;

  function send(headers) {
    if (sent) return Promise.resolve(false);
    sent = true;

    return fetch('/web/auth/device', {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: collect() })
    }).then(function (r) {
      return r.ok;
    }).catch(function () {
      /* Never surface this. It is a background integrity signal — a player
         whose browser blocks it should notice nothing at all. */
      return false;
    });
  }

  global.wutFingerprint = { collect: collect, send: send };

})(window);
