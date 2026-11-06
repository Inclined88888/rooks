
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationRunOptions

> **DictationRunOptions** = `object`

## Properties

### chunkMs?

> `optional` **chunkMs?**: `number`

Size of each `feed()`, in milliseconds of audio. Default 100, as the product.

***

### end?

> `optional` **end?**: `"stop"` \| `"cancel"` \| `"abort"`

How the session ends. Default `stop`.

***

### endAfterMs?

> `optional` **endAfterMs?**: `number`

End after this much audio instead of all of it (ms). For `cancel` / `abort` mid-sentence.

***

### language?

> `optional` **language?**: `string` \| `null`

Passed to `start()`. Default `null` (automatic).

***

### paceMs?

> `optional` **paceMs?**: `number`

Pause between two feeds. Default 0: as fast as the engine takes it, yielding to the event loop each time.

***

### settleMs?

> `optional` **settleMs?**: `number`

How long to keep listening after the end for events that should not come, and for the `stopped` of a cancel or an abort. Default 100 ms.

***

### timeoutMs?

> `optional` **timeoutMs?**: `number`

Bound on `start()` and `stop()`. Default 10 s.
