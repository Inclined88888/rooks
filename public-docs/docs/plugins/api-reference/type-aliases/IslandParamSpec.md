
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: IslandParamSpec

> **IslandParamSpec** = `object`

One param of an island content type, as an agent reads it (`islands_get`)
and the daemon checks a proposal against it. Declarative only, no regular
expression: `parseParams` stays the last word in the browser.

## Properties

### description?

> `optional` **description?**: `string`

What the param means, for an agent composing a layout.

***

### enum?

> `optional` **enum?**: readonly `string`[]

***

### max?

> `optional` **max?**: `number`

***

### maxLength?

> `optional` **maxLength?**: `number`

***

### min?

> `optional` **min?**: `number`

***

### nullable?

> `optional` **nullable?**: `boolean`

***

### required?

> `optional` **required?**: `boolean`

***

### type

> **type**: `"string"` \| `"number"` \| `"boolean"`
