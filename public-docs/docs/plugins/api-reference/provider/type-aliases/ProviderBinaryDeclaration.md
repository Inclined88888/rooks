
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderBinaryDeclaration

> **ProviderBinaryDeclaration** = `object`

## Properties

### desktopBuilds?

> `readonly` `optional` **desktopBuilds?**: readonly [`ProviderDesktopBuild`](ProviderDesktopBuild.md)[]

***

### identity?

> `readonly` `optional` **identity?**: [`ProviderBinaryIdentity`](ProviderBinaryIdentity.md)

***

### install?

> `readonly` `optional` **install?**: `Readonly`\<`Partial`\<`Record`\<[`InstallPlatform`](InstallPlatform.md) \| `"any"`, [`ProviderInstallPlan`](ProviderInstallPlan.md)\>\>\>

***

### names

> `readonly` **names**: readonly `string`[]

***

### searchDirs?

> `readonly` `optional` **searchDirs?**: `Readonly`\<`Partial`\<`Record`\<[`InstallPlatform`](InstallPlatform.md) \| `"any"`, readonly `string`[]\>\>\>

***

### serviceNeeds?

> `readonly` `optional` **serviceNeeds?**: readonly [`ProviderServiceNeed`](ProviderServiceNeed.md)[]
