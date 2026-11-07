// Motion in design system v3 (docs/design/0003-workroom.md, section 6): motion explains, never decorates. What is left
// of src/motion is a still Thinking line, a screenshot swap, a short exit and the on/off level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = (p) => new URL(`../src/${p}`, import.meta.url).pathname;
const out = await build({ entryPoints: [src("motion/index.tsx")], bundle: true, format: "esm", platform: "node", write: false,
  external: ["react", "react-dom", "react-router-dom", "marked", "dompurify"], loader: { ".css": "empty" }, jsx: "automatic" });
const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "motion.mjs", out.outputFiles[0].text);
let reduced = false;
globalThis.document ??= { documentElement: { dataset: {} } };
globalThis.window ??= { matchMedia: () => ({ matches: reduced }) };
globalThis.window.matchMedia = () => ({ matches: reduced });
const m = await import(pathToFileURL(dir + "motion.mjs").href);
const code = readFileSync(src("motion/index.tsx"), "utf8");

test("motion is on or off: Off and the OS reduced-motion setting both turn the fades off", () => {
  document.documentElement.dataset.motion = "full";
  assert.equal(m.motionLevel(), "on");
  document.documentElement.dataset.motion = "off";
  assert.equal(m.motionLevel(), "off");
  document.documentElement.dataset.motion = "full";
  reduced = true;
  assert.equal(m.motionLevel(), "off");
  reduced = false;
});

test("the runtime keeps only what explains: a still Thinking line, a screenshot swap and a short exit", () => {
  assert.deepEqual(Object.keys(m).sort(), ["LiveShot", "Thinking", "motionLevel", "useExit"]);
  assert.doesNotMatch(code, /requestAnimationFrame|startViewTransition|createPortal|animationDelay/);
  assert.match(code, /export function useExit<T extends string \| number>\(ms = 120\)/, "an exit fade is 150 ms or less");
});

test("the one fade is opacity only and honours reduced motion in one place", () => {
  const ui = readFileSync(src("ui/ui.css"), "utf8");
  assert.match(ui, /@keyframes ui-fade \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  assert.equal((ui.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1);
});
