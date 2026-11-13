
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: runDictation()

> **runDictation**(`engine`, `pcm`, `options?`): `Promise`\<[`DictationRun`](../type-aliases/DictationRun.md)\>

Runs one session the way the product does — `start`, ~100 ms feeds, then
`stop`, `cancel` or an abort of the signal — and records what the engine
emitted. A `start()` that rejects rejects here; everything else the engine
gets wrong is listed in `problems`, so a test can assert on all of it at once.

## Parameters

### engine

`DictationEngine`

### pcm

`Float32Array`

### options?

[`DictationRunOptions`](../type-aliases/DictationRunOptions.md) = `{}`

## Returns

`Promise`\<[`DictationRun`](../type-aliases/DictationRun.md)\>
