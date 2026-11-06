
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationExpectation

> **DictationExpectation** = `object`

## Properties

### language?

> `optional` **language?**: `string` \| `null`

Language handed to `start()`. Default: the engine's first code, or `null`.

***

### manifest?

> `optional` **manifest?**: `unknown`

Your `package.json`: the engine's `id` must be one of its `timon.dictation.engines`.

***

### run?

> `optional` **run?**: `Omit`\<[`DictationRunOptions`](DictationRunOptions.md), `"language"` \| `"end"` \| `"endAfterMs"`\>

Passed to every session (`paceMs`, `timeoutMs`, `settleMs`…).

***

### silence?

> `optional` **silence?**: `boolean`

Check that silence gives no text (default `true`). Turn off only for an engine that cannot tell.

***

### speech?

> `optional` **speech?**: `Float32Array`

What to dictate. Default `fakeUtterance()`; give a recording (`readWavPcm`) to check real words.

***

### transcript?

> `optional` **transcript?**: `string` \| `RegExp`

Checked against the text of the dictation, when given.
