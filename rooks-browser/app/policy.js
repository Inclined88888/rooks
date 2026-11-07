// Site rules for the agent's tab: the same rules as rooks_browser/policy.py (SitePolicy.check), so a site that is off
// limits to the agent is off limits for every request its tab makes, not only for pages it opens.
"use strict";

const net = require("node:net");

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return ""; }
}

// Python's ipaddress: is_private or is_loopback or is_link_local. The ranges are its own lists (the IANA special
// purpose registries) with the same exceptions, so a receipt row says "local" for the same addresses on both sides.
const V4_PRIVATE = ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.0.170/31",
  "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32"];
const V4_EXCEPT = ["192.0.0.9/32", "192.0.0.10/32"];
const V6_PRIVATE = ["::1/128", "::/128", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10"];
const V6_EXCEPT = ["2001:1::1/128", "2001:1::2/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28"];

function v4Bits(h) {
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return null;
  return parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n);
}

function v6Bits(h) {
  let [head, tail] = h.split("::");
  const mapped = /^(.*?)(\d+\.\d+\.\d+\.\d+)$/.exec(tail ?? head);  // a dotted tail, as in ::ffff:1.2.3.4
  if (mapped) {
    const v4 = v4Bits(mapped[2]);
    if (v4 === null) return null;
    const hex = `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
    if (tail === undefined) head = mapped[1] + hex; else tail = mapped[1] + hex;
  }
  const hs = head ? head.split(":") : [], ts = tail ? tail.split(":") : [];
  if (hs.length + ts.length > 8 || (tail === undefined && hs.length !== 8)) return null;
  const groups = [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function inNet(bits, width, cidr) {
  const [addr, len] = cidr.split("/");
  const shift = BigInt(width - Number(len));
  return (bits >> shift) === ((width === 32 ? v4Bits(addr) : v6Bits(addr)) >> shift);
}

function v4Private(h) {
  const bits = v4Bits(h);
  return bits !== null && V4_PRIVATE.some((c) => inNet(bits, 32, c)) && !V4_EXCEPT.some((c) => inNet(bits, 32, c));
}

function v6Private(h) {
  const x = h.toLowerCase().replace(/%.*$/, "");  // a zone id (fe80::1%eth0) is not part of the address
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Private(mapped[1]);  // an IPv4-mapped address is as private as the IPv4 address in it
  const bits = v6Bits(x);
  return bits !== null && V6_PRIVATE.some((c) => inNet(bits, 128, c)) && !V6_EXCEPT.some((c) => inNet(bits, 128, c));
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

// Python's fnmatch.translate for host patterns: "*" any run of characters, "?" one character, "[abc]" one of these,
// "[!abc]" none of these, and a "[" with no closing "]" is a plain character, so a pattern means the same on both sides.
function globMatch(host, pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i++];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i;
      if (pattern[j] === "!") j += 1;
      if (pattern[j] === "]") j += 1;
      while (j < pattern.length && pattern[j] !== "]") j += 1;
      if (j >= pattern.length) { re += "\\["; continue; }
      let stuff = pattern.slice(i, j).replace(/\\/g, "\\\\");
      i = j + 1;
      if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
      else if (stuff[0] === "^" || stuff[0] === "[") stuff = "\\" + stuff;
      re += `[${stuff.replace(/^(\^?)\]/, "$1\\]")}]`;  // "[]]" is a plain "]" in Python; JavaScript needs it escaped
    } else re += c.replace(/[.+^${}()|\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$", "s").test(host);
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
