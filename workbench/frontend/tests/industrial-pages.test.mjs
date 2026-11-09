// The industrial redesign, step 4 (CHANGELOG "Unreleased · Industrial redesign"): every feature area's stylesheet and
// components in the spec's language. Square everything, hairlines instead of shadows, fixed words as mono micro-labels
// beside an orange square, fixed titles in the condensed uppercase face (a person's own words keep their case), the
// current item marked by a thin orange edge, the numbers the app already shows as a stat strip (huge numbers, a tiny
// mono label below, 1 px dividers), charts in black, grey and orange with thin lines. Routes, calls and words stay.
// Every test here failed on the tree before this step (scratchpad industrial/pages/fail-first.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (p) => strip(read(p));
function walk(dir, out = []) {
  for (const n of readdirSync(root + dir)) {
    const p = `${dir}/${n}`;
    if (statSync(root + p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out.sort();
}

/** The body of the first rule whose whole selector list is `sel` (outside or inside a media query). */
function body(sheet, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = sheet.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}
/** A fixed label: mono, uppercase, the micro tracking, the micro size. */
function micro(b, what) {
  assert.match(b, /font-family:\s*var\(--font-mono\)/, `${what}: mono`);
  assert.match(b, /text-transform:\s*uppercase/, `${what}: uppercase`);
  assert.match(b, /letter-spacing:\s*var\(--tracking-(micro|button)\)/, `${what}: tracked`);
  assert.match(b, /font-size:\s*var\(--text-micro(-sm)?\)/, `${what}: 10 to 11 px`);
}
/** A fixed title: the condensed display face, bold or extra bold, uppercase. */
function title(b, what) {
  assert.match(b, /font-family:\s*var\(--font-display\)/, `${what}: the display face`);
  assert.match(b, /font-weight:\s*var\(--weight-(bold|display)\)/, `${what}: bold`);
  assert.match(b, /font-stretch:\s*var\(--stretch-display\)/, `${what}: condensed`);
  assert.match(b, /text-transform:\s*uppercase/, `${what}: uppercase`);
}

const chat = css("src/chat/chat.css");
const styles = css("src/styles.css");
const needs = css("src/needs/needs.css");
const room = css("src/room/room.css");
const day = css("src/pages/day/day.css");
const settings = css("src/pages/settings/settings.css");
const team = css("src/team/team.css");
const memory = css("src/memory/memory.css");
const skills = css("src/skills.css");
const agents = css("src/pages/agents/agents.css");
const automations = css("src/pages/agents/automations.css");
const tokens = css("src/tokens.css");

/* ---------------------------------------------------------------- the whole sweep */

test("every feature stylesheet: uppercase only in the mono labels and the display titles, tracking from the tokens", () => {
  const sheets = walk("src").filter((f) => f.endsWith(".css") && f !== "src/tokens.css" && f !== "src/fonts.css");
  for (const f of sheets) {
    for (const m of css(f).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      const [sel, b] = [m[1].trim(), m[2]];
      if (/text-transform:\s*uppercase/.test(b)) {
        assert.match(b, /font-family:\s*var\(--font-(mono|display)\)/, `${f} ${sel}: uppercase words are mono labels or display titles`);
      }
      for (const t of b.matchAll(/letter-spacing:\s*([^;]+)/g)) {
        assert.match(t[1].trim(), /^(0|normal|var\(--tracking-[a-z]+\))$/, `${f} ${sel}: letter-spacing ${t[1].trim()} is a token`);
      }
    }
  }
});

test("no pills and no round dots left: every dot, tag and avatar is a square (the corner tokens are 0)", () => {
  for (const f of walk("src").filter((p) => p.endsWith(".css"))) {
    assert.doesNotMatch(css(f), /border-radius:\s*(50%|999px|\d+px)/, `${f}: a literal round corner`);
  }
  assert.doesNotMatch(read("src/util.tsx"), /borderRadius/, "the loading rows' avatar is square");
});

/* ---------------------------------------------------------------- chat */

test("chat: the chats column has micro-label groups, square dots and the current chat marked by a thin orange edge", () => {
  micro(body(chat, ".chatlist-label"), ".chatlist-label");
  micro(body(chat, ".chatlist-head"), ".chatlist-head");
  assert.match(body(chat, ".chatlist-row.is-active::before"), /width:\s*2px[^}]*background:\s*var\(--color-accent\)/s);
  const add = body(chat, ".chatlist-new");
  assert.match(add, /border:\s*var\(--line-ink\)/, "New chat is the secondary button: a 1 px ink edge");
  assert.match(add, /font-family:\s*var\(--font-mono\)/);
  const pop = body(chat, ".chatlist-pop");
  assert.match(pop, /border:\s*var\(--line-ink\)/, "the row menu floats with an ink edge");
  assert.doesNotMatch(pop, /shadow-float/);
});

test("chat: result cards are white with a hairline, a micro-label on top beside an orange square, and a thin divider inside", () => {
  const card = body(chat, ".chat-thread .result-card");
  assert.match(card, /border:\s*var\(--line\)/);
  assert.match(card, /background:\s*var\(--color-surface\)/);
  micro(body(chat, ".result-card-kicker"), ".result-card-kicker");
  assert.match(body(chat, ".result-card-kicker::before"), /background:\s*var\(--color-accent\)/);
  assert.match(body(chat, ".result-card-actions"), /border-top:\s*var\(--line\)/, "the thin divider");
  assert.match(body(chat, ".result-undo-ask"), /border-left:\s*2px solid var\(--color-warning\)/);
});

test("chat: the steps toggle and the notices are mono; the step marks square", () => {
  micro(body(chat, ".turn-steps-toggle"), ".turn-steps-toggle");
  assert.match(body(chat, ".turn-notice::before"), /background:\s*var\(--color-ink-faint\)/);
});

test("chat: a new chat is an empty-state hero: the greeting as a huge split headline on the blueprint grid", () => {
  const empty = body(chat, ".chat-empty");
  assert.match(empty, /background-image:\s*var\(--bg-grid\)/);
  const t = body(chat, ".chat-empty-title");
  title(t, ".chat-empty-title");
  assert.match(t, /font-size:\s*var\(--display-lg\)/);
  assert.match(body(chat, ".chat-empty-line"), /font-family:\s*var\(--font-mono\)/, "a small mono intro");
  const src = read("src/chat/EmptyChat.tsx");
  assert.match(src, /<Headline as="p" className="chat-empty-title" text=\{greeting\(new Date\(\)\.getHours\(\)\)\} \/>/, "the same words, split in two lines");
  assert.match(read("src/ui/index.tsx"), /as\?: "h1" \| "h2" \| "p"/);
});

test("a greeting of two sentences splits after the first one; the words never change", async () => {
  const out = await build({ entryPoints: [root + "src/ui/headline.ts"], bundle: true, format: "esm", platform: "node", write: false });
  const dir = root + "node_modules/.cache/wb-tests/";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "industrial-pages-headline.mjs", out.outputFiles[0].text);
  const { splitHeadline } = await import(pathToFileURL(dir + "industrial-pages-headline.mjs").href);
  assert.deepEqual(splitHeadline("Morning. What should we do first?"), ["Morning.", "What should we do first?"]);
  assert.deepEqual(splitHeadline("What should Atlas do?"), ["What should", "Atlas do?"], "one sentence still splits nearest the middle");
});

test("chat: the composer is square with a 1 px edge that turns ink on focus; the user's words sit on the muted surface", () => {
  assert.match(body(styles, ".composer:focus-within"), /border-color:\s*var\(--color-ink\)/);
  assert.match(body(styles, ".bubble-user"), /border:\s*var\(--line\)/);
  micro(body(styles, ".msg-byline"), ".msg-byline");
  micro(body(styles, ".code-head"), ".code-head");
});

/* ---------------------------------------------------------------- Needs you, the Room */

test("Needs you: the since line and the link are mono labels", () => {
  micro(body(needs, ".needs-item-since"), ".needs-item-since");
  micro(body(needs, ".needs-link"), ".needs-link");
  assert.doesNotMatch(body(needs, ".needs-link"), /accent-text/, "orange is a mark, not small words");
});

test("the Room: square windows with mono title bars and a hairline under them, the desk on the blueprint grid", () => {
  const t = body(room, ".room-window-title");
  assert.match(t, /font-family:\s*var\(--font-mono\)/);
  assert.match(t, /text-transform:\s*uppercase/);
  assert.match(body(room, ".room-window-bar"), /border-bottom:\s*var\(--line\)/);
  assert.match(body(room, ".room-desk"), /background-image:\s*var\(--bg-grid\)/);
  assert.match(body(room, ".room-bar"), /border:\s*var\(--line\)/);
  // a pressed dock item or mode: an ink edge, never an inset shadow and never the primary fill
  assert.match(body(room, '.room-dock-item .ui-btn[aria-pressed="true"]'), /border-color:\s*var\(--color-ink\)/);
  assert.match(body(room, '.room-modes .ui-btn[aria-pressed="true"]'), /border-color:\s*var\(--color-ink\)/);
  // the terminal keeps its own dark screen colours
  assert.match(body(room, ".room-term-box"), /background:\s*var\(--screen-bg\)/);
  assert.match(body(room, ".room-tail"), /color:\s*var\(--screen-ink\)/);
  micro(body(room, ".room-stale, .room-hint"), ".room-stale");
});

/* ---------------------------------------------------------------- the day and library pages */

test("Jobs and History: column heads in the display face, kinds as mono labels, square marks", () => {
  title(body(day, ".job-col-head h2"), ".job-col-head h2");
  micro(body(day, ".job-kind"), ".job-kind");
  micro(body(day, ".job-col-head .job-count"), ".job-count");
  assert.match(body(day, ".job-empty"), /border:\s*var\(--line\)/, "a hairline, not a dashed edge");
  micro(body(day, ".day-history-day .ui-section-title"), "the day's heading");
});

test("Mail, Files and Library: the split's pane line is a border (no gradient), the drop area is blueprint with a solid line", () => {
  assert.doesNotMatch(body(day, ".day-split"), /gradient/);
  assert.match(body(day, ".day-split-list"), /border-right:\s*var\(--line\)/);
  title(body(day, ".day-detail-title"), ".day-detail-title");
  const drop = body(day, ".day-drop");
  assert.match(drop, /background-image:\s*var\(--bg-grid\)/);
  assert.doesNotMatch(drop, /dashed/);
  micro(body(day, ".day-kicker"), ".day-kicker");
  micro(body(day, ".day-table th"), ".day-table th");
});

test("Calendar and Tasks: mono weekday heads, the selected day an ink outline (not a shadow), square ticks and swatches", () => {
  micro(body(day, ".day-dow"), ".day-dow");
  assert.match(body(day, ".day-cell.is-selected"), /outline:\s*2px solid var\(--color-ink\)/);
  title(body(day, ".day-cal-name"), ".day-cal-name");
  assert.match(body(day, ".day-tick"), /border:\s*var\(--border-w\) solid var\(--color-ink\)/);
  assert.match(body(day, ".day-swatch input:checked + .day-swatch-mark"), /outline:\s*2px solid var\(--color-ink\)/);
  assert.match(body(day, ".day-item.is-late"), /border-left:\s*2px solid var\(--color-danger\)/);
});

test("the Gantt bars (Sites, Projects): black, grey and orange only", () => {
  assert.match(body(day, ".day-gantt-bar"), /background:\s*var\(--color-ink-faint\)/);
  assert.match(body(day, ".day-gantt-bar.is-late"), /background:\s*var\(--color-chart-2\)/);
  assert.match(body(day, ".day-gantt-bar.is-done"), /background:\s*var\(--color-ink\)/);
  assert.match(body(day, ".day-gantt-now"), /background:\s*var\(--color-accent\)/);
});

/* ---------------------------------------------------------------- Memory, Skills, Automations, Settings, Team */

test("Memory and Skills: square chips and menus with an ink edge; numbered steps are square mono cells", () => {
  assert.match(body(memory, ".kn-menu"), /border:\s*var\(--line-ink\)/);
  assert.doesNotMatch(body(memory, ".kn-menu"), /shadow-float/);
  assert.match(body(memory, ".kn-why"), /border-left:\s*2px solid var\(--color-accent\)/);
  const num = body(skills, ".sk-num");
  assert.match(num, /font-family:\s*var\(--font-mono\)/);
  assert.match(body(skills, ".sk-step.is-done .sk-num"), /background:\s*var\(--color-primary\)/);
});

test("Automations: the when and do tags are mono labels; the agent pages' labels too", () => {
  micro(body(automations, ".au-tag"), ".au-tag");
  micro(body(agents, ".ag-label"), ".ag-label");
  title(body(agents, ".ag-title"), ".ag-title");
});

test("Settings: the category list marks the current one with a thin orange edge; the list title is a micro-label", () => {
  micro(body(settings, ".st-nav-title"), ".st-nav-title");
  assert.match(settings, /\.st-nav-item\.is-active::before \{[^}]*width:\s*2px[^}]*background:\s*var\(--color-accent\)/);
  micro(body(settings, ".st-tier-label"), ".st-tier-label");
  title(body(settings, ".st-upgrade-title"), ".st-upgrade-title");
});

