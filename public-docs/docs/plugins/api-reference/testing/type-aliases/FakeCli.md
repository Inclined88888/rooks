
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: FakeCli

> **FakeCli** = `object`

## Properties

### cmd

> `readonly` **cmd**: `string`

The file to launch: pass it as the profile's `cmd`.

## Methods

### spawn()

> **spawn**(`args?`, `env?`): `ChildProcessWithoutNullStreams`

Spawns it with the given arguments, as the daemon's host adapter would.

#### Parameters

##### args?

readonly `string`[]

##### env?

`ProcessEnv`

#### Returns

`ChildProcessWithoutNullStreams`
