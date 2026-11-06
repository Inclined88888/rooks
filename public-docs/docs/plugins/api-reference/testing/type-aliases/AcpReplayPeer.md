
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpReplayPeer

> **AcpReplayPeer** = `object`

## Properties

### io

> `readonly` **io**: `SessionStdio`

Hand these to the provider's `openSession`.

***

### received

> `readonly` **received**: readonly `Record`\<`string`, `unknown`\>[]

Every message the daemon wrote, parsed, in order.

## Methods

### answer()

> **answer**(`id`): `unknown`

The daemon's answer (`result`) to the agent request that had this `id`, once it came.

#### Parameters

##### id

`string` \| `number`

#### Returns

`unknown`

***

### close()

> **close**(): `void`

#### Returns

`void`

***

### conversation()

> **conversation**(): `ProviderConversation`

The same agent as a conversation, for `createProviderContext({ binaries: { 'my-cli': { converse: () => peer.conversation() } } })` (the model probe).

#### Returns

`ProviderConversation`
