# Declarative provider pack

This package contains no JavaScript and no `main`. Replace the example URLs
and model IDs in `package.json` with your provider's data before using it.
The Anthropic-compatible endpoint uses the installed `claude` CLI dialect;
the OpenAI Responses endpoint uses the installed `codex` CLI dialect.

Install with `rooks plugin add ./examples/plugin-provider-pack`. Normal plugin
signature and licence rules apply; an unsigned local example requires the
operator's `developer.unsignedPlugins` setting. Installation displays the
`backends:register` permission: this pack chooses where mission prompts go.

Enter the key in the plugin's settings. `{ "setting": "apiKey" }` reads only
this plugin's declared secret setting. The daemon seals it at rest and resolves
it for each mission. Saving, replacing or clearing the key takes effect without
reloading the plugin. A secret default in the manifest is not used.
`{ "secret": "VAULT_ENTRY_NAME" }` can instead reference a vault entry; normal
mission grants still apply.

Each entry uses the same strict schema as a local backend file. Executable
commands, inherited environment variables and unsafe environment names are
rejected. An invalid entry does not prevent its neighbours from loading; its
reason is reported in the plugin status. IDs cannot replace product, plugin or
local-file profiles. Disabling or removing the pack unregisters its profiles.
