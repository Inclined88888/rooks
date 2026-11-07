// Site rules for the agent's tab: the same rules as rooks_browser/policy.py (SitePolicy.check), so a site that is off
// limits to the agent is off limits for every request its tab makes, not only for pages it opens.
"use strict";

const net = require("node:net");

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return ""; }
}

function v4Private(h) {
  const [a, b] = h.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function v6Private(h) {
  const x = h.toLowerCase();
  if (x === "::1" || x === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Private(mapped[1]);
  const first = parseInt(x.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;  // fc00::/7 unique local, fe80::/10 link local
}

/** Same rule as receipts.is_local in Python: loopback, private, link local, *.local/.internal/.localhost, single labels. */
function isLocal(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  const kind = net.isIP(h);
  if (kind === 4) return v4Private(h);
  if (kind === 6) return v6Private(h);
  return !h.includes(".");
}

// fnmatch for host patterns: "*" any run of characters, "?" one character. Hosts have no other specials.
function globMatch(host, pattern) {
  const re = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(host);
}

function match(host, pattern) {
  let p = String(pattern || "").toLowerCase().trim();
  if (p.includes("://")) p = hostOf(p);
  if (p !== "*") p = p.split("/")[0].split(":")[0];
  if (!p) return false;
  if (p === "*" || host === p || globMatch(host, p)) return true;
  const bare = p.startsWith("*.") ? p.slice(2) : p;  // "example.com" covers subdomains; "*.example.com" covers example.com
  return host === bare || host.endsWith("." + bare);
}

/** [allowed, reason]: the same answers as SitePolicy.check. */
function check(policy, url) {
  let scheme = "";
  try { scheme = new URL(url).protocol.replace(":", "").toLowerCase(); } catch { return [false, "not a valid address"]; }
  if (["about", "data", "blob", "chrome-error", "devtools"].includes(scheme)) return [true, ""];
  if (!["http", "https", "file"].includes(scheme)) return [false, `${scheme}: URLs are not allowed`];
  const host = hostOf(url);
  const allow = policy.allow || [], deny = policy.deny || [];
  if (policy.block_private && (scheme === "file" || isLocal(host))) {
    return [false, `${host || "local files"}: private and local addresses are blocked in service mode`];
  }
  if (scheme === "file") return allow.length ? [false, "local files are not on the allow list"] : [true, ""];
  for (const p of deny) if (match(host, p)) return [false, `${host} is on the deny list (${p})`];
  if (allow.length && !allow.some((p) => match(host, p))) return [false, `${host} is not on the allow list (${allow.join(", ")})`];
  return [true, ""];
}

module.exports = { check, match, hostOf, isLocal };
