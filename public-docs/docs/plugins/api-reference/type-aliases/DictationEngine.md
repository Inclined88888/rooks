
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationEngine

> **DictationEngine** = `object`

A speech-to-text engine (`kind: dictation`, client API 14), registered with
`ctx.slots.register({ slot: 'dictation.engine', key, dictation: engine }, SettingsPanel)`.
The component is the engine's settings panel, shown under the engine in
Settings → Interface → Voice dictation, where the user also chooses which
engine dictates (Automatic by default). No `settings.voice` graft needed.
The product keeps the language choice, the microphone, the session identity
and the draft: an engine never sees the composer. Registering needs the
permission `dictation:engine`; the manifest's `dictation.engines` says where
the voice goes (`egress`), and `id` must be one of its engine ids.

## Properties

### id

> `readonly` **id**: `string`

***

### interim

> `readonly` **interim**: [`DictationInterim`](DictationInterim.md)

***

### label

> `readonly` **label**: `string`

***

### languages

> `readonly` **languages**: [`DictationLanguages`](DictationLanguages.md)

## Methods

### availability()

> **availability**(): `Promise`\<[`DictationAvailability`](DictationAvailability.md)\>

#### Returns

`Promise`\<[`DictationAvailability`](DictationAvailability.md)\>

***

### start()

> **start**(`options`): `Promise`\<[`DictationSession`](DictationSession.md)\>

#### Parameters

##### options

[`DictationStartOptions`](DictationStartOptions.md)

#### Returns

`Promise`\<[`DictationSession`](DictationSession.md)\>
