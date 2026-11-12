# TO DO connector template (GitHub Issues)

A starting point for a plugin that keeps the notebook and an issue tracker in
step. Read `lib/index.js` (about 60 lines), copy the folder, change the
manifest `id`, then adapt the four handlers. The reference guide is
[Syncing the Kanban](../../public-docs/docs/plugins/kanban-sync.md), with
[Receiving webhooks](../../public-docs/docs/plugins/webhooks.md).

Needs: the vault entry named by `tokenSecret` (`GITHUB_TOKEN` by default)
granted to the plugin by name
(`rooks secret grant GITHUB_TOKEN --scope agent:plugin:<id>`; a `global` grant does
not reach plugins) and the
host `api.github.com` opened to it. The manifest names both
(`secrets`, `http.hosts`), so the install sheet offers to grant the entry and
open the host to this plugin alone (`pluginPolicy.http.byPlugin`) in one tick; if you read
another entry or reach another host, declare it there too. GitHub calls the plugin
directly: the manifest declares `"auth": "github"` (contract 8), and the host
verifies `X-Hub-Signature-256` before the handler runs.

On GitHub, *Settings › Webhooks › Add webhook* of the repository:

1. **Payload URL** — the address shown for the `issues` webhook in Rooks's
   *Settings › Plugins*.
2. **Content type** — `application/json`.
3. **Secret** — click *Generate* in Rooks and paste the value shown once.
4. **Events** — *Let me select individual events* › **Issues**.

GitHub's first call is a `ping`; the handler ignores it and Rooks answers 200.
