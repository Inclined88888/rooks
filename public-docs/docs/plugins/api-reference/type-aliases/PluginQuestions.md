
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginQuestions

> **PluginQuestions** = `object`

## Methods

### get()

> **get**(`id`): `Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `kind`: `"question"` \| `"series_plan"`; `missionId`: `string`; `plan`: [`PluginQuestionPlan`](PluginQuestionPlan.md) \| `null`; `questions`: readonly [`PluginQuestionItem`](PluginQuestionItem.md)[]; \}\> \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `kind`: `"question"` \| `"series_plan"`; `missionId`: `string`; `plan`: [`PluginQuestionPlan`](PluginQuestionPlan.md) \| `null`; `questions`: readonly [`PluginQuestionItem`](PluginQuestionItem.md)[]; \}\> \| `undefined`\>

***

### list()

> **list**(`filter?`): `Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `kind`: `"question"` \| `"series_plan"`; `missionId`: `string`; `plan`: [`PluginQuestionPlan`](PluginQuestionPlan.md) \| `null`; `questions`: readonly [`PluginQuestionItem`](PluginQuestionItem.md)[]; \}\>[]\>

#### Parameters

##### filter?

[`PluginQuestionListFilter`](PluginQuestionListFilter.md)

#### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `kind`: `"question"` \| `"series_plan"`; `missionId`: `string`; `plan`: [`PluginQuestionPlan`](PluginQuestionPlan.md) \| `null`; `questions`: readonly [`PluginQuestionItem`](PluginQuestionItem.md)[]; \}\>[]\>

***

### resolve()

> **resolve**(`id`, `answer`): `Promise`\<`Readonly`\<\{ `id`: `string`; `status`: `"answered"` \| `"cancelled"`; \}\>\>

#### Parameters

##### id

`string`

##### answer

[`PluginQuestionAnswer`](PluginQuestionAnswer.md)

#### Returns

`Promise`\<`Readonly`\<\{ `id`: `string`; `status`: `"answered"` \| `"cancelled"`; \}\>\>
