
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: replayTranscript()

> **replayTranscript**(`provider`, `lines`, `spawn`, `chunking?`): `Promise`\<[`ReplayResult`](../type-aliases/ReplayResult.md)\>

Feeds `lines` to the engine as the daemon would for this provider (a lines
session over pipes) and returns what it emitted. Only for a line-oriented
provider: one that speaks a session protocol has no lines to replay.

## Parameters

### provider

`Backend`

### lines

readonly `string`[]

### spawn

`BuildSpawnOpts`

### chunking?

`"lines"` \| `"whole"` \| `"bytes"` \| `"crlf"`

## Returns

`Promise`\<[`ReplayResult`](../type-aliases/ReplayResult.md)\>
