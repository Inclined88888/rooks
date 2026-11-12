
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: IslandContentOptions

> **IslandContentOptions** = `object`

What a content of the island workspace (`island.content`, client API 8)
says about itself. Its type id is `<pluginId>:<key>`, computed by the host.

## Properties

### beforeClose?

> `optional` **beforeClose?**: (`params`, `tabId`) => `boolean` \| `Promise`\<`boolean`\>

The user asks to close the tab (its ×, middle click, Delete, menu, or its
island's close): `false` keeps it open — unsaved changes the user chose to
keep. A promise may ask first; one that throws or rejects keeps the tab
too. Agreeing is not closing: an island asks each of its tabs in turn and
any later one may still keep them all, so drop state in `onClose`, never
here. Not called when the tab moves, nor when the content or the host
closes it itself. An arrangement replacing the tab (a recall, a preset
applied to every project, an agent's card) asks too, and a refusal cancels
the whole arrangement — also on a page not on screen, where the tab is not
mounted: keep what this reads outside the component.

#### Parameters

##### params

[`IslandParams`](IslandParams.md)

##### tabId

`string`

#### Returns

`boolean` \| `Promise`\<`boolean`\>

***

### detach?

> `optional` **detach?**: (`params`) => `void`

Reopens this content in its own window ("Detach"). Absent = no Detach.

#### Parameters

##### params

[`IslandParams`](IslandParams.md)

#### Returns

`void`

***

### exclusive?

> `optional` **exclusive?**: `string`

Group of contents of which only one instance is primary at a time (`useIslandContent().primary`).

***

### groupBy?

> `optional` **groupBy?**: `string`

A param naming what tabs of this type belong to (a terminal's scope):
opening one lands in the island that already holds a tab of the type with
the same value, rather than in a new one.

***

### icon?

> `optional` **icon?**: `string`

SVG markup, same rules as `WidgetOptions.icon`.

***

### keepMounted?

> `optional` **keepMounted?**: `boolean`

Stays mounted, hidden, while its tab is not the visible one. Default: unmounted.

***

### minHeight?

> `optional` **minHeight?**: `number`

px, default 160.

***

### minWidth?

> `optional` **minWidth?**: `number`

px, default 280.

***

### newTab?

> `optional` **newTab?**: (`params`) => `Promise`\<[`IslandParams`](IslandParams.md) \| `null`\>

The "+" of the island's tab bar: makes the params of one more tab, or `null` to refuse. Absent = no "+".

#### Parameters

##### params

[`IslandParams`](IslandParams.md)

#### Returns

`Promise`\<[`IslandParams`](IslandParams.md) \| `null`\>

***

### onClose?

> `optional` **onClose?**: (`params`, `tabId`) => `void`

The tab closed, whoever closed it: end what it held (kill a shell, drop a
draft). Not called when the tab moves. May run while the tab is not
mounted (an arrangement written over a page not on screen).

#### Parameters

##### params

[`IslandParams`](IslandParams.md)

##### tabId

`string`

#### Returns

`void`

***

### params?

> `optional` **params?**: `Readonly`\<`Record`\<`string`, [`IslandParamSpec`](IslandParamSpec.md)\>\>

The params `parseParams` accepts, described for an agent.

***

### parseParams

> **parseParams**: (`raw`) => [`IslandParams`](IslandParams.md) \| `null`

Validates and cleans params read from storage, from a drag or from an
agent's proposal. `null` refuses them. Mandatory: a stored value is opaque.

#### Parameters

##### raw

`unknown`

#### Returns

[`IslandParams`](IslandParams.md) \| `null`

***

### singletonBy?

> `optional` **singletonBy?**: `string` \| readonly `string`[]

At most one live tab per value of this param, or per combination of these params (the first one set; a later one absent on both sides counts as equal).

***

### title

> **title**: `string`

What the tab and its menus show until the content sets its own title.

***

### volatileParams?

> `optional` **volatileParams?**: readonly `string`[]

Params that are a day's state, dropped from a named preset.
