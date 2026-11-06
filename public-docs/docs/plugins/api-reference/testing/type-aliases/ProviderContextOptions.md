
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderContextOptions

> **ProviderContextOptions** = `object`

## Properties

### apiVersion?

> `readonly` `optional` **apiVersion?**: `number`

The `apiVersion` the plugin's manifest declares. Default: 12, the contract `ctx.provider` belongs to.

***

### baseEnv?

> `readonly` `optional` **baseEnv?**: `Readonly`\<`Record`\<`string`, `string`\>\>

What `ctx.provider.env()` answers on top of the identity pointers (the daemon's would add the system variables).

***

### binaries?

> `readonly` `optional` **binaries?**: `Readonly`\<`Record`\<`string`, \{ `converse?`: (`args`) => `ProviderConversation`; `path?`: `string`; `probe?`: (`args`) => `Partial`\<`ProviderProbeResult`\>; `version?`: `string`; \}\>\>

The programs `ctx.provider.binary` knows: where each is, which version it prints, and what a probe of it answers. A name
that is not here is "not installed". `serve` is not available in the stand-in (it needs a process): use a fake CLI.

***

### credentialDirs?

> `readonly` `optional` **credentialDirs?**: readonly `string`[]

Absolute folders `scratch.link` may take a source from: stand for the home-relative `declares.credentialDirs` a real provider declared.

***

### generatedMedia?

> `readonly` `optional` **generatedMedia?**: readonly `ProviderGeneratedMedia`[]

What `ctx.provider.media.adopt` returns for any directory. Default: nothing.

***

### gitRoots?

> `readonly` `optional` **gitRoots?**: `Readonly`\<`Record`\<`string`, readonly `string`[]\>\>

What `ctx.provider.git.writableRoots` answers, by working directory. A folder that is not here is not a repository.

***

### osCredentials?

> `readonly` `optional` **osCredentials?**: `Readonly`\<`Record`\<`string`, `string`\>\>

What `ctx.provider.osCredentials` holds, by `service` or `service|account`. A key that is not here reads as null.

***

### secrets?

> `readonly` `optional` **secrets?**: readonly `string`[]

Values `ctx.provider.redact` masks (12 characters or more, like the daemon's). Default: none.

***

### settings?

> `readonly` `optional` **settings?**: `Readonly`\<`Record`\<`string`, `ProviderSettingValue`\>\>

What `ctx.settings.get` answers: the plugin's own settings, secrets included.

***

### userMcpServers?

> `readonly` `optional` **userMcpServers?**: readonly `ProviderMcpServer`[]

The agent's own MCP servers `ctx.provider.mcp()` should list, after Timon's.
