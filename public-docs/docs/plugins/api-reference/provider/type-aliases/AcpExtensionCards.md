
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpExtensionCards

> **AcpExtensionCards** = `object`

## Properties

### signal

> `readonly` **signal**: `AbortSignal`

## Methods

### approvePlan()

> **approvePlan**(`plan`, `options?`): `Promise`\<[`AcpCardOutcome`](AcpCardOutcome.md)\<[`AcpPlanVerdict`](AcpPlanVerdict.md)\>\>

#### Parameters

##### plan

[`AcpPlanApproval`](AcpPlanApproval.md)

##### options?

###### id?

`string` \| `null`

#### Returns

`Promise`\<[`AcpCardOutcome`](AcpCardOutcome.md)\<[`AcpPlanVerdict`](AcpPlanVerdict.md)\>\>

***

### ask()

> **ask**(`questions`, `options?`): `Promise`\<[`AcpCardOutcome`](AcpCardOutcome.md)\<`Readonly`\<`Record`\<`string`, [`AcpCardAnswer`](AcpCardAnswer.md)\>\>\>\>

#### Parameters

##### questions

readonly [`AcpCardQuestion`](AcpCardQuestion.md)[]

##### options?

###### id?

`string` \| `null`

#### Returns

`Promise`\<[`AcpCardOutcome`](AcpCardOutcome.md)\<`Readonly`\<`Record`\<`string`, [`AcpCardAnswer`](AcpCardAnswer.md)\>\>\>\>
