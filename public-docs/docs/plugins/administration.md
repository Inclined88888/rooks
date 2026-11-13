---
title: Administration and system
sidebar_position: 13.8
---

A plugin can look after the installation itself: the vault, accounts, plugins, backups, the project browsers, the machine's health. Requires `apiVersion: 10`. **Every permission on this page is sensitive except `docs:read` and `license:read`**: `rooks plugin add` names them apart before you confirm the install, and a plugin that asks for one should say why.

All calls run with the rights of the account that makes the request, never more. Called outside a request (a background job), the plugin acts as itself and gets only what is said below. Errors carry a `code`: `invalid`, `not_found`, `conflict`, `forbidden` or `unavailable` (`PluginAdminError`); a refused caller gets a `PluginCallerError`, a permission missing from the manifest a `PluginPermissionError`. Every change made this way leaves a line in the audit log naming the plugin and the account.

| Permission | Surface |
| --- | --- |
| `secrets:list` | `ctx.secrets.list()` — names, modes and grants, never a value |
| `secrets:manage` | `ctx.secrets.set / grant / revoke` |
| `secrets:broker` + `http:outbound` | `ctx.secrets.httpCall()` — an HTTP call under a brokered identity |
| `accounts:read`, `accounts:manage` | `ctx.users`, `ctx.backendAccounts` |
| `plugins:read`, `plugins:manage` | `ctx.plugins.list / setEnabled`, `ctx.modules.list` |
| `system:read`, `system:logs` | `ctx.system.health / doctor`, `ctx.system.logs` |
| `backup:read`, `backup:manage` | `ctx.backup.status / enable` |
| `browser:read`, `browser:manage` | `ctx.browser.list / status / start / stop` |
| `docs:read` | `ctx.docs.search / read` |
| `license:read` | `ctx.license.edition()` |

A `:manage` permission covers its `:read`.

## Secrets

Nothing here returns a value. `ctx.secrets.get` (permission `secrets:read`) still only returns what was granted to your plugin.

```js
const known = await ctx.secrets.list();                       // account needs secrets:manage
await ctx.secrets.set({ name: 'CRM_TOKEN', value });          // creates; nobody can read it until a person grants it
await ctx.secrets.grant('CRM_TOKEN', 'agent:support');         // a superadmin's request only
const res = await ctx.secrets.httpCall({ identity: 'CRM_API', path: '/v1/contacts' });
```

- `list` in a request shows the whole vault to an account that manages secrets. In a job it shows the secrets your plugin deposited and the ones granted to it.
- `set` creates a name that does not exist yet, with **no grant**. It changes an existing secret only if your plugin created it, or if the request comes from a superadmin. A name held at several scopes answers `conflict`: use the Secrets page.
- `grant` and `revoke` are a superadmin's, in a request: a job and a plain account are refused. `scope` is `project:<slug>` or `agent:<name>`. A plugin never grants `global` nor `agent:plugin:…`, since either would let a plugin read a value it was not given, nor `backend:<id>`. `revoke` takes any scope but `backend:<id>`: a key reserved to a backend stays reserved unless an administrator changes it on the Secrets page.
- `httpCall` acts as the agent `plugin:<your id>` and also needs `http:outbound` in the manifest. The identity must be a brokered secret granted to your plugin by name (`agent:plugin:<id>`); a `global` grant does not reach plugins. The target must be both among the identity's hosts and allowed for your plugin (`pluginPolicy.http.allow`, or `pluginPolicy.http.byPlugin` under your ID), the same rule `ctx.fetch` obeys: the operator allows the host once for both, or ticks it on the install sheet when your manifest [declares it](secrets.md#name-what-you-will-ask-for). Redirects are returned, never followed, the value is masked in the answer and every call is journalled. Fields: `identity`, `path`, optional `method`, `host`, `headers`, `body`. The answer is `{ status, body, host }`. A refusal has `code` `forbidden`/`not_found`/`invalid` and a `reason` (`no-grant`, `host-denied`, `policy-denied`, `unknown-identity`…).

## Accounts

A superadmin's request only — a call triggered by a signed webhook or an event, which runs as an account but never as a superadmin, is refused too. A job, an anonymous request and any other account — even one holding every right — are refused.

```js
const users = await ctx.users.list();
await ctx.users.setStatus(id, 'disabled');          // revokes sessions and tokens
await ctx.backendAccounts.grant(accountId, [userId]); // who may use a subscription account
```

What you do not get, on purpose: no credential ever comes back; no account can be created, invited, promoted or have its password reset; and the status of a superadmin cannot be changed.

Rooks itself has no roles or groups to arrange: who may do what on an install with several accounts is decided by the plugin that serves those accounts, through `ctx.permissionSource` (below).

## Adding accounts

A plugin that manages a team's accounts — invitations, sign-ups, a directory — declares the sensitive permission `accounts:provision` and receives `ctx.accountProvider`. Only a signed plugin gets it, and one plugin at a time: the first to call it holds it until it is unloaded; another one is refused with `code: 'held'`.

