
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpScriptStep

> **AcpScriptStep** = `object`

## Properties

### error?

> `readonly` `optional` **error?**: `object`

#### code

> `readonly` **code**: `number`

#### message

> `readonly` **message**: `string`

***

### on

> `readonly` **on**: `string`

The method of the daemon's request that triggers this step; a repeated method consumes its steps in order.

***

### reply?

> `readonly` `optional` **reply?**: `unknown`

***

### send?

> `readonly` `optional` **send?**: readonly [`AcpScriptMessage`](AcpScriptMessage.md)[]
