
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Interface: Backend

## Properties

### browserToolsHint?

> `readonly` `optional` **browserToolsHint?**: `string`

***

### finishMissionOnExit

> `readonly` **finishMissionOnExit**: `boolean`

***

### hostedConnectors

> `readonly` **hostedConnectors**: `boolean`

***

### maxPromptBytes?

> `readonly` `optional` **maxPromptBytes?**: `number`

***

### name

> `readonly` **name**: `string`

***

### nativeCompact?

> `readonly` `optional` **nativeCompact?**: `object`

#### command

> `readonly` **command**: `string`

***

### permissionModel

> `readonly` **permissionModel**: `"none"` \| `"mcp-bridge"` \| `"sandbox"` \| `"protocol"`

***

### permissionsHint?

> `readonly` `optional` **permissionsHint?**: `string`

***

### persistentProcess

> `readonly` **persistentProcess**: `boolean`

***

### rateLimitReporting

> `readonly` **rateLimitReporting**: `"none"` \| `"structured"` \| `"textual"`

***

### sessionResumable

> `readonly` **sessionResumable**: `boolean`

***

### sessionStore

> `readonly` **sessionStore**: `"global"` \| `"per-mission"`

## Methods

### accountUsage()?

> `optional` **accountUsage**(`options?`): `Promise`\<[`AccountUsage`](../type-aliases/AccountUsage.md) \| `null`\>

#### Parameters

##### options?

[`UsageProbeOptions`](../type-aliases/UsageProbeOptions.md)

#### Returns

`Promise`\<[`AccountUsage`](../type-aliases/AccountUsage.md) \| `null`\>

***

### buildSpawn()

> **buildSpawn**(`opts`): `Promise`\<[`SpawnResult`](../type-aliases/SpawnResult.md)\>

#### Parameters

##### opts

[`BuildSpawnOpts`](../type-aliases/BuildSpawnOpts.md)

#### Returns

`Promise`\<[`SpawnResult`](../type-aliases/SpawnResult.md)\>

***

### dispose()?

> `optional` **dispose**(`missionId`): `void`

#### Parameters

##### missionId

`string`

#### Returns

`void`

***

### enrichEvent()?

> `optional` **enrichEvent**(`ev`, `missionId`): [`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

##### missionId

`string`

#### Returns

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

***

### extractSessionId()

> **extractSessionId**(`ev`): `string` \| `null`

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

#### Returns

`string` \| `null`

***

### isSessionNotFoundError()?

> `optional` **isSessionNotFoundError**(`stderr`): `boolean`

#### Parameters

##### stderr

`string`

#### Returns

`boolean`

***

### openRemoteSession()?

> `optional` **openRemoteSession**(`args`): [`SessionDriver`](SessionDriver.md)

#### Parameters

##### args

`Omit`\<[`RemoteSessionOpenArgs`](../type-aliases/RemoteSessionOpenArgs.md), `"profileId"` \| `"env"` \| `"launch"`\>

#### Returns

[`SessionDriver`](SessionDriver.md)

***

### openSession()?

> `optional` **openSession**(`args`): [`SessionDriver`](SessionDriver.md)

#### Parameters

##### args

`Omit`\<[`SessionOpenArgs`](../type-aliases/SessionOpenArgs.md), `"profileId"` \| `"launch"`\>

#### Returns

[`SessionDriver`](SessionDriver.md)

***

### parseLine()

> **parseLine**(`line`): [`NormalizedEvent`](../type-aliases/NormalizedEvent.md)[]

#### Parameters

##### line

`string`

#### Returns

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)[]

***

### setModel()?

> `optional` **setModel**(`proc`, `model`): `Promise`\<`boolean`\>

#### Parameters

##### proc

`ChildProcessWithoutNullStreams`

##### model

`string`

#### Returns

`Promise`\<`boolean`\>

***

### spans()?

> `optional` **spans**(`ev`, `state`, `eventId`): [`SpanOp`](../type-aliases/SpanOp.md)[]

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

##### state

[`SpanState`](../type-aliases/SpanState.md)

##### eventId

`number`

#### Returns

[`SpanOp`](../type-aliases/SpanOp.md)[]

***

### writeUserInput()

> **writeUserInput**(`proc`, `text`, `images?`): `void`

#### Parameters

##### proc

`ChildProcessWithoutNullStreams`

##### text

`string`

##### images?

[`ImageAttachment`](../type-aliases/ImageAttachment.md)[]

#### Returns

`void`
