
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: RemoteExpectation

> **RemoteExpectation** = `object`

The scenarios a remote provider must survive. `normal` is required; `slow`
is a provider whose turns take long enough to cancel or close under, and
`failing` one whose session or turn fails. A scenario left out skips its checks.

## Properties

### model

> `readonly` **model**: `string`

***

### scenarios

> `readonly` **scenarios**: `object`

#### failing?

> `readonly` `optional` **failing?**: `Backend`

#### normal

> `readonly` **normal**: `Backend`

#### slow?

> `readonly` `optional` **slow?**: `Backend`
