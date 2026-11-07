// What the address bar makes of what you typed: an address as it is, a site name (https first, plain http only for a
// computer on this network, which has no certificate), or a search.
"use strict";

const policy = require("./policy.js");

const HOME = "about:blank";

function normalise(raw) {
  const s = String(raw || "").trim();
  if (!s) return HOME;
  if (/^(https?|file|about|data):/i.test(s)) return s;
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/i.test(s)
    || /^\[[0-9a-f:.]+\](:\d+)?(\/.*)?$/i.test(s);  // [::1]:8000
  if (looksLikeHost) return (policy.isLocal(policy.hostOf("http://" + s)) ? "http://" : "https://") + s;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(s);  // a search: DuckDuckGo keeps no search history
}

module.exports = { normalise, HOME };
