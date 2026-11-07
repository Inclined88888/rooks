// Premium pass, page package A (docs/design/0003-workroom.md, section 6, "restraint"): Mail, Calendar, Tasks, Notes and
// Documents, Files, Sites, Projects, the mail sign-in card, Home, History and Jobs are built on the primitives, each has a
// real loading, empty and error state, keeps every endpoint it called before, and carries no inline colour, no spinner
// without words and no type size or weight off the scale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Every page in the package, with the routes it must still call and a few words that must still be on it.
const PAGES = {
  "src/pages/Mail.tsx": {
    routes: ['"/mail/accounts"', "/mail/draft-reply", "/send`", '"/mail/drafts"', "/messages?q=", "/messages/${encodeURIComponent(uid)}", "/mail/drafts/${d.id}", "/mail/accounts/${account.id}"],
    words: ["Draft with AI", "Reply", "Inbox", "Drafts", "Search mail", "Work", "Personal"],
  },
  "src/pages/Calendar.tsx": {
    routes: ['"/calendars/discover"', 'api<{ error?: string }>("/calendars"', '"/calendars"', "/calendars/${c.id}/sync", "/calendars/${c.id}`", "/events?start=", 'api("/events"', "/events/${ev.id}"],
    words: ["Add calendar", "New event", "Find calendars", "Today", "Calendars", "All day", "Sync now"],
  },
  "src/pages/Tasks.tsx": {
    routes: ['"/tasks"', "/tasks/${task.id}", '"/tasks/breakdown"', "/tasks/${id}"],
    words: ["Tasks", "Break down", "Overdue", "Upcoming", "No date", "Completed", "Save"],
  },
  "src/pages/Docs.tsx": {
    routes: ["/docs?kind=", "/docs/${doc.id}", '"/docs"', '"/ai/assist"', "/docs/${id}"],
    words: ["Write", "Preview", "Insert below", "Discard", "Notes", "Documents", "Pin"],
  },
  "src/pages/Files.tsx": {
    routes: ["/api/files/upload", '"/files/helpers"', '"/files/helpers/install"', '"/media/images/providers"', '"/media/images"', '"/files"', '"/files/capabilities"', "/files/${id}", "/analyse`", '"/files/compare"', '"/files/run"', '"/files/report"', "/download"],
    words: ["Choose a folder", "What it says", "Numbers", "Compare", "Calculate", "Word summary", "PDF summary", "Word redline", "Create image", "Ask about it"],
  },
  "src/pages/Sites.tsx": {
    routes: ['"/sites"', '"/site-actions"', "/records`", "/timeline`", "/check`", "/sign-in`", "/sign-out`", "/key`", '"/sites/watches"', "/sites/watches/${w.id}/run", "/fetch-file`", "/export`", "/to-calendar`", "/calendar.ics", "/site-actions/${a.id}", "/actions`"],
    words: ["Add a site", "Sign in once", "Forget sign-in", "Check now", "What's new", "Items", "Schedule", "Make a change", "<ApprovalCard", "Add to my calendar", "Keep an eye on it", "Run now"],
  },
  "src/pages/Projects.tsx": {
    routes: ["/projects${archived", '"/projects"', '"/projects/active"', "/projects/${sel.id}/items", "/projects/${sel.id}/dismiss", "/projects/items/${it.id}", "/projects/${sel.id}`"],
    words: ["New project", "Work on this", "Ask about it", "Might belong here", "Show archived", "What I know that relates", 'feature="projects_unlimited"'],
  },
  "src/pages/ConnectMailCalendar.tsx": {
    routes: ['"/connect/providers"', '"/connect/accounts"', "/connect/${provider}/start", "/connect/status/", '"/connect/complete"', '"/mail/mac/settings"', '"/mail/mac"', "/mail/autodetect", '"/mail/accounts"', '"/calendars/discover"', "/connect/${p}/client"],
    words: ["Google", "Microsoft", "Apple", "Sign in again", "Signed in on another device", "Test and connect", "app password", "More options"],
    section: true,
  },
  "src/pages/Dashboard.tsx": {
    routes: ['"/dashboard"', 'api("/tasks"', '"/assistant/main"'],
    words: ["What should {who} do?", "{who} already did this", "Still to do", "home-docks", "data?.arrived", "Catch me up", "More"],
  },
  "src/pages/History.tsx": {
    routes: ["/history?", "/history/${e.id}/undo", "/history/export."],
    words: ["Yes, undo", "Keep it", "Help me fix it", "Show older", "Include look-ups", "Search your history", "Everything"],
  },
  "src/v02/Jobs.tsx": {
    routes: ['api<Board>("/jobs")', 'api("/jobs", { body: { kind, prompt } })', "/jobs/${j.id}/${verb}", "/approvals/${a.id}", '"/jobs/done"'],
    words: ["Start job", "Notify me", "Clear finished jobs", "Open chat", "What it was asked", 'id="needs-you"'],
  },
};

