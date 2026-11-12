
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationRun

> **DictationRun** = `object`

What one session produced, and what it did wrong.

## Properties

### errors

> `readonly` **errors**: readonly [`DictationErrorEvent`](DictationErrorEvent.md)[]

***

### events

> `readonly` **events**: readonly `unknown`[]

Every event the engine emitted, in order, valid or not.

***

### finals

> `readonly` **finals**: readonly `string`[]

***

### partials

> `readonly` **partials**: readonly `string`[]

***

### problems

> `readonly` **problems**: readonly `string`[]

Breaches of the contract, in plain words; empty when the engine behaved.

***

### stopped

> `readonly` **stopped**: `boolean`

Whether a `stopped` event arrived.

***

### text

> `readonly` **text**: `string`

The finals as the product appends them to the draft: trimmed, joined by a space.
