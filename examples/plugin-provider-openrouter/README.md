# OpenRouter provider pack

A ready-to-install declarative pack: one backend, OpenRouter, reached through
its OpenAI Responses endpoint (`https://openrouter.ai/api/v1`) by the installed
`codex` CLI dialect. Like `plugin-provider-pack`, it contains no JavaScript and
no `main`; the loader never imports code from it.

Install with `rooks plugin add ./examples/plugin-provider-openrouter`. Normal
plugin signature and licence rules apply; an unsigned local copy requires the
operator's `developer.unsignedPlugins` setting. Installation displays the
`backends:register` permission: this pack sends mission prompts to OpenRouter.

Then open the plugin's settings and enter your OpenRouter key in
**OpenRouter API key**. The daemon seals it at rest and hands it to each
mission as `BACKEND_OPENROUTER_API_KEY`, the variable `providerConfig.envKey`
names. Until a key is saved the backend is listed as inactive, with the reason;
saving it activates the backend without a restart, clearing it deactivates it.

The model list is not written in the manifest. `modelsEndpoint` points at
OpenRouter's public model listing, which needs no key: Rooks reads it in the
background, at most once every 30 minutes, so models OpenRouter adds or retires
appear in the selectors without a new version of the pack. While the listing
cannot be reached, the model field is free text: type the model ID as
OpenRouter writes it, `<vendor>/<model>`.

The backend ID is `openrouter-pack`, not `openrouter`, so it does not collide
with an `openrouter` backend written by hand from the *Add a provider* recipe.
IDs cannot replace product, plugin or local-file backends: a collision is
reported in the plugin status and the backend stays out of the menus.

To adapt the pack to another provider with a fixed OpenAI Responses endpoint,
copy the folder, change `name`, `rooks.id`, the backend `id`, `baseUrl`, the
`BACKEND_<NAME>_API_KEY` variable in both places and `modelsEndpoint`. For an
address that differs for each user, such as a self-hosted LiteLLM proxy, a pack
brings nothing: add the backend from **Settings → AI models → LLM backends**
instead.
