# Licensing

Timon is free software. Most of this repository is licensed under the
[GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only), with
one additional permission for plugins, written below. A few folders use the MIT
licence so that what you build on them stays yours.

| Path | Licence |
|---|---|
| Everything not listed below: the daemon (`orchestrator/`), the web app (`app/`), the desktop app (`desktop/`), the documentation site (`public-docs/`), the plugins in `plugins/` | AGPL-3.0-only, with the plugin exception |
| `packages/sdk/` (the `@timon-ai/sdk` package) | [MIT](packages/sdk/LICENSE) |
| `examples/` (the plugin templates) | [MIT](examples/LICENSE) |
| Third-party code bundled in this repository | its own licence, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## What the AGPL asks of you

You may use Timon for any purpose, personal or commercial, study it, change it
and share it. If you convey a copy, modified or not, or let other people use a
modified copy over a network, you give them the complete source code of that
copy under the same licence. You cannot turn Timon into closed software.

## The plugin exception

A plugin built on the SDK is a separate work: it is not bound by the AGPL, and
you may license it however you like, including as closed or paid software.

> **Additional permission under GNU AGPL version 3 section 7**
>
> As a special exception, the copyright holders of Timon give you permission to
> combine Timon with a Plugin and to convey the resulting combination, without
> the Plugin being subject to the terms of the GNU Affero General Public
> License, provided that the Plugin interacts with Timon only through the
> Plugin Interface.
>
> A "Plugin" is a work distributed as its own package, which Timon's plugin
> loader loads at run time, and which neither includes nor modifies any part of
> Timon other than the Plugin Interface.
>
> The "Plugin Interface" is the set of interfaces Timon documents for plugins:
> the `@timon-ai/sdk` package, the plugin manifest, and the slots, services,
> events and HTTP routes described as the plugin API at
> <https://docs.timon-ai.com/plugins>.
>
> This permission does not extend to a modified version of Timon itself, which
> remains covered by the GNU Affero General Public License. You may remove this
> additional permission from your copy, as section 7 of the licence allows; a
> work based on such a copy then no longer carries it.

## Contributing

Contributions are welcome under the terms of the [Contributor Licence
Agreement](CLA.md), which a bot asks you to sign once, by a comment on your
first pull request. It lets the project keep the plugin exception, offer its
code under other terms to organisations that need them, and change its licence
if one day it has to. Your contribution stays available to everyone under the
AGPL.

## Trademarks

The licences above cover the code. They do not grant any right to the Timon
name, logo or mascot: see [TRADEMARKS.md](TRADEMARKS.md). A product built from
this code needs its own name.
