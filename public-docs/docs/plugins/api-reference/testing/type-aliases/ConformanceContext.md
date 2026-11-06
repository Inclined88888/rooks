
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ConformanceContext

> **ConformanceContext** = `object`

The mission the checks launch. Every field has a default; `cwd` is yours.

## Properties

### checkUsage?

> `readonly` `optional` **checkUsage?**: `boolean`

Also run `accountUsage` and check the gauge it returns. Off by default: a
real probe reaches the network or the user's credentials. Turn it on once
your test fakes what the probe talks to.

***

### cwd

> `readonly` **cwd**: `string`

An existing directory, handed to `buildSpawn` as the agent's `cwd`.

***

### message?

> `readonly` `optional` **message?**: `string`

***

### missionId?

> `readonly` `optional` **missionId?**: `string`

***

### resumeId?

> `readonly` `optional` **resumeId?**: `string`

The session id handed back to `buildSpawn` to check the resume path.

***

### scratchDirs?

> `readonly` `optional` **scratchDirs?**: readonly `string`[]

Directories the provider writes the system prompt or the message into
(a rules file, a prompt file…) instead of argv or stdin. The suite looks
for them there; a provider that writes nothing on disk passes none.

***

### systemPrompt?

> `readonly` `optional` **systemPrompt?**: `string`
