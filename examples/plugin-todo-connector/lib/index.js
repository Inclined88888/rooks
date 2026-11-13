/**
 * Template of a TO DO connector: GitHub Issues ↔ the notebook. It shows the
 * five pieces every connector is made of; the Discord connector
 * (`examples/plugin-todo-connector-discord`) is the complete one.
 *
 *   1. in      `ctx.webhooks.on`        a signed call from the service
 *   2. create  `ctx.kanban.todos.create` the idea WITH its external reference,
 *                                        so a replay lands on the same idea
 *   3. out     `ctx.events.on` + `ctx.outbox.post`  durable, ordered, credentialed
 *   4. echo    `event.origin`           drop what this plugin wrote itself
 *   5. refs    `todos.links.findByRef`  find the idea behind a ticket
 *
 * `"auth": "github"` in the manifest: the host verifies GitHub's own
 * `X-Hub-Signature-256` before this handler runs, so GitHub calls the plugin
 * directly, no relay. In the repository's webhook settings: Payload URL = the
 * address shown in Settings › Plugins, Content type = `application/json`
 * (`request.json()` cannot read the form encoding), Secret = the one generated
 * there, events = Issues.
 */
export const name = 'todo-connector-github'

const PROVIDER = 'github'

/** @param {import('@rooks/sdk').PluginContext} ctx */
export function apply(ctx) {
  const repository = () => String(ctx.settings.get('repository') ?? '')
  const refOf = (issue) => `${repository()}#${issue.number}`

  // 1 + 2: a ticket opened on GitHub becomes an idea, once.
  ctx.webhooks.on('issues', async (request) => {
    // GitHub's first call is a `ping` with no issue: nothing to do.
    if (request.headers['x-github-event'] !== 'issues') return
    /** @type {{ action?: string, issue?: { number: number, title: string, body?: string | null, html_url: string } }} */
    const { action, issue } = request.json()
    if (!issue) return
    if (action === 'opened') {
      await ctx.kanban.todos.create(
        { text: `#${issue.number} · ${issue.title}`, notes: issue.body ?? null, author: PROVIDER },
        [{ provider: PROVIDER, ref: refOf(issue), url: issue.html_url, label: `#${issue.number}` }],
      )
    }
    // 5: a ticket closed on GitHub closes its idea.
    if (action === 'closed') {
      const idea = await ctx.kanban.todos.links.findByRef(PROVIDER, refOf(issue))
      if (idea) await ctx.kanban.todos.close(idea.id) // origin = this plugin
    }
  })

  // 3 + 4: an idea closed in Rooks closes its issue on GitHub.
  ctx.events.on('todo_done', async (event) => {
    if (event.origin.kind === 'plugin' && event.origin.id === ctx.id) return // our own echo
    const link = event.todo.links.find((l) => l.provider === PROVIDER)
    if (!link) return
    const number = link.ref.slice(link.ref.lastIndexOf('#') + 1)
    await ctx.outbox.post(
      `https://api.github.com/repos/${repository()}/issues/${number}`,
      { state: 'closed' },
      {
        method: 'PATCH',
        key: `todo:${event.todo.id}`, // one lane per idea: outcome, then closure
        auth: { secret: String(ctx.settings.get('tokenSecret') ?? 'GITHUB_TOKEN') },
        headers: { accept: 'application/vnd.github+json' },
      },
    )
  })
}