```js
const account = ctx.accountProvider.provision({ email, name, password });   // status 'active' by default, or 'invited'
ctx.accountProvider.openSession(account.id, req, res);                       // sets the session cookie, as a login does
const stop = ctx.accountProvider.onAccountChanged(({ userId, status, previous }) => { /* tidy your own tables */ });
```

- Rooks creates the account itself: it hashes the password (at least 8 characters), checks that the e-mail is free, and applies what the licence allows. `provision` never creates a superadmin.
- `openSession` opens a session only for an active account that is not a superadmin.
- Each creation and each session opened writes a line in the audit log, under `plugin:<your id>`.
- Errors carry a `code`: `not_trusted`, `held`, `invalid`, `duplicate` or `refused` (the licence, for example).
- A signed plugin that declares the permission holds the provider as soon as it starts, not at its first call.
- `list()`, `get(id)` and `findByEmail(email)` read the install's accounts, superadmins included. No password hash or address ever comes back.
- `update(id, { name, password, status })` changes an account that is not a superadmin: Rooks hashes the new password and closes that account's other sessions, `status: 'disabled'` closes them all, and `'active'` checks the licence again. A superadmin is refused whole, and no plugin can make an account superadmin.
- `audit(action, target)` writes a line in the audit log under `plugin:<your id>`, for the account of the current request. `auditLog(limit)` reads the latest lines back, newest first (at most 1000).
- `GET /api/auth/account-provider` tells a visitor without a session which plugin holds the provider, so an invitation page knows whose public routes to call.
- `ctx.accountProvider.readLegacy(table)` reads, whole, one of the account tables Rooks kept before accounts moved to a plugin (`roles`, `role_permissions`, `user_roles`, `groups`, `group_roles`, `user_groups`, `invitations`), so the plugin can copy them into its own database once. Rooks no longer has these tables: when it updates, it keeps their rows in a file of its home that only its own account can read, and `readLegacy` reads them from there. On an install that never had them, it returns `[]`.
- Accounts beyond the first superadmin need a pro licence and an account provider plugin. Without either, they are suspended, never deleted: they cannot sign in, their data stay, and the superadmin gets a card saying why. They get their access back as soon as both are there.

## Providing the accounts' rights

A plugin that keeps roles and groups in its own database tells Rooks which rights each account holds. It declares the sensitive permission `accounts:permissions-source` and registers one function:

```js
const rights = ctx.permissionSource.register((userId) => {
  return ctx.sql.prepare('SELECT permission FROM grants WHERE user_id = ?').all(userId).map((row) => row.permission);
});
rights.invalidate(userId);   // after a change of role or group; without an id, for every account
```

- Rooks keeps checking the rights itself: the function only answers the question, synchronously.
- The answer is cached until you call `invalidate`. A function that throws grants nothing.
- A superadmin keeps every right, whatever the function answers.
- Only a signed plugin gets it, one at a time; it is released when the plugin is unloaded. Without a source, an account that is not a superadmin holds no right at all: Rooks keeps no roles or groups of its own.
- `ctx.permissionSource.catalog()` lists the rights a role can grant on this install: the checks Rooks runs, then the pages, widgets and plugins that are active. Build a role editor on it rather than on a list of your own.

## Plugins and modules

```js
const installed = await ctx.plugins.list();   // a request sees what its account may see; a job sees everything
const modules = await ctx.modules.list();
await ctx.plugins.setEnabled('@rooks/telegram', false);
```

`setEnabled` needs the `plugins:manage` right on the account for a bundled module, and a superadmin for a third-party plugin. It is refused in a job and on your own plugin. Mind what that means: a plugin holding `plugins:manage`, in a request made by a superadmin, can switch off another third-party plugin, a monitoring plugin for instance. That is why `plugins:manage` is sensitive and why the operator reads it at install. Core modules cannot be switched off. Installing and removing plugins stays with the operator.

## System, backup, browser, docs, license

- `ctx.system.health()` — liveness, live missions, resource and memory figures. `doctor()` — the machine report (binaries, capabilities); a superadmin's request, or a job. `logs({ kind: 'daemon' | 'desktop', lines })` — the last lines, newest first, vault values masked, never the prompts log; a superadmin's request only, never a job.
- `ctx.backup.status()` and `enable()` (idempotent; there is no `disable`). Both are a superadmin's request, or a job: the status names where the archives of every account lie.
- `ctx.browser.list / status / start / stop(project)` — a request sees its account's sessions, a job the ones it started; another's session answers like a missing one. The debugging endpoint of the browser is never returned.
- `ctx.docs.search(query)` and `ctx.docs.read(route, heading?)` — this version's documentation, offline.
- `ctx.license.edition()` — `'lite'` or `'expert'`, and nothing else. Activating, installing or removing a licence is not available to plugins.
