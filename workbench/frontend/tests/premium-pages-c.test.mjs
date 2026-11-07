// Premium pass, page package C (docs/design/0003-workroom.md, section 6, "Design system v3: restraint").
// Memory, Skills, Show me how, Automations, Research, Browser, Computer, Code, Terminal, Company, Team, Teammates,
// Meetings, Talk, the packs and the ask bar: built on the primitives, with a loading, an empty and an error state,
// no inline colour, no 3D flip, no type off the scale, and the Browser and Computer steps on the one Timeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Every page in this package, as the registry (or App.tsx, for the ask bar) loads it.
const PAGES = [
  "src/memory/Knowledge.tsx", "src/pages/Skills.tsx", "src/pages/Teach.tsx", "src/pages/Automations.tsx", "src/pages/Research.tsx",
  "src/pages/Browser.tsx", "src/pages/Computer.tsx", "src/pages/Code.tsx", "src/pages/TerminalPage.tsx", "src/pages/Company.tsx",
  "src/team/Team.tsx", "src/teammates/Teammates.tsx", "src/teammates/Channels.tsx", "src/teammates/Pages.tsx", "src/teammates/Vault.tsx",
  "src/teammates/Groups.tsx", "src/pages/Meetings.tsx", "src/pages/Talk.tsx", "src/pages/Packs.tsx", "src/pages/PackLegal.tsx",
  "src/pages/PackStudy.tsx", "src/pages/PackTrade.tsx", "src/pages/AskBar.tsx",
];
const FLOATING = new Set(["src/pages/AskBar.tsx"]); // a floating window, not a page in the shell
const NO_DATA = new Set(["src/pages/TerminalPage.tsx"]); // a live shell, nothing to load

// The page plus the local modules it pulls in from this package's folders, so a page split into parts is checked whole.
const OWN_DIRS = ["src/memory/", "src/team/", "src/teammates/", "src/packs/", "src/learn/", "src/pages/agents/", "src/v02/TriggerAutomations"];
function withParts(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(root + file)) return "";
  seen.add(file);
  const src = read(file);
  let all = src;
  for (const m of src.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
    const base = normalize(join(dirname(file), m[1]));
    for (const p of [base, `${base}.tsx`, `${base}.ts`]) {
      if (/\.(tsx|ts)$/.test(p) && existsSync(root + p) && OWN_DIRS.some((d) => p.startsWith(d))) all += "\n" + withParts(p, seen);
    }
  }
  return all;
}

const CODE = [
  ...PAGES, "src/v02/TriggerAutomations.tsx", "src/memory/FiledChip.tsx", "src/memory/GraphWalk.tsx", "src/memory/Improved.tsx",
  "src/memory/YourData.tsx", "src/team/LeadRuns.tsx", "src/packs/shared.tsx",
  ...(existsSync(root + "src/pages/agents") ? readdirSync(root + "src/pages/agents").filter((f) => /\.tsx?$/.test(f)).map((f) => `src/pages/agents/${f}`) : []),
];
const CSS = [
  "src/memory/memory.css", "src/learn/learn.css", "src/packs/packs.css", "src/team/team.css", "src/teammates/teammates.css",
  "src/skills.css", "src/code.css", "src/voice/voice.css",
  ...(existsSync(root + "src/pages/agents") ? readdirSync(root + "src/pages/agents").filter((f) => f.endsWith(".css")).map((f) => `src/pages/agents/${f}`) : []),
];
// Rules in shared sheets that belong to other pages' parts (the dictation button's live level ring is not a page here).
const NOT_OURS = /\.dictate-|\.home-/;
function rules(file) {
  return [...strip(read(file)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] })).filter((r) => !NOT_OURS.test(r.sel));
}

test("every page in package C is built on the Page primitive (the ask bar is a floating window)", () => {
  for (const f of PAGES) {
    if (FLOATING.has(f)) continue;
    const src = withParts(f);
    assert.match(src, /import \{[^}]*\bPage\b[^}]*\} from "(?:\.\.\/)+ui"/, `${f} imports Page from the primitives`);
    assert.match(src, /<Page\b/, `${f} renders <Page>`);
    assert.doesNotMatch(read(f), /className="page(?: |")/, `${f} still draws the old page frame`);
  }
});

