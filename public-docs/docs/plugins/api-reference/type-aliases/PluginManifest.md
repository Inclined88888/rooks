
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginManifest

> **PluginManifest** = `object`

## Properties

### apiVersion

> **apiVersion**: `number`

***

### author?

> `optional` **author?**: `string`

***

### backends?

> `optional` **backends?**: `unknown`[]

***

### client?

> `optional` **client?**: `object`

#### external

> **external**: `string`[]

#### mode

> **mode**: `"esm"` \| `"iframe"`

#### slots

> **slots**: `string`[]

***

### contains

> **contains**: `string`[]

***

### cover?

> `optional` **cover?**: `string`

***

### declares

> **declares**: `Record`\<`string`, `"single"` \| `"list"` \| `"keyed"`\>

***

### description?

> `optional` **description?**: `string`

***

### dictation?

> `optional` **dictation?**: [`PluginDictationDecl`](PluginDictationDecl.md)

***

### http?

> `optional` **http?**: [`PluginHttpDecl`](PluginHttpDecl.md)

***

### icon?

> `optional` **icon?**: `string`

***

### id

> **id**: `string`

***

### kind

> **kind**: (`"widget"` \| `"page"` \| `"island"` \| `"overlay"` \| `"theme"` \| `"composer"` \| `"layout"` \| `"behavior"` \| `"provider"` \| `"dictation"` \| `"bundle"`)[]

***

### label?

> `optional` **label?**: `string`

***

### license

> **license**: `object`

#### required

> **required**: `boolean`

***

### mascot?

> `optional` **mascot?**: [`PluginMascotDecl`](PluginMascotDecl.md)

***

### migrations?

> `optional` **migrations?**: `string`

***

### modifies

> **modifies**: `string`[]

***

### permissions

> **permissions**: [`PluginPermission`](PluginPermission.md)[]

***

### provider?

> `optional` **provider?**: `object`

#### backends?

> `optional` **backends?**: `unknown`[]

#### binaries

> **binaries**: `object`[]

#### credentialDirs

> **credentialDirs**: `string`[]

#### osCredentials

> **osCredentials**: `object`[]

***

### route?

> `optional` **route?**: `string`

***

### routes?

> `optional` **routes?**: `PluginRoutesDecl`

***

### screenshots

> **screenshots**: `string`[]

***

### secrets?

> `optional` **secrets?**: [`PluginSecretDecl`](PluginSecretDecl.md)[]

***

### settings

> **settings**: [`PluginSetting`](PluginSetting.md)[]

***

### webhooks?

> `optional` **webhooks?**: [`PluginWebhookDecl`](PluginWebhookDecl.md)[]