/* ---------------------------------------------------------------- numbers: the stat strip */

test("the numbers the app already shows are a stat strip: 1 px dividers, huge numbers, a tiny mono label below", () => {
  const strip = body(settings, ".st-stats");
  assert.match(strip, /border-top:\s*var\(--line\)/);
  assert.match(strip, /border-bottom:\s*var\(--line\)/);
  assert.match(body(settings, ".st-stats > *"), /border-left:\s*var\(--line\)/);
  assert.match(body(settings, ".st-stats .ui-stat-value"), /font-size:\s*var\(--display-lg\)/, "huge numbers");
  // where: Insights and the run's detail had one; Usage and the team board now use the same strip (Status keeps its
  // Connections rows: its states are words, and the review kept its sentences whole)
  assert.match(read("src/pages/Insights.tsx"), /<div className="st-stats">/);
  assert.match(read("src/pages/Runs.tsx"), /<div className="st-stats is-three">/);
  const settingsPage = read("src/pages/Settings.tsx");
  assert.match(settingsPage, /<div className="st-stats is-two">\s*<Stat label="Cost"/, "Usage this month: the month's cost and tokens");
  assert.doesNotMatch(settingsPage, /<Badge>\$\{\(u\.month_cents/, "the numbers left the badge for the strip");
  assert.match(read("src/team/Team.tsx"), /<div className="team-stats st-stats is-three"/);
  assert.match(settings, /\.st-stats\.is-two \{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});

/* ---------------------------------------------------------------- charts */

test("data visuals: black, grey and orange only, thin lines; the chart colours are tokens", () => {
  // series 1 and 2 are the ink and the orange; 3 to 6 are greys and a burnt orange set per theme, apart in lightness
  // (the review: 4 and 5 were two greys 1.16:1 apart; tests/industrial-review.test.mjs measures every pair)
  for (const [k, v] of [["1", "ink"], ["2", "accent"]]) {
    assert.match(tokens, new RegExp(`--color-chart-${k}:\\s*var\\(--color-${v}\\);`), `--color-chart-${k} is ${v}`);
  }
  for (const k of [3, 4, 5, 6]) assert.equal(tokens.match(new RegExp(`--color-chart-${k}:\\s*#[0-9A-F]{6};`, "g"))?.length, 3, `--color-chart-${k} in each theme`);
  assert.match(body(settings, ".st-bar"), /fill:\s*var\(--color-chart-1\)/, "Insights bars in ink");
  assert.match(body(settings, ".st-bar.is-failed"), /fill:\s*var\(--color-chart-2\)/, "failed calls in orange");
  assert.match(read("src/pages/Insights.tsx"), /note="Orange: calls that failed/, "the note names the colour the bars really are");
  const live = read("src/v02/LiveBlocks.tsx");
  assert.match(live, /\["--color-chart-1", "--color-chart-2", "--color-chart-3", "--color-chart-4", "--color-chart-5", "--color-chart-6"\]/, "the live chart reads the chart tokens");
  assert.doesNotMatch(live, /#3355cc|#c8102e|#1f7a3f/i, "no blue, red or green fallback");
  assert.match(live, /strokeWidth="1\.5"/, "thin lines");
  assert.doesNotMatch(live, /<circle/, "square markers");
  // team charts: the workload and the timeline
  assert.match(body(team, ".team-wl-bar"), /background:\s*var\(--color-chart-1\)/);
  assert.match(body(team, ".team-wl-bar.over"), /background:\s*var\(--color-chart-2\)/);
  assert.doesNotMatch(team, /var\(--ok\)/, "no green in a chart");
  // diagrams: mermaid gets the theme's own colours (resolved, so its colour maths works) and thin lines
  const util = read("src/util.tsx");
  assert.match(util, /function mermaidTheme\(\)/);
  for (const t of ["--color-ink", "--color-surface", "--color-border", "--color-accent"]) assert.match(util, new RegExp(t), t);
  assert.match(util, /stroke-width: 1px/);
});

/* ---------------------------------------------------------------- the rest of the feature areas */

test("Coworkers, Team, Teammates, Packs, Voice: square cards with hairlines, mono labels, no floating shadow", () => {
  const tm = css("src/teammates/teammates.css");
  assert.match(body(tm, ".tm-mentions"), /border:\s*var\(--line-ink\)/);
  micro(body(tm, ".tm-side h3"), ".tm-side h3");
  micro(body(team, ".team-card-kind"), ".team-card-kind");
  title(body(team, ".team-col-head h3"), ".team-col-head h3");
  assert.match(body(team, ".team-seg button.on"), /background:\s*var\(--color-primary\)/);
  const voice = css("src/voice/voice.css");
  assert.match(body(voice, ".talk-orb"), /border:\s*var\(--line-ink\)/);
  title(body(voice, ".talk-phase"), ".talk-phase");
  const v02 = css("src/v02/v02.css");
  micro(body(v02, ".live-kind"), ".live-kind");
  assert.match(body(v02, ".v02-menu"), /border:\s*var\(--line-ink\)/);
  micro(body(css("src/pages/coworkers.css"), ".cw-role, .cw-meta"), ".cw-role");
});
