
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationEvent

> **DictationEvent** = \{ `text`: `string`; `type`: `"partial"`; \} \| \{ `text`: `string`; `type`: `"final"`; \} \| \{ `code`: [`DictationErrorCode`](DictationErrorCode.md); `fatal`: `boolean`; `message`: `string`; `type`: `"error"`; \} \| \{ `type`: `"stopped"`; \}

What an engine reports during a session. `text` is plain text, never HTML,
at most 20,000 characters: the product checks every event against this
shape and drops one that fails, or that arrives after `stopped`. A `partial`
replaces the previous partial; a `final` is appended. `stopped` is always
the last event.
