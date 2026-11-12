---
title: Overview
sidebar_position: 1
---

A Rooks plugin is an ESM npm package with two independent, optional halves: host code executed by the daemon and a browser bundle loaded by the client. Host extensions use a restricted `PluginContext`; UI extensions register components in slots through `ClientContext`.

The same registration model supports widgets, pages, behaviours, themes and layouts. A bundle installs several separate plugin identities. Start with [Your first plugin](quickstart.md), then read the [manifest](manifest.md), [slots](slots.md) and [permissions](permissions.md).

Providers are plugins too: [Write a provider](providers.md) explains declarative packs, profiles with credential refresh, and provider definitions for a CLI, an ACP agent or a remote service. A compatible endpoint used only on your own installation needs no plugin; use [Add a provider in Settings](../usage/add-a-provider.md).

## The public contract

Import TypeScript contracts from `@rooks/sdk`. A provider author also imports code from `@rooks/sdk/provider` and tests it with `@rooks/sdk/testing` ([Write a provider](providers.md)). The package in this source tree is currently private; no public npm availability is assumed. Obtain the SDK and example packages with your developer distribution.

`apiVersion` is the **minimum** contract a plugin requires. A daemon accepts versions up to its implemented contract and rejects a newer requirement. The current source exports contract **15**. API 3 added business events, workflows, transports and connections; API 4 added [live updates](realtime.md) from the host half to the browser half; API 6 lets a provider's `discoverModels` report thinking levels per model ([providers](providers.md)) and adds `AnchoredPopover` to the [UI kit](ui-kit.md). API 7 lets a provider plugin drive an agent with no local process (a [remote dialect](providers.md#drive-a-remote-agent-with-no-local-process)). API 11 gives provider authors the SDK's [conformance bench](providers.md#test-your-provider-with-the-conformance-bench), and a plugin declaring it has its dialect checked at registration. API 12 adds [`ctx.provider`](providers.md#write-it-with-the-sdks-provider-kit): the runtime a provider is written with, supplied by Rooks so that a fix reaches every plugin, the services that need a privilege only Rooks holds, and registration of a whole `ProviderDefinition`. API 13 lets a plugin add a control or a drawer to the [built-in browser](browser.md) (`useBrowserChrome`, `browser:control`) and replace the model selector through the `model.picker` slot ([cookbook](examples.md#model-picker)). API 14 adds `kind: dictation`: a [speech-to-text engine](dictation.md) in the `dictation.engine` slot, with its `dictation` manifest block and the sensitive `dictation:engine` permission. API 15 lets a plugin replace the folder browser of Settings, projects and agents, and the plugin-archive and CLI-binary file pickers, through the `directory.picker` slot (`useDirectoryBrowser`, [cookbook](examples.md#directory-picker)). It also lets `ctx.agents` give an agent its skills, MCP servers and team on `create` / `update`, and adds `ctx.agents.teams` to list and create teams of bots ([agents](agents.md)). It also gives a plugin its own SQLite database, `ctx.sql`, migrated from its manifest ([database and migrations](manifest.md#database-and-migrations)). The calls added by contracts 8 to 10 are on the page of the feature they belong to, with their permissions in [Permissions](permissions.md). `ctx.can()` supports optional capabilities after admission; it cannot make an unknown manifest permission valid on an older daemon.

:::danger Host code is trusted code
`PluginContext` is an API façade, not a JavaScript sandbox. A host plugin runs in the daemon process with the OS account's privileges. Install only code you trust; permissions and signatures do not turn hostile Node code into isolated code.
:::

## Package identity

The npm package name and `rooks.id` are separate. Use your own npm scope. **The current manifest validator accepts IDs matching `[a-z0-9-]{3,40}`**, such as `acme-weather`; it does not accept a scoped ID containing `/`. Bundled product IDs use their own catalogue convention. Use the manifest ID for configuration, plugin commands and bundle membership.

Always encode IDs used as URL segments with `encodeURIComponent`; do not make routing depend on the present character restrictions.

Continue with the [example cookbook](examples.md) for verified source excerpts from all supplied packages. Before sending a plugin to anyone else, read [Ship to someone else](distribution.md): no absolute path or personal data, everything in the package, and the check to run first.

The SDK API reference is generated from the public TypeScript entry points: [`@rooks/sdk`](api-reference/index.md), [`@rooks/sdk/provider`](api-reference/provider/index.md) and [`@rooks/sdk/testing`](api-reference/testing/index.md). Implementation comments and private source links are deliberately excluded; use these guides for behavioural explanations.
