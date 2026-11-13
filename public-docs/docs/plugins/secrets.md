---
title: Secrets
sidebar_position: 13
---

There are two different sources of secret values.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="setting" label="Plugin secret setting">

Declare a `rooks.settings` field with `type: "secret"`. The user enters it in Settings. With the `settings` permission, the **host** calls `ctx.settings.get(key)` to obtain its value. It is sealed at rest in plugin storage. The browser receives an empty value and a `configured` flag, not the plaintext. `rooks plugin remove` keeps it, so reinstalling your package finds it again; it is deleted, before any of its code runs, when a different package takes your plugin id, along with your other settings, your storage and your data folder.

</TabItem>
<TabItem value="vault" label="Vault secret">

Request `secrets:read` and call `await ctx.secrets.get(name)`. Names are environment-variable identifiers, such as `ACME_TOKEN`. Only a grant to `agent:plugin:<id>`, which names your plugin, gives access. A `global` grant is for agents and does not reach plugins; grants to another agent, plugin or project do not either. When your plugin asks for a name only shared with `global`, it gets `undefined` and the operator sees a card. Opening it shows the grant in **Secrets**, to confirm with **Grant**; the card closes as soon as the grant exists, or when your plugin is removed. The operator can also pick the **plugin** scope in a secret's editor, or run `rooks secret grant <NAME> --scope agent:plugin:<id>`. Granting is reserved to an administrator. A name your manifest [declares](#name-what-you-will-ask-for) can be granted on the install sheet, in one tick; any other name is granted afterwards, so say in your README which ones. `rooks plugin remove` withdraws every grant to `agent:plugin:<id>` (the secrets themselves stay): after a reinstall, they must be granted again. So does a different package taking the id after the previous one left another way.

</TabItem>
</Tabs>

A vault lookup with no applicable grant returns `undefined`. A lookup without the declared permission throws a permission error. The API is asynchronous, so always await it.

:::danger Keep plaintext on the host
Never log secret values, even partially, or return them from a route. A broker-mode secret never leaves the daemon through a name lookup. Browser code should receive only the result of the authorised operation or a configured/not-configured status.
:::

## Name what you will ask for

Permissions say *what* your plugin may do (`secrets:read`, `secrets:broker`, `http:outbound`), never *which* secret or *which* host. Name them in the manifest, and the administrator who installs your plugin sees each one and can grant it to your plugin alone before it runs:

```json
"rooks": {
  "permissions": ["secrets:read", "secrets:broker", "http:outbound"],
  "secrets": [
    { "name": "ACME_TOKEN", "mode": "read", "why": "Signs the calls to the Acme API." },
    { "name": "ACME_DEPLOY_KEY", "mode": "broker" }
  ],
  "http": { "hosts": [{ "host": "api.acme.com", "why": "The Acme API." }] }
}
```

- `secrets[].name` is a vault name, such as `ACME_TOKEN`, listed once. `mode` is `read` for `ctx.secrets.get` (needs `secrets:read`) or `broker` for `ctx.secrets.httpCall` or a git credential (needs `secrets:broker`); a broker value never reaches your plugin. 20 secrets at most.
- `http.hosts[].host` is a bare hostname in lower case, or `*.acme.com` for its subdomains: never a URL, a port or a path. It needs `http:outbound`. 1 to 20 hosts, no duplicate. A wildcard you declare counts as already open only when the operator's list holds a wildcard at least as wide: `api.acme.com` there does not cover `*.acme.com`.
- `why` is optional: one line of plain text, 200 characters at most, shown as written (it is not translated). Say what the secret or host is for.

A manifest that names a secret or a host without the matching permission is refused: your plugin could never use it. Both fields are optional, and an older daemon ignores them, so declaring them does not raise your `apiVersion`. A bundle's children declare their own ([Bundle](bundle.md#secrets-and-hosts-of-the-children)).

A declaration is not a grant. Until the administrator ticks a name, your plugin gets `undefined` for it, and a host stays closed. Read a secret when you need it, not once in `apply`: it may be granted after your plugin started.

## What the administrator sees at install

When your manifest names secrets or hosts, the install sheet in **Plugins** lists each one under **Secrets and network**, with its `why`:

- **A secret in the vault** has a tick-box, unticked. Ticked, it is granted to this plugin alone (`agent:plugin:<id>`) when the administrator clicks **Install**. Leaving it unticked revokes nothing: an existing grant is withdrawn from **Secrets**.
- **A secret not in the vault yet** has no box and reads **Not in the vault yet**, with **Create it on the Secrets page**. The plugin installs without it; once the secret exists, the administrator grants it from **Secrets** or from the card your plugin raises when it asks for it.
- **A secret already granted** to this plugin is shown as such, with no box. A name held by several secrets offers **Choose on the Secrets page**; a name stored for the other use (read instead of broker, or the reverse) counts as missing; with the vault turned off, no secret can be granted.
- **A host** has a tick-box, unticked. Ticked, it is opened to this plugin alone, never to the other plugins. A host already open to this plugin is ticked: unticking it closes it, since the plugin's hosts become exactly the ones ticked. A host the operator opened to every plugin (`pluginPolicy.http.allow`) has no box.

If what the sheet showed is no longer true when **Install** is clicked (a secret created, granted or deleted meanwhile, a host opened or closed in `rooks.config.json`), nothing is installed or granted: the sheet reloads with what is true now, to review and confirm again. If the installation fails, the grants made by that click are withdrawn and the plugin's hosts return to what they were.

The sheet is the only place where these grants are made in one gesture: `rooks plugin add` installs without granting anything. Grant from **Secrets** and open hosts in `rooks.config.json` afterwards ([Permissions](permissions.md)).

**Removing the plugin withdraws all of it.** `rooks plugin remove` deletes the hosts opened to the plugin, withdraws every vault grant to `agent:plugin:<id>` (the secrets themselves stay) and closes the cards it raised. A package installed later under the same id asks again, and nothing is granted until someone ticks it.

Use [Permissions](permissions.md) to understand caller identity and operator limits before building an outbound integration. A transport stores vault **names** in its connection configuration, not plaintext credentials.
