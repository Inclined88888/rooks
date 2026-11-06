
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderInstallPlan

> **ProviderInstallPlan** = \{ `kind`: `"none"`; \} \| \{ `kind`: `"npm"`; `package`: `string`; \} \| \{ `kind`: `"script"`; `posix?`: `string`; `windows?`: `string`; \} \| \{ `kind`: `"package"`; `packages`: `Readonly`\<`Partial`\<`Record`\<[`PackageManagerName`](PackageManagerName.md), `string`\>\>\>; \}

## Union Members

### Type Literal

\{ `kind`: `"none"`; \}

***

### Type Literal

\{ `kind`: `"npm"`; `package`: `string`; \}

***

### Type Literal

\{ `kind`: `"script"`; `posix?`: `string`; `windows?`: `string`; \}

The vendor's standalone installer, as its documentation gives it.

***

### Type Literal

\{ `kind`: `"package"`; `packages`: `Readonly`\<`Partial`\<`Record`\<[`PackageManagerName`](PackageManagerName.md), `string`\>\>\>; \}
