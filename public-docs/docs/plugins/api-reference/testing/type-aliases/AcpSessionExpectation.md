
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpSessionExpectation

> **AcpSessionExpectation** = `object`

## Properties

### args

> `readonly` **args**: readonly `string`[]

***

### cmd

> `readonly` **cmd**: `string`

The binary `buildSpawn` launches, and the arguments that put it in ACP mode.

***

### extensions?

> `readonly` `optional` **extensions?**: readonly [`AcpExtensionExpectation`](AcpExtensionExpectation.md)[]

The agent's own blocking requests the provider answers (`AcpAgentSpec.extensionRequests`), each one a request
the script's `session/prompt` sends (`send` with an `id`).

***

### mcpServers

> `readonly` **mcpServers**: readonly `string`[]

The MCP servers the session must declare to the agent (Timon's own, by name).

***

### permission?

> `readonly` `optional` **permission?**: `object`

The script's tool use that asks permission (its `id`), and the option ids the agent offers for yes and no.
Skip it for an agent that decides alone (`permissionsByAgent`).

#### allowOptionId

> `readonly` **allowOptionId**: `string`

#### denyOptionId

> `readonly` **denyOptionId**: `string`

#### requestId

> `readonly` **requestId**: `string` \| `number`

#### tool

> `readonly` **tool**: `string` \| `RegExp`

***

### says

> `readonly` **says**: `string`

What the script's `session/prompt` streams as the assistant's text, in full.

***

### script

> `readonly` **script**: `string` \| readonly [`AcpScriptStep`](AcpScriptStep.md)[]

The recorded session (see the header of this file): steps, the text of a `.jsonl` file, or its path.

***

### sessionId

> `readonly` **sessionId**: `string`

The session id `session/new` answers in the script.

***

### signIn?

> `readonly` `optional` **signIn?**: `object`

A script whose `session/new` answers `auth_required`: what the user must read.

#### message

> `readonly` **message**: `RegExp`

#### script

> `readonly` **script**: `string` \| readonly [`AcpScriptStep`](AcpScriptStep.md)[]

***

### stopReason

> `readonly` **stopReason**: `string`
