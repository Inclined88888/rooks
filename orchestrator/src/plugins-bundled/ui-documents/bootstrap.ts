/**
 * The script the daemon injects into a `bridge: 'timon'` document (ADR-MCPUI
 * D4, D5): the MCP Apps handshake, the host's theme, the height the card
 * follows, `document.cookie` neutralised, and `Escape` as a way out.
 *
 * `window.timon` gives an agent writing HTML by hand the four calls of the
 * spec it needs — `submit(value)` (`tools/call` of the `submit` tool),
 * `message(text)` (`ui/message`), `openLink(url)` (`ui/open-link`),
 * `fullscreen(on)` (`ui/request-display-mode`) — and a click on a link goes
 * to `ui/open-link` rather than navigate the frame away from its page.
 *
 * It lives INSIDE the document, which can overwrite it: it is a convenience,
 * never a boundary. The host revalidates every message it receives and asks
 * the owner before anything leaves.
 */
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

export const UI_DOCUMENT_BOOTSTRAP = `(function () {
  'use strict';
  var host = window.parent;
  if (!host || host === window) return;
  var nextId = 1;
  var waiting = {};
  function post(message) { host.postMessage(message, '*'); }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params }); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }
  function applyContext(context) {
    if (!context || typeof context !== 'object') return;
    var root = document.documentElement;
    if (context.theme === 'dark' || context.theme === 'light') {
      root.style.colorScheme = context.theme;
      root.setAttribute('data-theme', context.theme);
    }
    var vars = context.styles && context.styles.variables;
    if (vars && typeof vars === 'object') {
      for (var key in vars) {
        if (/^--[a-z0-9-]+$/i.test(key) && typeof vars[key] === 'string') root.style.setProperty(key, vars[key]);
      }
    }
    if (context.displayMode === 'inline' || context.displayMode === 'fullscreen') setDisplayMode(context.displayMode);
  }
  window.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var m = event.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.method === undefined && m.id != null && waiting[m.id]) {
      var w = waiting[m.id];
      delete waiting[m.id];
      if (m.error) w.reject(m.error); else w.resolve(m.result);
    } else if (m.method === 'ui/notifications/host-context-changed') {
      applyContext(m.params);
    } else if ((m.method === 'ping' || m.method === 'ui/resource-teardown') && m.id != null) {
      if (m.method === 'ui/resource-teardown') {
        try { window.dispatchEvent(new Event('timon:teardown')); } catch (e) {}
      }
      post({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  });
  function failed(result) {
    if (result && result.isError) {
      var text = result.content && result.content[0] && result.content[0].text;
      throw new Error(typeof text === 'string' ? text : 'refused by the host');
    }
    return result;
  }
  function submit(value) {
    return request('tools/call', { name: 'submit', arguments: value }).then(failed).then(function (result) {
      return result && result.structuredContent;
    });
  }
  function message(text) {
    return request('ui/message', { role: 'user', content: [{ type: 'text', text: String(text) }] }).then(failed).then(function () {});
  }
  function openLink(url) {
    return request('ui/open-link', { url: String(url) }).then(failed).then(function () {});
  }
  function fullscreen(on) {
    return request('ui/request-display-mode', { mode: on === false ? 'inline' : 'fullscreen' }).then(function (result) {
      return result && result.mode;
    });
  }
  // A link would navigate the frame itself (no popup, no top navigation in
  // the sandbox), and a frame that left its page is unmounted by the card.
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    event.preventDefault();
    openLink(link.href).catch(function () {});
  });
  try {
    Object.defineProperty(document, 'cookie', { configurable: true, get: function () { return ''; }, set: function () {} });
  } catch (e) {}
  var lastHeight = 0;
  var displayMode = 'inline';
  var started = false;
  var startHeight = 0;
  var droppedFloors = [];
  var VIEWPORT_LENGTH = /(-?[0-9]*\\.?[0-9]+)[sdl]?(vh|vb|vmin|vmax)(?![a-z0-9-])/gi;
  var CUSTOM_PROPERTY = /var\\(\\s*(--[a-z0-9_-]+)[^)]*\\)/gi;
  // A viewport length in px for a viewport of \`viewport\` px; null: none in this value.
  function atViewport(value, viewport) {
    if (!value) return null;
    var resolved = value.replace(CUSTOM_PROPERTY, function (all, name) {
      return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || all;
    });
    var found = false;
    var next = resolved.replace(VIEWPORT_LENGTH, function (all, amount, unit) {
      found = true;
      // vmin/vmax: the card is wider than tall in practice, and what matters here is that it scales.
      return (parseFloat(amount) * viewport / 100) + 'px';
    });
    return found ? next : null;
  }
  function eachDeclaration(visit) {
    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].style) visit(rules[i].style, rules[i].selectorText);
        if (rules[i].cssRules) walk(rules[i].cssRules);
      }
    }
    var sheets = document.styleSheets || [];
    for (var s = 0; s < sheets.length; s++) {
      try { walk(sheets[s].cssRules); } catch (e) {}
    }
    var styled = document.querySelectorAll ? document.querySelectorAll('[style]') : [];
    for (var n = 0; n < styled.length; n++) visit(styled[n].style);
  }
  function applies(selector) {
    if (!selector) return true;
    try { return !!document.querySelector(selector); } catch (e) { return true; }
  }
  function set(entries, entry, value) {
    entries.push(entry);
    entry.style.setProperty(entry.property, value, entry.priority);
  }
  function restore(entries) {
    for (var i = entries.length - 1; i >= 0; i--) entries[i].style.setProperty(entries[i].property, entries[i].value, entries[i].priority);
  }
  // A viewport unit resolves against the iframe, whose height IS what this
  // script reports: \`body { min-height: 100vh }\` plus its margin asks for
  // more at every round trip, up to the host's ceiling (#648). A floor on the
  // viewport means nothing in a card that follows its content, so it goes for
  // as long as the card is inline: dropped for the read alone, the layout
  // would still overflow by the margin, hence a scrollbar.
  function dropFloors() {
    eachDeclaration(function (style) {
      ['min-height', 'min-block-size'].forEach(function (property) {
        var value = style.getPropertyValue(property);
        var next = atViewport(value, 0);
        if (next === null) return;
        set(droppedFloors, { style: style, property: property, value: value, priority: style.getPropertyPriority(property) }, next);
      });
    });
  }
  // A height on the viewport stays: a child may fill it. What it costs is read
  // as a slope, by laying the page out once more as if the viewport were twice
  // as tall.
  function viewportHeights() {
    var found = [];
    eachDeclaration(function (style, selector) {
      ['height', 'block-size'].forEach(function (property) {
        var value = style.getPropertyValue(property);
        if (atViewport(value, 0) === null || !applies(selector)) return;
        found.push({ style: style, property: property, value: value, priority: style.getPropertyPriority(property) });
      });
    });
    return found;
  }
  function read(root) {
    return root.getBoundingClientRect().height;
  }
  function contentHeight(root) {
    var viewport = window.innerHeight || 0;
    var natural = read(root);
    var heights = viewportHeights();
    if (!heights.length) return natural;
    // A frame not laid out yet has no viewport: a page on it reads as empty,
    // and reported, that would fold the card to its floor. Its first layout
    // wakes the observer.
    if (!viewport) return null;
    var changed = [];
    heights.forEach(function (entry) { set(changed, entry, atViewport(entry.value, 2 * viewport)); });
    var doubled = read(root);
    restore(changed);
    var slope = (doubled - natural) / viewport;
    // Below 1, the round trips settle where the page is as tall as its frame: go there at once.
    if (slope < 0.98) return Math.max(0, (natural - slope * viewport) / (1 - slope));
    // At 1 or more they never settle: the page is meant to fill its frame. It
    // gets the height it was first shown at, or its content when that is taller.
    changed = [];
    heights.forEach(function (entry) { set(changed, entry, 'auto'); });
    var content = read(root);
    restore(changed);
    return Math.max(content, startHeight);
  }
  function setDisplayMode(mode) {
    if (mode === displayMode) return;
    displayMode = mode;
    // Full screen does not follow the content: there, 100vh means what its author meant.
    if (mode === 'fullscreen') { restore(droppedFloors); droppedFloors = []; } else if (started) measure();
  }
  // The root's scrollHeight never drops below the viewport, which IS the
  // iframe's current height: a document that shrinks would never shrink its
  // card. Its box, laid out at max-content for the time of one read, can.
  function measure() {
    if (displayMode === 'fullscreen') return;
    if (!startHeight) startHeight = window.innerHeight || 0;
    var root = document.documentElement;
    try { dropFloors(); } catch (e) {}
    var previous = root.style.height;
    root.style.height = 'max-content';
    var height;
    try { height = contentHeight(root); } catch (e) { height = read(root); }
    root.style.height = previous;
    if (height === null) return;
    height = Math.ceil(height);
    if (height === lastHeight) return;
    lastHeight = height;
    notify('ui/notifications/size-changed', { width: Math.ceil(root.scrollWidth), height: height });
  }
  // Bubble phase on window: a document that handles Escape itself (closing its own menu) calls preventDefault first.
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    var active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    try { host.focus(); } catch (e) {}
  });
  var ready = request('ui/initialize', {
    protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}',
    appInfo: { name: 'timon-document', version: '1' },
    appCapabilities: {}
  }).then(function (result) {
    applyContext(result && result.hostContext);
    notify('ui/notifications/initialized', {});
    function start() {
      started = true;
      measure();
      if (typeof ResizeObserver === 'function') {
        var observer = new ResizeObserver(measure);
        observer.observe(document.documentElement);
        if (document.body) observer.observe(document.body);
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    return result;
  });
  try {
    Object.defineProperty(window, 'timon', {
      configurable: true,
      value: Object.freeze({ ready: ready, submit: submit, message: message, openLink: openLink, fullscreen: fullscreen })
    });
  } catch (e) {}
})();`;
