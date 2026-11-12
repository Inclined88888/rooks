
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ReasoningControl

> **ReasoningControl** = \{ `type`: `"levels"`; `values`: `string`[]; \} \| \{ `max?`: `number`; `min?`: `number`; `type`: `"budget"`; \} \| \{ `type`: `"toggle"`; \}

## Union Members

### Type Literal

\{ `type`: `"levels"`; `values`: `string`[]; \}

Graded levels, in the model's own vocabulary (`none` means off).

***

### Type Literal

\{ `max?`: `number`; `min?`: `number`; `type`: `"budget"`; \}

A budget of thinking tokens, within bounds when known.

***

### Type Literal

\{ `type`: `"toggle"`; \}

Thinking switched on or off.
