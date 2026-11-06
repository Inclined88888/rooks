
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: fakeRemoteHost()

> **fakeRemoteHost**(): `object`

A host that applies the daemon's rules to what the driver hands it.

## Returns

`object`

### emitted

> **emitted**: `NormalizedEvent`[]

### ends

> **ends**: `SessionEnd`[]

### host

> **host**: `object`

#### host.emit

> **emit**: (`ev`) => `void`

##### Parameters

###### ev

`NormalizedEvent`

##### Returns

`void`

#### host.end

> **end**: (`outcome`) => `void`

##### Parameters

###### outcome

`SessionEnd`

##### Returns

`void`

#### host.requestPermission

> **requestPermission**: () => `Promise`\<\{ `allow`: `boolean`; \}\>

##### Returns

`Promise`\<\{ `allow`: `boolean`; \}\>

#### host.saveResume

> **saveResume**: (`state`) => `void`

##### Parameters

###### state

`RemoteResumeState` \| `null`

##### Returns

`void`

### saved

> **saved**: `RemoteResumeState`[]
