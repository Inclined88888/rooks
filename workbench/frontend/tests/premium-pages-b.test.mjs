// Premium pass, page package B (docs/design/0003-workroom.md, section 6): the settings family, the advanced pages and
// the first impressions (Auth, Welcome) are built on the primitives, with loading, empty and error states, no inline
// colour, no spinner without words, and a stylesheet on the type scale. Regex guards on the source, like the other tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Pages people open from the rail, the More sheet or the palette: each is a <Page>.
const PAGES = ["Settings", "Models", "VoiceSettings", "McpServers", "Plan", "Privacy", "About", "Status",
  "Insights", "Runs", "Compare", "FineTune"];
// First impressions: one quiet card with one clear choice.
const COVERS = ["Auth", "Welcome"];
// Parts that live inside other screens.
const PARTS = ["pages/ModelSignIn.tsx", "pages/ConnectSection.tsx", "pages/PlanCard.tsx", "pages/Phone.tsx", "ProGate.tsx"];
const ALL = [...PAGES.map((p) => `pages/${p}.tsx`), ...COVERS.map((p) => `pages/${p}.tsx`), ...PARTS];

// What each page loads, and the states it must draw for it.
const STATES = {
  Settings: ["Loading", "ErrorState"],
  Models: ["Loading", "ErrorState", "EmptyState"],
  VoiceSettings: ["Loading", "ErrorState"],
  McpServers: ["Loading", "ErrorState", "EmptyState"],
  Plan: ["Loading", "ErrorState"],
  Status: ["Loading", "ErrorState"],
  Insights: ["Loading", "ErrorState", "EmptyState"],
  Runs: ["Loading", "ErrorState", "EmptyState"],
  Compare: ["EmptyState"],
  FineTune: ["Loading", "ErrorState", "EmptyState"],
};

test("every settings and advanced page is a Page from the primitives", () => {
  for (const p of PAGES) {
    const src = read(`pages/${p}.tsx`);
    assert.match(src, /<Page\b/, `${p} renders <Page>`);
    assert.match(src, /from "\.\.\/ui"/, `${p} imports the primitives`);
  }
});

test("Auth and Welcome are one quiet card: the AuthCard primitive", () => {
  assert.ok(existsSync(new URL("../src/pages/settings/AuthCard.tsx", import.meta.url)), "pages/settings/AuthCard.tsx exists");
  const card = read("pages/settings/AuthCard.tsx");
  assert.match(card, /export function AuthCard\b/);
  for (const p of COVERS) assert.match(read(`pages/${p}.tsx`), /<AuthCard\b/, `${p} uses <AuthCard>`);
  // one clear choice per screen: no wordmark repeated on every step, no decorative step dots
  const welcome = read("pages/Welcome.tsx");
  assert.doesNotMatch(welcome, /wordmark xl/, "Welcome does not repeat the big wordmark on each step");
  assert.doesNotMatch(welcome, /className="steps"/, "the step count is words, not dots");
});

test("pages that load data draw a loading, an empty and an error state", () => {
  for (const [p, want] of Object.entries(STATES)) {
    const src = read(`pages/${p}.tsx`);
    for (const s of want) assert.match(src, new RegExp(`<${s}\\b`), `${p} draws <${s}>`);
  }
  // the error state says what went wrong in plain words and offers Try again
  for (const [p, want] of Object.entries(STATES)) {
    if (!want.includes("ErrorState")) continue;
    assert.match(read(`pages/${p}.tsx`), /<ErrorState[^>]*onRetry=/, `${p}: the error state can try again`);
  }
});

