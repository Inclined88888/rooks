---
title: Bundle
sidebar_position: 11
---

A bundle installs several separately identifiable plugins. Declare the exclusive `bundle` kind, list child manifest IDs in `contains` and declare their npm packages in `dependencies`. A bundle has no browser half.

`contains` identifies **what** to install; `dependencies` tells npm **where** to obtain it. Both are needed. `plugin-bundle` uses sibling file dependencies for the supplied page and widget examples; a distributable package needs resolvable dependency specifications.

## Secrets and hosts of the children

Each child declares its own `secrets` and `http.hosts`, and the install sheet shows them under that child's ID. What the administrator ticks is granted to that child alone (`agent:plugin:<child-id>`), never to the bundle or to another child.

The sheet can only show a child whose manifest it can read before anything is installed: a sibling `file:` dependency, or a copy shipped in the package's `node_modules`. A child resolved from the registry with no shipped copy is listed as unreadable, and is installed with nothing granted: the administrator grants its secrets afterwards from **Secrets**. A child already installed is listed as kept and is not touched. A child whose files no longer match their signature is listed as altered: it will not load, and nothing is asked for it.

Grants are written once the child is on disk, and only if it matches what the sheet showed (package, version, signature and declared names). So a child can start before its grants exist: read a secret when you need it rather than once in `apply`. When a child gets none of what was ticked (it did not land, it is not what the sheet showed, or the vault refused), the bundle stays installed and a warning names that child and why.

## Programs and voice of the children

The install sheet also shows, under each child's ID, the programs a `kind: provider` child launches (as found on this machine, with the sign-in folders and credential-store entries it declares) and where a `kind: dictation` child sends the voice. The same limit applies: a child the sheet cannot read before installing shows neither, and the sheet says so.

Each provider has its own box, off by default. A ticked program is allowed once the child is on disk, and only if it matches what the sheet showed (package, version, signature and `provider` block). Otherwise, or if the box stays unticked, the bundle still installs and that provider stays inactive until its program is authorized in **Settings → AI models → Providers**.

## Ownership and removal

Installing a bundle promotes missing children to the top level of the user's plugin installation. Each child can be enabled, moved or removed independently.

Newly installed children carry `installedBy: <bundle-id>` in their configuration. Removing the bundle removes only children carrying that ownership marker. A child already present remains untouched. Reinstalling a child directly clears the marker, making it independent of the bundle.

Expansion stops after one level. A bundle listed inside another bundle is installed but is not recursively expanded; this avoids cycles.

A client-only child can be active without a `main` entry: the daemon serves its browser bundle without executing host code. Multiple UI registrations from one package are not a bundle; see [Kinds](kinds.md).
