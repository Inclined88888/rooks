
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: RemoteSessionOpenArgs

> **RemoteSessionOpenArgs** = `Omit`\<`SessionOpenArgs`, `"io"` \| `"host"` \| `"mcpEnv"`\> & `object`

## Type Declaration

### env

> `readonly` **env**: `Readonly`\<`Record`\<`string`, `string`\>\>

### host

> `readonly` **host**: [`RemoteSessionHost`](RemoteSessionHost.md)

### resume?

> `readonly` `optional` **resume?**: [`RemoteSessionResume`](RemoteSessionResume.md)
