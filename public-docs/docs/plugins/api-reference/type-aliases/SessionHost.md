
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: SessionHost

> **SessionHost** = `object`

## Methods

### ask()?

> `optional` **ask**(`req`, `wait?`): `Promise`\<[`SessionAskOutcome`](SessionAskOutcome.md)\>

#### Parameters

##### req

[`SessionAskRequest`](SessionAskRequest.md)

##### wait?

[`PermissionWait`](PermissionWait.md)

#### Returns

`Promise`\<[`SessionAskOutcome`](SessionAskOutcome.md)\>

***

### emit()

> **emit**(`ev`): `void`

#### Parameters

##### ev

[`NormalizedEvent`](NormalizedEvent.md)

#### Returns

`void`

***

### requestPermission()

> **requestPermission**(`req`, `wait?`): `Promise`\<[`PermissionDecision`](PermissionDecision.md)\>

#### Parameters

##### req

[`PermissionRequest`](PermissionRequest.md)

##### wait?

[`PermissionWait`](PermissionWait.md)

#### Returns

`Promise`\<[`PermissionDecision`](PermissionDecision.md)\>
