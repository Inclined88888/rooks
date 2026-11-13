# Dictation engine (API 14)

A template for a speech-to-text engine (`kind: dictation`). It registers two
engines in the `dictation.engine` slot, one per runtime a third party may use:

| Engine | Runs | Where the voice goes (`egress`) | Text |
|---|---|---|---|
| `example-page` | in the window, in the plugin's browser half | `none`: it stays in the window | live partials, then the final |
| `example-daemon` | in the plugin's host half, reached through `ctx.api` | `daemon`: the daemon of the active machine | final only |

Neither recognises a word. Each says how much voiced audio it heard
(`Example transcript: 1.5 s of speech (fr).`) and writes nothing on silence.
Replace the marked parts with your model or service. The desktop's native
engine is the built-in one's alone: a third party brings a `page` or `daemon`
engine, or a pack of models for it (`dictation-models.json`, see below).

Install it from the repository root in developer mode, with
`rooks plugin add ./examples/plugin-dictation`. No build and no dependency are
needed. The install sheet lists where each engine sends the voice. Both
engines then appear under Settings → Voice.

## What the product does, and what the engine does

The product opens the microphone, after a gesture from the user. It also picks
the language, keeps the session and owns the draft. An engine receives 16 kHz
mono Float32 samples, about 100 ms per `feed()`, and only between `start()` and
`stop()` / `cancel()`. It reports `partial`, `final`, `error` and `stopped`
events. `stopped` always comes last, and `stop()` resolves after the last
`final`. The text is plain text, never HTML, at most 20,000 characters per
event. The product drops an event that breaks these rules.

## The daemon engine

The browser half collects about one second of audio and sends it as a JSON
block (`{ pcm }`, little-endian 16-bit PCM, base64) to `POST
sessions/:id/audio`. When the user stops, `POST sessions/:id/stop` returns the
final text. `DELETE sessions/:id` releases a cancelled dictation. Every route
of the host half (`lib/index.js`):

- refuses an anonymous caller (401), even on an installation without accounts;
- keeps each account's dictations to itself: another account's id answers 404;
- bounds what it holds: 2 s per block, 2 minutes per dictation, two dictations
  at once per account, one forgotten after a minute without audio;
- never logs the audio or the text.

There is no stream: v1 of the contract sends blocks, so a daemon engine shows
its text late (`delayed`) or at the end (`final-only`).

To call a service instead of the stand-in (`lib/recognizer.js`), use
`ctx.fetch`. Declare `http:outbound` and change `egress` to the list of its
hosts (`["api.acme.com"]`). The operator adds those hosts to
`pluginPolicy.http.allow`. The key comes from `ctx.secrets`, never from a URL
or a log. To run a local program, use `ctx.exec` (`host:exec`).

## The models pack

`dictation.models` names a JSON file of the package, `{ "models": [ … ] }`, 1
to 16 entries. Those models run in Rooks's own engine, in the desktop app:
your code never sees the voice. The template's single entry is a real model, a
copy of the built-in Canary under the plugin's id; replace it with yours.

Settings → Interface → Voice dictation lists it under **From plugins**. **Add
and download** makes the desktop read the entry from the daemon and ask in a
native box; the page only names it. Each entry needs:

- an `id` that starts with your plugin id and a dot, unique in the catalog;
- a `huggingface` source pinned to a full commit sha, and every file with its
  size and sha256;
- `license.redistribution: "ok"` and a `license.url`.

An entry whose id or languages cannot be read is not listed. Any other refusal
(a `family` this version does not know, a malformed hash) is said when the user
adds it. A downloaded model is hashed, inspected and loaded once in a
disposable process before it is ready.

## Testing your engine

`@rooks/sdk/testing` holds the bench Rooks applies to every engine.
`test/conformance.test.mjs` runs it on both engines, with the host half mounted
in memory by `test/host.mjs`:

```js
import { defineConformanceTests, dictationEngineChecks, readWavPcm } from '@rooks/sdk/testing'

defineConformanceTests(test, dictationEngineChecks(myEngine, {
  manifest,                                                   // your package.json
  language: 'fr',
  speech: readWavPcm(readFileSync('test/fixtures/hello.wav')), // mono, 16 kHz
  transcript: /bonjour/i,
}), '[my-engine]')
```

The checks cover several points. The engine must be declared as `register`
accepts it, and `availability()` must answer. Exactly one `stopped` comes, and
it comes last. Nothing follows `cancel()` or an abort of the start signal. A
second dictation works like the first. Silence gives no text: a model that
writes "Thank you." on a quiet microphone fails. Fake audio
(`silencePcm`, `speechLikePcm`, `fakeUtterance`), `runDictation` and a fake
engine (`createFakeDictationEngine`) are there for your own tests.

Run `node --test test/` from a project where `@rooks/sdk` is installed.

The package embeds no `SIGNATURE` file on purpose. Its interface strings are in
English for brevity: a published plugin should provide its own translations.
