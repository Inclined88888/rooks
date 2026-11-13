---
title: Publishing
sidebar_position: 17
---

## Prepare a distributable package

First make sure the plugin runs without you: [Ship to someone else](distribution.md) covers personal data, self-contained packages, settings and secrets, and the pre-ship check.

1. Choose your npm package name and a manifest ID accepted by the current validator.
2. Declare the minimum API version and only the permissions needed.
3. Build the ESM browser entry with shared platform imports kept external.
4. Include host/browser entries, manifest and local image assets in the package. Check the file list with `rooks plugin check .`, which also flags what should not ship ([Pre-ship check](distribution.md#pre-ship-check)).
5. Replace example sibling `file:` dependencies with dependency specifications that recipients can resolve.
6. Test the resulting archive using `rooks plugin add ./package.tgz` on a separate instance.

The source examples are private npm packages. Their names are not a promise that they are published in a registry. Remove `private` only in your own package when you intend to publish it, under a scope you control.

## Sign the final contents

Rooks verifies Ed25519 signatures over package contents. The authorised signing workflow creates `SIGNATURE`; changing a covered file afterward invalidates it. A present but invalid signature is refused rather than treated as simply unsigned.

```bash
rooks plugin sign ./my-plugin
```

This command requires an authorised local private key. A plugin author does not automatically possess that key or the ability to create a signature trusted by every installation. Coordinate signing with the distributor; no public submission endpoint is specified here.

:::danger Never ship signing credentials
Do not commit, package or send a private key with your plugin. Sign the final package contents and retest the exact artifact you distribute. No lifecycle script runs during installation, so a `postinstall` cannot finish a missing build.
:::

## Describe the result

Provide a useful label, short description, author, a local `icon` (SVG) and local cover/screenshots. Explain required permissions, settings, compatible API version and what disappears when the plugin is disabled. Do not describe signature verification as process isolation.

Use `rooks plugin remove YOUR_PLUGIN_ID` to remove the installed package. Plugin data is retained, except the secrets of its incoming webhooks, which are deleted, the vault grants made to it (`agent:plugin:<id>`), which are withdrawn, its entries in `pluginPolicy.spawn.approved`, `pluginPolicy.kanban.projects` and `pluginPolicy.http.byPlugin`, which are deleted from `rooks.config.json`, and its [user connections](connections.md#when-your-plugin-is-removed), which go back to approval without their keys. A reinstall has to be approved again. A package that left another way (folder deleted, `npm uninstall`) is handled when a different one takes its id: everything granted to the id is withdrawn before the new package runs, its settings (including [secret settings](secrets.md)) and its storage are deleted, its data folder is moved to `plugins-data/.trash/`, and the operator gets a card listing it: the new package starts from scratch. If the folder cannot be moved (a file still open on Windows), the new package is not loaded until it can be. The same package under the same npm name, updated, keeps everything. The signed release of a package installed unsigned (a release candidate, for instance) is an update too: data, settings, storage, grants and connections are kept, and the install sheet says so. The reverse is not: an unsigned copy of a signed package counts as a different one. Bundle removal follows the [child ownership rules](bundle.md).
