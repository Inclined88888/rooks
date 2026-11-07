// The Workroom shell (docs/design/0003-workroom.md, package F1): one token set keyed on data-mode, a type scale that
// matches the Appearance slider, one page registry, no hardcoded shell palette, visible focus rings, one product name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read("../src/tokens.css");
const styles = read("../src/styles.css");
const appearance = read("../src/appearance.tsx");
const app = read("../src/App.tsx");

test("the type scale in tokens.css is the one the Appearance slider scales from (size 14 renders 14px)", () => {
  // appearance.tsx TEXT_TOKENS: [["--text-2xs", 10.5], ["--text-xs", 12], ...]
  const m = appearance.match(/const TEXT_TOKENS: \[string, number\]\[\] = \[([\s\S]*?)\];/);
  assert.ok(m, "TEXT_TOKENS present");
  const pairs = [...m[1].matchAll(/\["(--text-[a-z0-9]+)",\s*([\d.]+)\]/g)].map((x) => [x[1], Number(x[2])]);
  assert.ok(pairs.length >= 9);
  for (const [name, px] of pairs) {
    const def = tokens.match(new RegExp(`${name}:\\s*([\\d.]+)px;`));
    assert.ok(def, `${name} is defined in px in tokens.css`);
    assert.equal(Number(def[1]), px, `${name} base size matches the slider's base`);
  }
  assert.match(tokens, /--text-md:\s*14px;/);
});

test("Studio and Lamp are keyed on data-mode, with the breakpoints as tokens", () => {
  assert.match(tokens, /html\[data-mode="light"\]/);
  assert.match(tokens, /html\[data-mode="dark"\]/);
  for (const t of ["--color-bg", "--color-surface", "--color-ink", "--color-ink-muted", "--color-accent", "--color-on-accent", "--color-accent-text", "--color-accent-soft", "--color-live", "--color-success", "--color-warning", "--color-danger", "--color-code-bg", "--color-scrim"]) {
    assert.ok(tokens.includes(`${t}:`), t);
  }
  assert.match(tokens, /--bp-narrow:\s*900px/);
  assert.match(tokens, /--bp-wide:\s*1280px/);
  // the old short aliases stay so untouched pages keep working
  for (const a of ["--bg", "--panel", "--panel-2", "--panel-3", "--border", "--text", "--muted", "--faint", "--accent", "--accent-text", "--ok", "--warn", "--danger", "--code-bg", "--scrim"]) {
    assert.match(`${tokens}\n${styles}`, new RegExp(`${a}:\\s*var\\(--color-`), `${a} is an alias of a token`);
  }
  // the duplicate [data-theme=dark] alias block is gone: aliases are declared once
  assert.equal((styles.match(/--panel-2:\s*var\(--color-/g) || []).length, 1, "one alias block");
});

test("the signed in shell reads tokens only: no hardcoded palette, no dead rail, no global focus reset", () => {
  const css = strip(styles);
  assert.doesNotMatch(css, /--agents-/, "the .shell-agents palette block is gone");
  assert.doesNotMatch(css, /\.shell\.shell-agents\s*\{[^}]*#[0-9a-f]{3,8}/i);
  const shellBlock = css.slice(css.indexOf(".shell"), css.indexOf("/* ---- Controls"));
  assert.doesNotMatch(shellBlock, /\.(icon-rail|rail-btn|shell-rail|nav-row|nav-pin|sidebar-search|nav-link)\b/, "dead rail and sidebar CSS removed");
  assert.doesNotMatch(css, /^\s*:focus\s*\{\s*outline:\s*none;?\s*\}/m, "no global :focus { outline: none }");
  assert.match(tokens, /:focus-visible/, "the focus ring lives in tokens.css");
  assert.doesNotMatch(css, /\.shell-agents \.face-body/, "the face is themed by tokens, not fixed greys");
});

test("one page registry drives routes, rail, flyouts, the More sheet and the palette", () => {
  assert.ok(existsSync(new URL("../src/pages/registry.ts", import.meta.url)), "src/pages/registry.ts exists");
  assert.ok(!existsSync(new URL("../src/navOrder.ts", import.meta.url)), "navOrder.ts is deleted");
  assert.ok(!existsSync(new URL("../src/AgentsSidebar.tsx", import.meta.url)), "the sidebar became the Rail and the Chats column");
  assert.doesNotMatch(app, /const NAV: NavGroup\[\]/, "no hand written nav list in App.tsx");
  assert.doesNotMatch(app, /const RAIL:/, "no hand written rail list in App.tsx");
  assert.match(app, /from "\.\/pages\/registry"/);
  const registry = read("../src/pages/registry.ts");
  for (const path of ["/assistant", "/room", "/jobs", "/mail", "/calendar", "/tasks", "/knowledge", "/skills", "/files", "/notes", "/documents", "/sites", "/projects", "/settings", "/history", "/runs", "/appearance", "/terminal", "/teach", "/customize"]) {
    assert.ok(registry.includes(`path: "${path}"`), `${path} registered`);
  }
  for (const redirect of ['from: "/connect"', 'from: "/assistant-skills"', 'from: "/packs/*"', 'from: "/mcp"', 'from: "/welcome"']) assert.ok(registry.includes(redirect), redirect);
  for (const shell of ["./shell/Rail", "./shell/PresenceStrip", "./shell/StageHost", "./shell/MobileBar"]) assert.ok(app.includes(shell), shell);
});

test("the product is Rooks everywhere people see a name", () => {
  assert.match(read("../src/product.ts"), /PRODUCT = "Rooks"/);
  assert.match(read("../index.html"), /<title>Rooks<\/title>/);
  assert.match(read("../public/favicon.svg"), />R</);
  assert.doesNotMatch(read("../src/Palette.tsx"), />Rooks</, "the palette footer reads the product name, not a literal");
});

test("the primitives exist, use tokens only, and the sheet traps focus", () => {
  const ui = read("../src/ui/index.tsx");
  for (const c of ["Button", "IconButton", "Card", "Input", "Select", "Tabs", "Badge", "Chip", "Sheet", "ToastHost", "useToast", "Kbd", "EmptyState", "Stat", "Timeline", "Receipt", "ApprovalCard", "StageFrame", "Presence"]) {
    assert.match(ui, new RegExp(`export (function|const) ${c}\\b`), c);
  }
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /e\.key === "Escape"/);
  assert.match(ui, /Needs your OK/);
  const css = strip(read("../src/ui/ui.css"));
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hex colours in ui.css");
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/i, "no literal colours in ui.css");
  assert.match(css, /--color-live/, "the stage edge glows in the live colour");
});

