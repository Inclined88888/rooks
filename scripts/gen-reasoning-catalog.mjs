#!/usr/bin/env node
/**
 * Generates `orchestrator/src/backends/reasoning-catalog.snapshot.ts` from the
 * models.dev catalogue (https://models.dev/api.json, MIT licence).
 *
 * A model served by a custom provider says nothing about its thinking controls:
 * a gateway's `/v1/models` lists ids, nothing else. models.dev records, per model
 * and per host, whether it reasons and how (graded effort, token budget, on/off
 * switch). The daemon must answer offline and must not trust a network answer at
 * runtime, so the useful fields are frozen here and committed, like
 * `gen-emoji-data.mjs` does for the emoji list. Re-run to refresh:
 *
 *   node scripts/gen-reasoning-catalog.mjs [path-or-url-to-api.json]
 *
 * Kept per model: its id, its `canonical_model_id` (which lab model a host
 * relays), `reasoning` and `reasoning_options`. Everything else (prices, limits,
 * descriptions) is dropped. Option sets are deduplicated into one table, since a
 * few dozen distinct sets cover thousands of models.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SOURCE = 'https://models.dev/api.json';

/** Reproduced in the generated file AND in its data: the notice must travel
 *  with the copy, and a comment can be stripped by a later packaging step. */
export const MODELS_DEV_LICENSE = `MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Model entry codes, besides an index in the option table. */
const NO_REASONING = -1;
const UNKNOWN_OPTIONS = -2;

/** One reasoning option with its keys in a fixed order, so the same set always
 *  serializes the same way. Unknown option types are dropped, not guessed. */
function cleanOption(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'toggle') return { type: 'toggle' };
  if (raw.type === 'effort') {
    const values = Array.isArray(raw.values) ? raw.values.filter((v) => typeof v === 'string' && v.length > 0) : [];
    return { type: 'effort', values };
  }
  if (raw.type === 'budget_tokens') {
    const out = { type: 'budget_tokens' };
    if (Number.isInteger(raw.min)) out.min = raw.min;
    if (Number.isInteger(raw.max)) out.max = raw.max;
    return out;
  }
  return null;
}

function hostnameOf(url) {
  if (typeof url !== 'string') return null;
  try {
    // Some providers template their URL (`${CLOUDFLARE_ACCOUNT_ID}`) in the path:
    // the hostname is still the part that identifies them.
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The snapshot for a models.dev `api.json` body. Pure, deterministic: the same
 * input yields the same bytes, so a refresh shows as a readable diff.
 */
export function buildSnapshot(api, generatedAt) {
  const optionKeys = new Map();
  const options = [];
  const optionIndex = (set) => {
    const key = JSON.stringify(set);
    let index = optionKeys.get(key);
    if (index === undefined) {
      index = options.length;
      options.push(set);
      optionKeys.set(key, index);
    }
    return index;
  };
  const providers = [];
  for (const [providerId, provider] of Object.entries(api ?? {})) {
    if (!provider || typeof provider !== 'object' || typeof provider.models !== 'object' || !provider.models) continue;
    const models = [];
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== 'object') continue;
      const canonical = typeof model.canonical_model_id === 'string' && model.canonical_model_id.includes('/')
        ? model.canonical_model_id
        : null;
      let code;
      if (model.reasoning === false) code = NO_REASONING;
      else if (model.reasoning === true && Array.isArray(model.reasoning_options)) {
        code = optionIndex(model.reasoning_options.map(cleanOption).filter(Boolean));
      } else code = UNKNOWN_OPTIONS;
      // An entry that says nothing about reasoning still helps when it names the
      // lab model it relays; without that either, it carries nothing.
      if (code === UNKNOWN_OPTIONS && !canonical) continue;
      models.push([modelId, canonical ? [code, canonical] : [code]]);
    }
    if (models.length === 0) continue;
    const host = hostnameOf(provider.api);
    providers.push([providerId, { ...(host ? { api: host } : {}), models: sortedObject(models) }]);
  }
  // Option indices follow first appearance in provider order; re-number them by
  // their serialized form so the table does not reshuffle when models.dev
  // reorders its providers.
  const order = options.map((set, index) => ({ key: JSON.stringify(set), index })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const remap = new Map(order.map(({ index }, position) => [index, position]));
  const sortedProviders = sortedObject(providers);
  for (const provider of Object.values(sortedProviders)) {
    for (const entry of Object.values(provider.models)) {
      if (entry[0] >= 0) entry[0] = remap.get(entry[0]);
    }
  }
  return {
    source: DEFAULT_SOURCE,
    generatedAt,
    license: MODELS_DEV_LICENSE,
    options: order.map(({ index }) => options[index]),
    providers: sortedProviders,
  };
}

/** The TypeScript module that carries a snapshot. The data is a string parsed on
 *  first use: an object literal of this size would cost the type checker and
 *  every process that merely imports the module. */
export function renderModule(snapshot) {
  const commented = MODELS_DEV_LICENSE.split('\n').map((line) => ` * ${line}`.trimEnd()).join('\n');
  return `/**
 * GENERATED by scripts/gen-reasoning-catalog.mjs — do not edit by hand.
 *
 * Thinking controls per model, from models.dev (${snapshot.source}),
 * snapshot of ${snapshot.generatedAt}. Read by \`reasoning-catalog.ts\`.
 *
 * models.dev data, reproduced under its licence:
 *
${commented}
 */
export const REASONING_SNAPSHOT_JSON = ${JSON.stringify(JSON.stringify(snapshot))};
`;
}

async function main() {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const text = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const snapshot = buildSnapshot(JSON.parse(text), new Date().toISOString().slice(0, 10));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const target = join(root, 'orchestrator', 'src', 'backends', 'reasoning-catalog.snapshot.ts');
  const body = renderModule(snapshot);
  writeFileSync(target, body, 'utf8');
  const count = Object.values(snapshot.providers).reduce((sum, p) => sum + Object.keys(p.models).length, 0);
  console.log(`${target}: ${Object.keys(snapshot.providers).length} providers, ${count} models, ${snapshot.options.length} option sets, ${Math.round(body.length / 1024)} KiB`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
