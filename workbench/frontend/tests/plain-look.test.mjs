// A professional tool, not an "AI product": no sparkle, brain, robot or magic wand icons anywhere in the app.
// Every icon names what the thing is (a bookmark for memory, a checklist for skills), never that "AI" is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function walk(dir, out = []) {
  for (const n of readdirSync(root + dir)) {
    const p = `${dir}/${n}`;
    if (statSync(root + p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

const BANNED = [
  "Sparkle", "Sparkles", "WandSparkles", "Wand", "Wand2", "Brain", "BrainCircuit", "BrainCog",
  "Bot", "BotMessageSquare", "BotOff", "Stars",
];

test("no AI-cliché icons are imported from lucide-react", () => {
  const found = [];
  for (const f of walk("src")) {
    for (const m of readFileSync(root + f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "");
        if (BANNED.includes(name) || BANNED.includes(name.replace(/Icon$/, ""))) found.push(`${f}: ${name}`);
      }
    }
  }
  assert.deepEqual(found, [], `use an icon that names the thing instead:\n${found.join("\n")}`);
});

// One set of controls: these pages are on the shared ui-btn / ui-input / ui-select classes, not the legacy ones.
test("Team, Channels, the trade pack and the chat use the shared controls, not the legacy .btn and .input", () => {
  const legacy = /className=(?:"|\{`)(?:[^"`]*\s)?(btn|input)(?=[\s"`$])/;
  const found = [];
  for (const f of ["src/team/Team.tsx", "src/teammates/Channels.tsx", "src/pages/PackTrade.tsx", "src/chat/Thread.tsx", "src/chat/Composer.tsx",
    "src/chat/ThreadHeader.tsx", "src/chat/tabs/SettingsTab.tsx", "src/chat/tabs/SkillsTab.tsx", "src/chat/tabs/MemoryTab.tsx"]) {
    readFileSync(root + f, "utf8").split("\n").forEach((line, i) => { if (legacy.test(line)) found.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(found, [], `use ui-btn / ui-input / ui-select:\n${found.join("\n")}`);
});