test("no inline colour, no inline hex, no spinner without words, no old card and alert markup", () => {
  for (const f of ALL) {
    const src = read(f);
    assert.doesNotMatch(src, /["'\s:(]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/, `${f}: inline hex`);
    for (const m of src.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      assert.match(m[1], /^\s*(width|height):/, `${f}: style={{${m[1]}}} (only a measured width is inline)`);
      assert.doesNotMatch(m[1], /color|background|border|var\(--/i, `${f}: colour in style={{${m[1]}}}`);
    }
    assert.doesNotMatch(src, /className="[^"]*\bspin\b|Loader2/, `${f}: a spinner without words`);
    assert.doesNotMatch(src, /className="(card|alert)\b/, `${f}: old .card or .alert markup`);
    assert.doesNotMatch(src, /className="btn\b/, `${f}: old .btn markup (use Button)`);
  }
});

test("Settings is a calm settings app: a category list, a select on the phone, rows with help, a normal Password row", () => {
  const s = read("pages/Settings.tsx");
  const sections = read("pages/settings/sections.ts"); // shared with the command menu, which opens each section
  assert.match(s, /SETTINGS_SECTIONS as SECTIONS/);
  for (const id of ["general", "agents", "models", "tools", "skills", "apps", "appearance", "privacy", "advanced"]) assert.match(sections, new RegExp(`id: "${id}"`), id);
  assert.match(s, /<CategoryNav\b/, "the left category list");
  const nav = read("pages/settings/CategoryNav.tsx");
  assert.match(nav, /<Select\b/, "a select on the phone");
  assert.match(s, /<SettingRow\b/, "settings are rows: label, one line of help, the control on the right");
  assert.doesNotMatch(s, /<Shield\b/, "the Password section has no oversized icon");
  assert.match(s, /title="Password"/);
  assert.doesNotMatch(s, /cursor-settings/);
  // the endpoints stay
  for (const ep of ['"/settings"', '"/password"', '"/desktop/info"', '"/providers"', '"/ollama/status"', '"/usage"', '"/browser/pair/start"']) assert.ok(s.includes(ep), ep);
});

test("technical detail sits under Advanced", () => {
  const adv = read("pages/settings/Advanced.tsx");
  assert.match(adv, /<details\b/);
  assert.match(adv, /Advanced/);
  for (const f of ["pages/McpServers.tsx", "pages/Status.tsx", "pages/Settings.tsx"]) assert.match(read(f), /<Advanced\b/, `${f} keeps addresses under Advanced`);
  const mcp = read("pages/McpServers.tsx");
  // the command line or address of a tool is only in the Advanced part of its row
  assert.ok(mcp.indexOf("s.spec.args.join") > mcp.indexOf("<Advanced"), "the command line is inside Advanced");
});

test("the stylesheet is on the scale: sizes 12-28 tokens, weights 400/500/600, no hex, no card shadow, only the one fade", () => {
  const css = strip(read("pages/settings/settings.css"));
  for (const m of css.matchAll(/font-size:\s*([^;}]+)/g)) {
    const v = m[1].trim();
    const ok = /^var\(--text-(xs|sm|md|lg|xl|2xl)\)$/.test(v) || /^(12|13|14|16|20|28)px$/.test(v) || v === "inherit";
    assert.ok(ok, `font-size ${v} is off the scale`);
  }
  for (const m of css.matchAll(/font-weight:\s*([^;}]+)/g)) {
    assert.match(m[1].trim(), /^(400|500|600|var\(--weight-(regular|medium|heading)\)|inherit)$/, `font-weight ${m[1]}`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "colours are tokens");
  for (const m of css.matchAll(/box-shadow:\s*([^;}]+)/g)) assert.match(m[1].trim(), /^(none|var\(--shadow-float\))$/, "no shadows on cards and panels; only the floating one");
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) assert.match(m[1], /ui-fade|none/);
  for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
    assert.match(m[1].trim(), /^(var\(--radius-(sm|md|full)\)|6px|10px|50%|0)$/, `radius ${m[1]}`);
  }
  for (const m of css.matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)px\)/g)) assert.ok(["900", "1280"].includes(m[1]), `breakpoint ${m[1]}`);
});

test("the old off-scale rules these pages used are gone from the shared stylesheets", () => {
  const styles = strip(read("styles.css"));
  const models = strip(read("models.css"));
  for (const sel of [".cursor-settings", ".cursor-customize", ".cursor-chip", ".insights-stats", ".phone-code", ".welcome-option", ".auth-brand", ".settings-more"]) assert.ok(!styles.includes(sel), `styles.css: ${sel}`);
  for (const sel of [".tier-strip", ".route-n", ".route-name", ".sub-name", ".free-card", ".welcome-title", ".tag-rec", ".device-code", ".models-page .lede"]) {
    assert.ok(!models.includes(sel), `models.css: ${sel}`);
  }
});

test("the functions and words other tests rely on are kept", () => {
  const settings = read("pages/Settings.tsx");
  assert.match(settings, /export function Providers\b/);
  const signin = read("pages/ModelSignIn.tsx");
  for (const e of ["KeyField", "ChatGPTCard", "SignInWithPlan", "AddKey", "WebSearchSetup", "KEY_ORDER"]) assert.match(signin, new RegExp(`export (function|const) ${e}\\b`), e);
  assert.match(read("pages/Welcome.tsx"), /export function AccountsStep\b/);
  assert.match(read("pages/Plan.tsx"), /export function AccountSetup\b/);
  assert.match(read("pages/Plan.tsx"), /export function SignIn\b/);
  assert.match(read("pages/Phone.tsx"), /export function PhoneCard\b/);
  assert.match(read("pages/VoiceSettings.tsx"), /export function PlanBadge\b/);
  const pro = read("ProGate.tsx");
  for (const e of ["UpgradeCard", "ProGate", "UpgradePrompt", "AccountLayer"]) assert.match(pro, new RegExp(`export function ${e}\\b`), e);
});
