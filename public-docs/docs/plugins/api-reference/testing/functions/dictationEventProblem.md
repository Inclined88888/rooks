
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: dictationEventProblem()

> **dictationEventProblem**(`event`): `string` \| `null`

Why the product would drop `event`, or `null` if it passes: an engine is an
untrusted source of text, so every event is checked before it reaches the
draft. Plain text only is the engine's duty; the product never renders it as HTML.

## Parameters

### event

`unknown`

## Returns

`string` \| `null`
