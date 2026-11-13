---
title: Write a dictation engine
---

A dictation engine turns what the user says into text: Rooks opens the microphone, hands your engine the audio, and writes what your engine recognises into the message box. Your engine can run a model in the page (WebAssembly, WebGPU, JavaScript), call a speech service, or hand blocks of audio to your plugin's own daemon routes. This page takes you from the manifest to a tested engine, with the SDK alone.

The complete template is `examples/plugin-dictation`: one engine that runs in the page, one that sends blocks of audio to its daemon half. It recognises nothing; replace the marked parts with your model or service.

## What Rooks keeps, what your engine does

Rooks keeps:

- the **microphone**: it opens it after the user's gesture and consent, resamples to 16 kHz mono, and feeds your engine only between `start()` and `stop()` or `cancel()`;
- the **language** the user chose, passed to `start()`;
- the **session** and the **draft**: dictation edits the message box and never sends it; your engine never sees the composer.

Your engine receives samples and reports events. Its text is plain text, never HTML.

Rooks's own engine in the desktop app runs speech models natively; that engine is not open to plugins. A plugin brings its own engine, or [a pack of speech models](#ship-speech-models) for Rooks's engine.

## Declare the engine

```json
{
  "name": "@acme/dictation",
  "version": "1.0.0",
  "type": "module",
  "exports": { "./client": "./lib/client.js" },
  "rooks": {
    "id": "acme-dictation",
    "apiVersion": 14,
    "kind": "dictation",
    "label": "Acme dictation",
    "permissions": ["dictation:engine", "http:outbound"],
    "client": { "slots": ["dictation.engine"], "external": ["react"], "mode": "esm" },
    "dictation": {
      "engines": [
        { "id": "acme-cloud", "runtime": "page", "egress": ["api.acme.com"] }
      ]
    }
  }
}
```