test("the shell is themed by data-mode: 64px rail, presence strip, stage host, mobile bar below 900px", () => {
  const css = strip(read("../src/shell/shell.css"));
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hex colours in shell.css");
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/i, "no literal colours in shell.css");
  assert.match(tokens, /--rail-w:\s*64px/);
  assert.match(css, /grid-template-columns: var\(--rail-w\)/);
  assert.match(css, /@media \(max-width: 900px\)/, "the narrow breakpoint (same value as --bp-narrow)");
  assert.match(css, /@media \(min-width: 1281px\)|@media \(max-width: 1280px\)/, "the wide breakpoint (same value as --bp-wide)");
  const rail = read("../src/shell/Rail.tsx");
  assert.match(rail, /aria-label="Main"/);
  assert.match(rail, /aria-expanded/);
  const strip_ = read("../src/shell/PresenceStrip.tsx") + read("../src/shell/presence.ts");
  assert.match(strip_, /Quiet\. Watching mail and calendar\./);
  assert.match(strip_, /\/presence/);
  assert.match(strip_, /AssistantFace/);
  const stage = read("../src/shell/StageHost.tsx");
  assert.match(stage, /export function openStage/);
  assert.match(stage, /export function closeStage/);
  assert.match(stage, /BesideStage/);
  const bar = read("../src/shell/MobileBar.tsx");
  for (const w of ["Chat", "Room", "Jobs", "Needs you", "More"]) assert.ok(bar.includes(`"${w}"`) || bar.includes(`>${w}<`), w);
});

test("the chat keeps its list of chats and projects as a collapsible column with a keyboard path", () => {
  const list = read("../src/chat/ChatList.tsx");
  assert.match(list, /New chat/);
  assert.match(list, /Search chats/);
  assert.match(list, /Archive/);
  assert.match(list, /Delete/);
  assert.match(list, /Projects/);
  assert.match(list, /No chats yet/);
  const chat = ["../src/pages/Assistant.tsx", "../src/chat/Thread.tsx"].map(read).join("\n"); // the chat page is split (package F2)
  assert.match(chat, /<ChatList/);
  assert.doesNotMatch(chat, /role="main"/, "one main landmark: the shell's");
  assert.match(chat, /id="thread"/, "the skip link lands on the thread");
  assert.match(app, /skip-link/);
  const css = strip(read("../src/chat/chat.css"));
  assert.match(css, /:focus-visible/, "hover only actions get a keyboard path");
});
