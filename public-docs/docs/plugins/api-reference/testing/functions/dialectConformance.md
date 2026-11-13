
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: dialectConformance()

> **dialectConformance**(`dialect`, `profile`, `exp`, `ctx`): [`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]

Everything for one dialect: its declarations, then the suite that matches what
it is (a CLI that prints lines, or a remote session).

## Parameters

### dialect

`AnyDialect`

### profile

[`BoundProfile`](../type-aliases/BoundProfile.md)

### exp

[`LineExpectation`](../type-aliases/LineExpectation.md) \| [`RemoteExpectation`](../type-aliases/RemoteExpectation.md) \| ((`provider`) => [`RemoteExpectation`](../type-aliases/RemoteExpectation.md))

### ctx

[`ConformanceContext`](../type-aliases/ConformanceContext.md)

## Returns

[`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]