- `kind: dictation` needs `apiVersion: 14`, the sensitive permission `dictation:engine` and the exact slot `dictation.engine`.
- `dictation.engines` lists each engine (up to 8): its `id` (a slug, `acme-cloud`), where it runs (`runtime`) and **where the voice goes** (`egress`). The `id` your code registers must be one of these: an engine the manifest does not declare is never used.
- The component you register with the engine is its settings panel (see [Show your settings](#show-your-settings)): no other slot is needed.

| `runtime` | Where your engine runs | `egress` |
| --- | --- | --- |
| `page` | In your plugin's browser half | `"none"` (nothing leaves the window), or the hosts you send audio to |
| `daemon` | Your browser half sends blocks of audio to your plugin's host half through `ctx.api` | `"daemon"`, or the hosts your host half sends audio to |

An `egress` host is a bare hostname, such as `api.acme.com` or `*.acme.com`: never a URL, a port or a path. Sending to a host also needs `http:outbound`, and the operator must allow the host, in `pluginPolicy.http.allow` or for your plugin alone in `pluginPolicy.http.byPlugin` (see [Permissions](permissions.md)).

The manifest is refused when `kind: dictation` lacks the permission, the slot or the `dictation` block; when the `dictation` block or the `dictation.engine` slot appears under another kind; when an engine sends audio to hosts without `http:outbound`; when a `daemon` engine claims `egress: "none"` or the plugin has no host half.

### Where the voice goes, said to the user

Rooks shows each engine's `egress` on the plugin's card and install sheet in **Plugins**, and in **Settings → Interface → Voice dictation**: "Your voice stays in this window", "Your voice is sent to the Rooks daemon of" the active machine, or "Your voice is sent to api.acme.com". A `daemon` engine's audio goes to the daemon of the machine the user works on, which can be another computer.

The first time the user dictates with your engine, a card names that destination and asks whether your engine may hear them, **even with `egress: "none"`**. Until they click **Allow**, the microphone stays off and your engine receives nothing, not even an `availability()` call. **Don't allow** keeps your engine off: Rooks does not switch to another one. The answer holds for one machine; an update that changes your `egress` asks again.

The Rooks window enforces where a `page` engine may connect. Your browser half reaches the app's own origin (your `ctx.api` routes included) and, over HTTPS or secure WebSockets only, the hosts a `page` engine of an installed plugin declares; the browser refuses every other `fetch`, WebSocket, image, media, frame, worker or form post. A plain `http://` host is never reachable from the window. The list is read when the page loads: right after your plugin is installed, Rooks asks the user to reload before your engine can reach its host.

This holds against connections, not against everything a plugin can do: your browser half still runs inside the app's page, with the user's session, so the consent card stays. Declare exactly what your engine does.

## Write the engine

```js
/** @returns {import('@rooks/sdk').DictationEngine} */
function createEngine(model) {
  return {
    id: 'acme-cloud',
    label: 'Acme Cloud',
    languages: { codes: ['en', 'fr'], mode: 'forced' },
    interim: 'delayed',
    async availability() {
      return model.ready()
        ? { state: 'ready' }
        : { state: 'needs-setup', reason: 'Download the Acme model in Settings → Interface → Voice dictation.' }
    },
    async start({ language, signal, onEvent }) {
      // Open your connection or load your model here, and resolve quickly.
      return {
        feed(pcm) { /* Float32Array, 16 kHz mono, about 100 ms */ },
        async stop() { /* send the rest, emit the last final, then: */ onEvent({ type: 'stopped' }) },
        cancel() { onEvent({ type: 'stopped' }) },
      }
    },
  }
}

export function apply(ctx) {
  const engine = createEngine(acmeModel)
  ctx.slots.register({ slot: 'dictation.engine', key: engine.id, dictation: engine }, AcmePanel)
}
```

`ctx.slots.register` throws when the plugin does not hold `dictation:engine`, when the `dictation` option is given for another slot, when the engine is malformed, or when another engine already uses the same `id`.

### The contract

| Member | |
| --- | --- |
| `id`, `label` | One of the manifest's engine ids; the name the user sees. |
| `languages` | `codes`: BCP 47 primary subtags (`fr`, `en`). `mode`: `auto` (your engine detects the language and may ignore the one it gets), `forced` (it uses the one it gets, or detects without), `required` (it cannot start without one). |
| `interim` | `live` (provisional text as the user speaks), `delayed` (every second or two: an engine fed by blocks), `final-only`. |
| `availability()` | `ready`, `needs-setup` (a model to download, a key to enter) or `unavailable`, with an optional plain-text `reason`. |
| `start({ language, signal, onEvent })` | Starts a session. `language` is the user's choice, or `null` for automatic. `signal` aborts when Rooks cancels. Returns the session. |
| `feed(pcm)` | `Float32Array`, 16 kHz mono, values in [-1, 1], about 100 ms per call. |
| `stop()` | Resolves after your last `final`. |
| `cancel()` | Drops what is pending: no `final` follows. |

Events, through `onEvent`:

| Event | Meaning |
| --- | --- |
| `{ type: 'partial', text }` | The sentence in progress; replaces the previous partial. |
| `{ type: 'final', text }` | A finished sentence, added to the message. |
| `{ type: 'error', code, message, fatal }` | `code` is one of `unavailable`, `needs-setup`, `busy`, `crashed`, `decode-failed`, `network`, `denied`. A non-fatal error lets the session go on. |
| `{ type: 'stopped' }` | Always the last event of a session. |

Rooks checks every event: text is plain text of at most 20,000 characters, and an event out of shape, after `stopped` or from a replaced session is dropped.

### Conventions

- **Silence gives no text.** A model that writes "Thank you." on a quiet microphone fails the test kit's default check.
- **Resolve `start()` quickly.** Rooks keeps what the user says while your engine starts (up to 30 seconds) and feeds it as soon as the session exists.
- **`needs-setup` with an empty message** means "my own card or panel already tells the user what to do": Rooks shows nothing more. A non-empty message is shown as is.
- **`busy`** means another window or panel took your engine: Rooks stops without retrying.
- **A `daemon` engine sends blocks**, not a stream: report `delayed` or `final-only`. Rooks accepts a JSON body of at most 1 MB on the routes of a plugin with a `daemon` engine (about 20 seconds of 16 kHz 16-bit audio in base64) and answers a larger one with `413` before your host half sees it: send a second or two per block, never a whole dictation. Bound what your host half accepts (block size, length of a dictation, dictations per account), answer `404` for another account's session, and never write audio or text in a log. A service key belongs to your host half ([secrets](secrets.md)), never to the browser half or a URL: a `page` engine that calls a service with a key goes through your own routes.

## Show your settings

The component you pass with your engine is its settings panel (a key, a model to download). **Settings → Interface → Voice dictation** shows it below your engine, where the user also chooses which engine dictates. If your panel throws, its error is shown in its place and the rest of the page keeps working.

A plugin written before this, which also registers the same component in `settings.voice`, keeps it shown there once rather than twice; you can drop that registration.

The user chooses the engine. **Automatic**, the default, uses Rooks's own engine wherever it can run and a plugin's engine only where it cannot. When the user chooses your engine and it cannot run (it answers `unavailable`, or is not registered), Rooks says so and never dictates with another engine instead. Choosing your engine is not consent: the consent card still asks before the microphone opens.

## Test it

The test kit `@rooks/sdk/testing` runs your engine without a microphone, a network or Rooks:

```js
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { defineConformanceTests, dictationEngineChecks, readWavPcm } from '@rooks/sdk/testing'

defineConformanceTests(test, dictationEngineChecks(createEngine(fakeModel), {
  speech: readWavPcm(await readFile('test/hello-fr.wav')),
  language: 'fr',
  transcript: /bonjour/i,
  manifest: JSON.parse(await readFile('package.json', 'utf8')),
}))
```

`dictationEngineChecks` checks the engine's shape (and, given your `package.json`, that its `id` is one of your manifest's engines), `availability()`, exactly one `stopped` at the end, `cancel()` and the abort signal, a second dictation, and that silence gives no text. `runDictation`, `silencePcm`, `speechLikePcm`, `fakeUtterance`, `chunkPcm`, `readWavPcm` (mono 16 kHz WAV, 16-bit PCM or float32; anything else is refused rather than guessed) and `createFakeDictationEngine` are there for your own tests. The kit downloads nothing: fake your model or service so that `availability()` answers `ready`.

## Ship speech models {#ship-speech-models}

A plugin can also offer models to Rooks's own engine in the desktop app. Your code never sees the voice, and the user's voice stays on their computer. Name a JSON file of your package in the manifest:

```json
"dictation": { "models": "dictation-models.json" }
```

List that file in your package's `files`. It holds `{ "models": [ … ] }`, 1 to 16 entries, 256 KiB at most. `examples/plugin-dictation/dictation-models.json` is a complete, working entry to copy. For each entry:

- `id` starts with your plugin ID and a dot: `acme-dictation.fr-small`;
- `source` is `huggingface`, with a `repository` and a `revision` that is a full commit sha;
- each file gives its `role`, `path`, `sizeBytes` and `sha256`;
- `license` gives `spdx`, `attribution`, `url` and `redistribution: "ok"`.

The user sees your models under **From plugins** in **Settings → Interface → Voice dictation**. **Add and download** opens a box of the desktop app that shows your plugin, the source, the size and the licence, and nothing downloads unless they accept. The files must match their hashes, and the model must pass an inspection and a trial load, before it can dictate.

An entry whose `id` or languages cannot be read is not listed. Any other refusal is shown when the user adds it. A plugin that only ships models still declares the `dictation:engine` permission, the `dictation.engine` slot and a browser half, which may register nothing.

Removing your plugin stops offering its models; a model the user already added stays until they delete it.

See also: [Permissions](permissions.md), [Testing](testing.md), [Voice dictation](../usage/voice-dictation.md) for what the user sees.
