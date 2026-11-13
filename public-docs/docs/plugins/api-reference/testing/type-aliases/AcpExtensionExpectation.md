
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpExtensionExpectation

> **AcpExtensionExpectation** = `object`

One of the agent's own blocking requests, played through a card the bench answers.

## Properties

### answer

> `readonly` **answer**: (`card`) => `SessionAskOutcome`

What the person does with the card: an answer keyed by question text, or `{ answered: false, reason }`.

#### Parameters

##### card

`SessionAskRequest`

#### Returns

`SessionAskOutcome`

***

### reply

> `readonly` **reply**: `unknown`

The `result` the agent must receive, in its own shape.

***

### requestId

> `readonly` **requestId**: `string` \| `number`

The request's `id` in the script.

***

### script?

> `readonly` `optional` **script?**: `string` \| readonly [`AcpScriptStep`](AcpScriptStep.md)[]

The session that sends the request (steps, the text of a `.jsonl` file, or its path); default the expectation's `script`.

***

### unanswered?

> `readonly` `optional` **unanswered?**: `unknown`

The `result` the agent must receive when nobody can be asked (a host without `ask`, a daemon one-shot).