test("every page that loads data has a loading, an empty and an error state from the primitives", () => {
  for (const f of PAGES) {
    if (NO_DATA.has(f) || FLOATING.has(f)) continue;
    const src = withParts(f);
    for (const p of ["Loading", "EmptyState", "ErrorState"]) assert.match(src, new RegExp(`<${p}\\b`), `${f} renders <${p}>`);
    assert.doesNotMatch(src, />Loading…</, `${f} still says Loading… as bare text`);
  }
  // the ask bar is one small window: its waiting state is a word, and nothing selected says so in plain words
  const ask = read("src/pages/AskBar.tsx");
  assert.match(ask, /role="status">Thinking…</);
  assert.match(ask, /Nothing selected/);
  assert.doesNotMatch(ask, /className="typing"/);
});

test("no inline hex colour, no inline style with a colour, and no spinner without words", () => {
  for (const f of CODE) {
    const src = read(f);
    assert.doesNotMatch(src, /["'`]#[0-9a-fA-F]{3,8}["'`]/, `${f} has an inline hex colour`);
    for (const m of src.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      assert.doesNotMatch(m[1], /\b(color|background|border|fill|stroke|boxShadow)\b|var\(--(color|accent|danger|ok|warn|text|muted)/i, `${f}: style={{${m[1]}}}`);
    }
    assert.doesNotMatch(src, /\bLoader2\b/, `${f} still shows a spinner icon`);
  }
});

test("the terminal's dark screen comes from the --screen tokens, not hex in the page", () => {
  const t = read("src/pages/TerminalPage.tsx");
  assert.doesNotMatch(t, /#[0-9a-fA-F]{6}\b/);
  assert.match(t, /--screen-/);
});

test("no 3D flip and no transform transition: the flashcard swaps faces at once", () => {
  for (const f of CSS) {
    for (const r of rules(f)) {
      assert.doesNotMatch(r.body, /transition[^;]*\btransform\b/, `${f} ${r.sel}: transform transition`);
      assert.doesNotMatch(r.body, /\b(perspective|backface-visibility|transform-style)\s*:/, `${f} ${r.sel}: 3D`);
      assert.doesNotMatch(r.body, /rotate[XY]?\(/, `${f} ${r.sel}: rotation`);
    }
  }
  const css = strip(read("src/packs/packs.css"));
  const inner = css.match(/\.pk-card-inner\s*\{([^}]*)\}/);
  if (inner) assert.doesNotMatch(inner[1], /transition|transform/);
  assert.doesNotMatch(read("src/pages/PackStudy.tsx"), /flipped/);
});

test("the pk-serif class is renamed; nothing in this package asks for the old display face", () => {
  for (const f of [...CODE, ...CSS]) assert.doesNotMatch(read(f), /pk-serif/, f);
});

test("type in this package's stylesheets is on the scale: 12/13/14/16/20/28, weights 400/500/600", () => {
  const SIZES = new Set([12, 13, 14, 16, 20, 28]);
  for (const f of CSS) {
    for (const r of rules(f)) {
      for (const m of r.body.matchAll(/font-size\s*:\s*([^;]+)/g)) {
        const v = m[1].trim().replace(/\s*!important$/, "");
        if (/^(inherit|1em|100%)$/.test(v) || /^var\(--text-[a-z0-9]+\)$/.test(v)) continue;
        const px = v.match(/^(\d+(?:\.\d+)?)px$/);
        assert.ok(px && SIZES.has(Number(px[1])), `${f} ${r.sel}: font-size ${v} is off the scale`);
      }
      for (const m of r.body.matchAll(/font-weight\s*:\s*([^;]+)/g)) {
        const v = m[1].trim();
        assert.ok(/^(400|500|600|normal|inherit|var\(--weight-[a-z]+\))$/.test(v), `${f} ${r.sel}: font-weight ${v}`);
      }
      assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b/, `${f} ${r.sel}: hex colour`);
      assert.doesNotMatch(r.body, /letter-spacing\s*:\s*var\(--track\)|text-transform\s*:\s*uppercase/, `${f} ${r.sel}: shouted label`);
    }
  }
});

test("the Browser and Computer step lists are the Timeline primitive", () => {
  for (const f of ["src/pages/Browser.tsx", "src/pages/Computer.tsx"]) {
    const src = withParts(f);
    assert.match(src, /<Timeline\b/, `${f} renders <Timeline>`);
    assert.match(src, /import \{[^}]*\bTimeline\b[^}]*\} from "(?:\.\.\/)+ui"/, `${f} imports Timeline`);
  }
});
