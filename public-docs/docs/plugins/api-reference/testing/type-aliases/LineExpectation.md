
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: LineExpectation

> **LineExpectation** = `object`

What a recorded session must produce for a line-oriented provider.

## Properties

### cmd

> `readonly` **cmd**: `string`

The binary `buildSpawn` must launch.

***

### envKeys?

> `readonly` `optional` **envKeys?**: readonly `string`[]

Environment keys `buildSpawn` must set on top of the inherited one.

***

### initAt?

> `readonly` `optional` **initAt?**: `"head"` \| `"result"`

Where the stream announces its session. `head` (default): the `system:init`
opens the flow. `result`: the CLI names its session only in its final line,
so the init is emitted right before the `result`.

***

### model

> `readonly` **model**: `string`

A model of the provider, handed to `buildSpawn` and expected in argv.

***

### sessionId

> `readonly` **sessionId**: `string`

The session id the transcript's `system:init` must yield.

***

### transcript

> `readonly` **transcript**: `string` \| readonly `string`[]

The CLI's raw stdout for one turn, one JSON object per line, exactly as it
printed it (before any normalization): the text of a `.jsonl` file or its
lines. Record it from the real CLI; do not write it by hand from the docs.
