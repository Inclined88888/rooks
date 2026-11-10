// The assistant has one name, the main chat can offer buttons, and Home shows work that already happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const welcome = read("../src/pages/Welcome.tsx");
const home = read("../src/pages/Dashboard.tsx");
const chat = ["../src/pages/Assistant.tsx", "../src/chat/Thread.tsx", "../src/chat/ThreadHeader.tsx", "../src/chat/Composer.tsx", "../src/chat/events.ts"].map(read).join("\n"); // the chat page is split (package F2)

test("first run asks for a name and saves it", () => {
  assert.match(welcome, /What should I be called\?/);
  assert.match(welcome, /assistant_name: chosen/);
  assert.match(welcome, /setStep\("name"\)/);
  assert.match(welcome, /Keep the name Atlas/);
});

test("Home greets by name and lists unread results beside still to do", () => {
  assert.match(home, /What should \{who\} do\?/);
  assert.match(home, /\{who\} already did this/);
  assert.match(home, /Still to do/);
  assert.match(home, /data\?\.arrived/);
  assert.match(home, /home-docks/);
});

test("the main chat uses the assistant's name and real choice buttons", () => {
  assert.doesNotMatch(chat, />Workspace</);
  assert.match(chat, /\{who\}/);
  assert.match(chat, /case "choices"/); // the typed reducer in chat/events.ts
  assert.match(chat, /className="chat-choices"/);
  assert.match(chat, /aria-label=\{c\.question \|\| "Quick replies"\}/);
});
