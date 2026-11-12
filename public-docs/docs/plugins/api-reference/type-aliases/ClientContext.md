
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ClientContext

> **ClientContext** = `object`

Browser capabilities bound to the installed plugin identity.

## Properties

### events

> **events**: `object`

Subscribe to platform events and retain the returned cleanup function.
Same allowlist as the host `ctx.events.on` ([PluginEventKind](PluginEventKind.md)).
Any other kind, mission transcripts included, throws at runtime. The TO DO
kinds ([PluginTodoEventKind](PluginTodoEventKind.md)) and the task kinds
([PluginTaskEventKind](PluginTaskEventKind.md)) are host-only: they are filtered by account
and carry the writer's origin, which the browser stream does not.

#### subscribe()

> **subscribe**(`kind`, `handler`): () => `void`

##### Parameters

###### kind

`"mission_complete"` \| `"task_done"` \| `"task_blocked"` \| `"mission_started"` \| `"turn_complete"` \| `"mission_title_changed"` \| `"notifications_changed"` \| `"workflow_run"` \| `"workflow_proposal"`

###### handler

(`event`) => `void`

##### Returns

() => `void`

***

### id

> `readonly` **id**: `string`

Manifest identity of this plugin.

***

### realtime

> **realtime**: `object`

API 4: subscribe to this plugin's own topics. Only the owner account
receives a signal, never another account (including superadmins).
Topics must match ^[a-z0-9][a-z0-9._-]{0,63}$ or subscribe throws.
The handler receives the payload, not the transport envelope.
Cleanup is automatic on plugin disposal; the returned function can
unsubscribe earlier. Host publishing requires `realtime:publish`.

#### subscribe()

> **subscribe**(`topic`, `handler`): () => `void`

##### Parameters

###### topic

`string`

###### handler

(`payload`) => `void`

##### Returns

() => `void`

***

### settings

> **settings**: `object`

#### get()

> **get**(): `Promise`\<`Record`\<`string`, `unknown`\>\>

Read browser-safe settings; secret plaintext is never returned.

##### Returns

`Promise`\<`Record`\<`string`, `unknown`\>\>

#### set()

> **set**(`key`, `value`): `Promise`\<`Response`\>

Persist a declared setting through the authenticated platform endpoint.

##### Parameters

###### key

`string`

###### value

`unknown`

##### Returns

`Promise`\<`Response`\>

***

### slots

> **slots**: `object`

#### register()

> **register**(`options`, `Component?`): () => `void`

Registers a component in `options.slot`. Admission compares slot
NATURES, not just names: a manifest declaring any `*.widget` slot may
fill every widget host (`cockpit.widget`, `sidebar.left.widget`, a
third-party layout's own widget zone). Any other slot stays an exact
match — a widget never gets `root`, `page`, `settings.section` or
`settings.missions`. Settings graft slots (`settings.missions`, …)
are exact too: declaring one native group does not open the others.
Throws when the slot is refused or undeclared. `dictation` (API 14) is
read for `dictation.engine` only, and throws without `dictation:engine`.
`mascotPart` (API 15) is read for `mascot.parts` only, with `key` = the
part's slug, which the manifest must declare (`rooks.mascot`); the
component is not painted there and may be left out.

In `nav.item`, `key` is the entry's route (`'/growth'`: lowercase, from
`/`). It is what the person's menu refers to: with it, the entry moves,
hides, and goes to the bottom of the menu like the product's, and comes
back to its place when the plugin is switched off and on again. Without
it, the entry shows at the end of the main list and cannot be moved or
hidden. The host owns the editing row (grip, eye) and makes the entry's
own content inert meanwhile: paint a plain link, nothing more.

##### Parameters

###### options

###### children?

[`SlotChildren`](SlotChildren.md)

###### dictation?

[`DictationEngine`](DictationEngine.md)

###### island?

[`IslandContentOptions`](IslandContentOptions.md)

###### key?

`string`

###### mascotPart?

[`MascotPart`](MascotPart.md)

###### slot

`string`

###### widget?

[`WidgetOptions`](WidgetOptions.md)

###### Component?

[`ClientComponent`](ClientComponent.md)

##### Returns

() => `void`

***

### theme

> **theme**: `object`

#### current()

> **current**(): `"light"` \| `"dark"`

##### Returns

`"light"` \| `"dark"`

***

### usage

> **usage**: `object`

Quotas of the LLM accounts. Needs `usage:read` in the manifest — the
 daemon answers 403 otherwise, so a plugin never reads a fabricated zero.
 Lists the signed-in user's subscription accounts too, never another
 user's. `{ force: true }` is for a person's explicit refresh only (a ↻
 button): the probes skip their cache. Never pass it from a polling loop —
 the daemon honours it at most once every few seconds per account.

#### list()

> **list**(`options?`): `Promise`\<[`UsageEntry`](UsageEntry.md)[]\>

##### Parameters

###### options?

[`UsageProbeOptions`](UsageProbeOptions.md)

##### Returns

`Promise`\<[`UsageEntry`](UsageEntry.md)[]\>

## Methods

### api()

> **api**(`path`, `init?`): `Promise`\<`Response`\>

Fetch a path beneath this plugin's own API namespace. A JSON body is
relayed as JSON. An archive ([PluginApiBinaryBody](PluginApiBinaryBody.md): a `File`, a
`Blob`, an `ArrayBuffer`) is streamed to the host half as bytes when its
type is `application/zip`, `application/x-zip-compressed` or
`application/octet-stream` — an untyped `Blob` or buffer is sent as
`application/octet-stream` — up to 50 MiB (413 past that, before a byte
is read). Any other type keeps the JSON path.

#### Parameters

##### path

`string`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>

***

### effect()

> **effect**(`setup`): `void`

Own a synchronous setup and its cleanup for the plugin lifetime.

#### Parameters

##### setup

() => `void` \| (() => `void`)

#### Returns

`void`

***

### navigate()

> **navigate**(`href`): `void`

Navigate through the host application.

#### Parameters

##### href

`string`

#### Returns

`void`
