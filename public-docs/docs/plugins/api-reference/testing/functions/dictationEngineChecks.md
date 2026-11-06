
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: dictationEngineChecks()

> **dictationEngineChecks**(`engine`, `expectation?`): [`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]

The contract the product holds every engine to, as checks for your test
runner (`defineConformanceTests`). Session checks need the engine `ready`:
fake its model or its server in the test, the bench never downloads anything.

## Parameters

### engine

`DictationEngine`

### expectation?

[`DictationExpectation`](../type-aliases/DictationExpectation.md) = `{}`

## Returns

[`ConformanceCheck`](../type-aliases/ConformanceCheck.md)[]
