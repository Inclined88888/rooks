
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: RemoteDialect

> **RemoteDialect** = `Omit`\<[`Dialect`](../interfaces/Dialect.md), `"persistentProcess"` \| `"finishMissionOnExit"` \| `"defaultCmd"` \| `"buildSpawn"` \| `"writeUserInput"` \| `"parseLine"` \| `"openSession"` \| `"isSessionNotFoundError"` \| `"setModel"` \| `"maxPromptBytes"`\> & `object`

## Type Declaration

### transport

> `readonly` **transport**: `"remote"`

### openSession()

> **openSession**(`args`): [`SessionDriver`](../interfaces/SessionDriver.md)

#### Parameters

##### args

[`RemoteSessionOpenArgs`](RemoteSessionOpenArgs.md)

#### Returns

[`SessionDriver`](../interfaces/SessionDriver.md)