const dayDir = new URL("src/pages/day/", root);
const dayFiles = existsSync(dayDir) ? readdirSync(dayDir).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/pages/day/${f}`) : [];
// The only hex in the package's code: brand marks (Google, Microsoft) drawn in their own colours, and the swatches a
// person picks a calendar colour from. Both are data, not theme, and live in one file each.
const HEX_ALLOWED = new Set(["src/pages/day/logos.tsx", "src/pages/day/colors.ts"]);

for (const [file, spec] of Object.entries(PAGES)) {
  const name = file.split("/").pop();
  test(`${name}: built on the primitives with loading, empty and error states`, () => {
    const src = read(file);
    const ui = src.match(/import \{([^}]*)\} from "\.\.\/ui"/);
    assert.ok(ui, `${name} imports from ../ui`);
    const names = ui[1].split(",").map((s) => s.trim());
    if (spec.section) assert.ok(names.includes("Section") || names.includes("Card"), `${name} uses Section or Card`);
    else assert.ok(names.includes("Page"), `${name} uses Page from ../ui`);
    assert.match(src, /<Loading\b/, `${name} has a loading state`);
    assert.match(src, /<ErrorState\b/, `${name} has an error state`);
    if (!spec.section) assert.match(src, /<EmptyState\b/, `${name} has an empty state`);
    assert.doesNotMatch(src, /className="btn\b|className=\{`btn\b/, `${name}: no legacy buttons`);
    assert.doesNotMatch(src, /\bEmpty\b[^\n]*from "\.\.\/util"|\bSkeletonList\b/, `${name}: no legacy Empty or SkeletonList`);
  });

  test(`${name}: keeps every route and control`, () => {
    const src = read(file);
    for (const r of spec.routes) assert.ok(src.includes(r), `${name} still calls ${r}`);
    for (const w of spec.words) assert.ok(src.includes(w), `${name} still says ${w}`);
  });
}

test("no inline colour: no hex, no style={{ that sets a colour, no accent used to decorate", () => {
  for (const file of [...Object.keys(PAGES), ...dayFiles]) {
    const src = read(file);
    if (!HEX_ALLOWED.has(file)) assert.doesNotMatch(src, /["'`]#[0-9a-f]{3,8}\b/i, `${file}: inline hex`);
    for (const m of src.matchAll(/style=\{\{([^}]*)\}\}/g)) {
      assert.doesNotMatch(m[1], /\b(color|background|backgroundColor|borderColor|borderLeftColor|outline|accentColor)\s*:/, `${file}: style={{${m[1]}}} sets a colour`);
      assert.doesNotMatch(m[1], /var\(--(accent|color-accent)/, `${file}: inline accent`);
    }
    assert.doesNotMatch(src, /\bstyle=\{\{[^}]*(fontSize|fontWeight|lineHeight|padding|margin)\s*:/, `${file}: inline type or spacing`);
  }
});

test("no spinner without words: Loader2 is gone from the package", () => {
  for (const file of [...Object.keys(PAGES), ...dayFiles]) assert.doesNotMatch(read(file), /\bLoader2\b|className="spin"/, file);
});

test("the package's stylesheets stay on the type scale, the weights, the radii and the colour tokens", () => {
  const sheets = ["src/pages/day/day.css", "src/connect.css"];
  for (const f of sheets) {
    assert.ok(existsSync(new URL(f, root)), `${f} exists`);
    const css = strip(read(f));
    for (const m of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (/^var\(--text-(xs|sm|md|lg|xl|2xl|mono|thread)\)$/.test(v) || v === "inherit") continue;
      const px = v.match(/^(\d+(?:\.\d+)?)px$/);
      assert.ok(px && [12, 13, 14, 16, 20, 28].includes(Number(px[1])), `${f}: font-size ${v} is off the scale`);
    }
    for (const m of css.matchAll(/font-weight\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      assert.ok(/^(400|500|600|var\(--weight-(regular|medium|heading)\))$/.test(v), `${f}: font-weight ${v}`);
    }
    for (const m of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      for (const part of m[1].trim().split(/\s+/)) assert.ok(/^(0|50%|var\(--radius-(sm|md|full)\))$/.test(part), `${f}: border-radius ${m[1].trim()}`);
    }
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${f}: no hex`);
    assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/i, `${f}: no literal colours`);
    assert.doesNotMatch(css, /text-transform\s*:\s*uppercase/, `${f}: no shouting labels`);
    assert.doesNotMatch(css, /box-shadow\s*:[^;]*\d+px\s+\d+px/, `${f}: no card shadows`);
    assert.doesNotMatch(css, /@keyframes|animation\s*:\s*(?!ui-fade|none)/, `${f}: no motion but the one fade`);
    assert.doesNotMatch(css, /var\(--(panel|panel-2|text|muted|faint|rule|ok|warn|blue-soft|ink-btn|on-ink|accent-ring)\)/, `${f}: old v2 token names`);
  }
});

test("the old Files, Sites, Projects, History and Jobs rules are gone from the shared sheets", () => {
  const work = strip(read("src/work.css"));
  for (const c of ["work-drop", "work-layout", "work-item", "work-digest", "work-helpers"]) assert.doesNotMatch(work, new RegExp(`\\.${c}\\b`), c);
  const v02 = strip(read("src/v02/v02.css"));
  for (const c of ["v02-entry", "v02-confirm", "v02-project", "job-board", "job-card"]) assert.doesNotMatch(v02, new RegExp(`\\.${c}\\b`), c);
  assert.match(v02, /\.job-pill/, "the job notifier keeps its pill");
});
