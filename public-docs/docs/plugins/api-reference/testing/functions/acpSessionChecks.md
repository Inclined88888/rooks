
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: acpSessionChecks()

> **acpSessionChecks**(`provider`, `exp`, `ctx`): [`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]

The checks of an ACP provider: how it launches the agent, how the session opens and what it declares to the agent,
a turn, the permission round trip and the sign-in message. Run them on a provider bound with `bindDialect`.

## Parameters

### provider

`Backend`

### exp

[`AcpSessionExpectation`](../type-aliases/AcpSessionExpectation.md)

### ctx

[`ConformanceContext`](../type-aliases/ConformanceContext.md)

## Returns

[`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]
