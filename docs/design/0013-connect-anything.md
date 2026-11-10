# 0013: Connect anything, automate the work

Status: design record, 2026-11-09. Nothing here is built. Read from `.claude/worktrees/industrial` (code) and
`.claude/worktrees/windows/docs/design/0012-work-suites.md` (Microsoft 365 and Google Workspace, being built now; this
record does not repeat that work). Grows from `mcp_client.py`, `skills_hub.py`, `connect.py`, `automations.py`,
`scheduler.py`, `needs_you.py`, `actions.py`, `egress.py`, `adapt/playbooks.py` and section h of `docs/architecture.md`.

The owner: "Pure professional and capable of doing all types of automations and connecting to and figuring out to
connect any type of services and tools and every work related everything." The audience is workplace teams that live in
web apps.

Rules kept: plain words on normal screens; every write to an outside service waits for the person's yes unless the
person made a standing rule for exactly that; a background run never approves its own request or gains the person's
rights through a shared key; never fake results; secrets never in logs or chat.

## 0. What exists today, from the code

| Part | Today | Gap for this record |
|---|---|---|
| Outside tool servers (`mcp_client.py`, `mcp_client_api.py`) | stdio, Streamable HTTP and old SSE; secrets encrypted; every tool taints the turn; every call held unless the tool says `readOnlyHint` (`assistant.py:909`) | **No sign-in for remote servers**: only fixed headers, no OAuth. Catalogue is six reference servers (filesystem, GitHub, fetch...). **A server's own `readOnlyHint` lets a tool skip the yes**, so a hostile server can label "send" as read only. Tool lists are not pinned; a changed description is not noticed. stdio servers started by `npx`/`uvx` run unsandboxed code that was never scanned (`skills-security.md`, known gaps). |
| Skills gate (`skills_hub.py`, `skill_scan.py`, `skill_sandbox.py`) | Pinned fetch, code and injection scans, permission manifest, sealed trial run, risk verdict, typed `install <name> anyway` for High, run-time grants, audit | Not applied to tool servers it does not launch |
| Provider sign-in (`connect.py`, `oauth_clients.py`) | Loopback plus PKCE for Google and Microsoft; tokens in keychain or encrypted; refresh, revoke | Two providers only, client ids empty in this build |
| Automations (`automations.py`) | Triggers: email, calendar, site, folder, schedule, share. One action. "Ask first". The `automation` channel holds every outside write (`AUTOMATION_REASON`) | No webhook, chat message, ticket or cloud-file trigger; one step only; no conditions; no retries; no per-automation cost cap; **no standing rules** (the only rules, `kn_improve.hold_reason`, are stricter-only) |
| Schedules (`scheduler.py`) | Cron in local time, a late job runs once | No retries, no run history table (0004 section 7 item 3) |
| Held actions (`actions.py`, `needs_you.py`) | Exact arguments kept encrypted, run once on yes, a second answer refused | Approval only in the app, phone or terminal |
| Outbound record (`egress.py`) | Every httpx, requests, IMAP and SMTP connection is a row | Stays on one computer; no export for IT |
| Teach by showing (`adapt/playbooks.py`, `adapt/recorder.py`) | Recording plus narration becomes plain steps; replay through Rooks Browser or Rooks Desk, pausing on send, pay, submit | Only the browser recorder is wired |
| Trackers (`team/trackers.py`), channels (`teammates/channels.py`) | Jira, Asana, Trello read only with personal tokens; Slack by Socket Mode, Discord, Telegram | No write-back; Slack is a chat surface, not a connector |
| People | One owner by design (`security.py`) | No admin, roles or team policy |

## 1. The outside world, checked 2026-11-09

Sources are listed at the end. "Confirmed" means a vendor page or the protocol's own site; "reported" means secondary
sources only.

- **Registry.** The official MCP Registry (registry.modelcontextprotocol.io) launched 8 September 2025 and is reported
  still a preview with its API frozen at v0.1. Server counts in secondary sources disagree by an order of magnitude; I
  could not confirm a figure. Listings carry an `active` or `deprecated` status and a namespace tied to a verified
  domain or GitHub account, which is what lets Rooks say "who made it".
- **Remote sign-in.** The MCP authorization spec (2025-11-25, confirmed) makes a remote server an OAuth 2.1 resource
  server: Protected Resource Metadata (RFC 9728) tells the client where to sign in, Client ID Metadata Documents are
  the recommended way for a public client like Rooks to identify itself, and dynamic registration is now optional.
  A later 2026 revision is mentioned by secondary sources; not checked.
- **Vendors with an official server** (reported unless marked):

| Vendor | Official MCP server | Notes |
|---|---|---|
| Microsoft | Yes, inside Copilot Studio (Outlook, Teams, SharePoint, OneDrive, Word, Dataverse, Dynamics 365) - confirmed on Microsoft Learn | Wired through Power Platform; not a public endpoint Rooks can sign in to. Rooks keeps its own Graph code (0012). |
| Google | Workspace servers (Gmail, Drive, Docs, Sheets, Calendar, Chat) in Developer Preview; 50+ managed Google Cloud servers (confirmed on Google's blog) | Preview program membership needed; GA not confirmed. Rooks keeps 0012. |
| Atlassian | Remote, OAuth 2.1 | Path `/v1` or `/v2` disputed between sources |
| Salesforce | Hosted servers, reported GA April 2026, Enterprise and up | Needs an External Client App set up by the customer's admin |
| HubSpot | Remote, reported GA April 2026, OAuth 2.1 with PKCE | |
| Notion | Remote at `mcp.notion.com`, OAuth | Old local server retired |
| Asana | Remote V2, OAuth | Reportedly needs a registered client id and secret |
| monday.com | Remote, OAuth or personal token | Developer docs page exists |
| Slack | Yes - Slack's own help centre guide | |
| Zoom | Yes, hosted, Streamable HTTP - Zoom developer docs | |
| Xero | Open-source local server by XeroAPI | Can create invoices and payments: writes |
| QuickBooks (Intuit) | Early preview, local, for developers | Not a turnkey connection |
| ServiceNow | **Not confirmed.** Its docs show it consuming MCP servers in AI Agent Studio, not publishing one | Built-in connector needed |
| Zendesk, Box, Dropbox | **Not confirmed** from vendor pages (Box and Dropbox are named in Slack's guide) | Treat as unverified |

- **Leading assistants.** Claude has a curated connectors directory plus custom remote connectors that an organization
  owner adds once and each member signs in to. ChatGPT reportedly asks before every write unless approval is
  remembered for that conversation, with per-app settings up to "allow all", and admins on business plans turn write
  actions on. Zapier MCP reports 9,000+ apps and has a paid "Human in the Loop" step. n8n has official per-tool human
  review for AI agent tool calls, with requests sent to Slack, Gmail, Teams or n8n Chat. Make acts as an MCP client.
  Copilot Studio has multistage approvals in agent flows; per-tool approval was on Microsoft's roadmap for September
  2026 and I could not confirm it shipped.
- **Attacks.** Tool poisoning (hidden instructions in a tool description) and the "rug pull" (a server changes a tool
  after approval, using `tools/list_changed`) are documented since April 2025. Pinning the approved description and
  asking again on change is the standard defence; it does not catch a change in the server's code.

## 2. Connect anything: four tiers, tried in order

### 2.1 What the person sees

A **Connections** page (rename of today's MCP page, which moves under Advanced). One search box: "What do you want to
connect?" Results come from tier (a); if nothing matches, one button: "Ask Rooks to find a way". Every connection card
shows, in plain words: who made it, what it can **read**, what it can **change**, when it last worked, and Disconnect.

### 2.2 The tiers

| Tier | What | How it signs in | Writes |
|---|---|---|---|
| (a) Catalog | ~40 work services checked by hand: the official remote server where one exists (Atlassian, Salesforce, HubSpot, Notion, Asana, monday.com, Slack, Zoom), else a built-in connector written in Rooks (ServiceNow, Zendesk, Xero, QuickBooks, Trello, Box, Dropbox). Microsoft 365 and Google Workspace stay in 0012's Work apps. | One click: OAuth 2.1 with PKCE through the loopback listener `connect.py` already has; a key form only where the vendor offers nothing else | Held |
| (b) "Rooks, connect to X" | The assistant searches the registry and the vendor's own developer pages, then shows a plan card | Same secure form; the key never passes through chat or the model | Held |
| (c) Any OpenAPI or plain REST API | Tools generated from the description (one per operation, `GET` as read, everything else as change) | Key or OAuth through the form; the host is fixed to the description's server | Held, always |
| (d) No API | Teach by showing (`adapt/playbooks.py`), replayed by Rooks Browser or the Room's browser; the browser extension later | The person signs in once in that browser | Held at each send, pay, submit |

Catalog entries record `source` (official remote, official local, built-in, community), the vendor page it was
checked against and the date. An entry that cannot be checked says "Not checked yet" and is not one-click.

### 2.3 Tier (b), step by step

1. **Find.** Search the official registry by name, then the vendor's own domain. Prefer, in order: official remote
   server, official local server, vendor OpenAPI description, community server. A community server is never chosen
   when an official route exists.
2. **Plan card** in Needs you (new kind `c:<plan id>`): "Connect to Acme Desk. Made by Acme (acme.com, verified in the
   official list). It will be able to read: tickets, customers. It will be able to change: reply to tickets, close
   tickets. Every change waits for your yes." Advanced shows the address, the scopes and the registry entry.
3. **Sign in.** OAuth in the person's own browser, or the key form (`security.store_connection_secret`). The model
   only ever sees "configured: yes".
4. **Check.** Code from outside (a local server, a package) goes through the skills gate: pinned version, scans, sealed
   trial run, risk; High needs the typed phrase. A remote server is not code on this computer, so it gets the tool
   checks instead: descriptions scanned by `skill_scan.injection_scan`, and the tool list pinned (hash per tool).
5. **Test read only.** Call one read tool (list, whoami) and show the real answer. A failure is shown as a failure.
6. **Save** on a second yes, with the pinned tool list.

**What the assistant may do by itself:** search the registry and vendor pages, read public documentation, draft the
plan, run the read-only test after sign-in, report what failed. **What always needs the person:** signing in or giving a
key, installing or starting any code, saving the connection, widening its scopes, accepting a changed tool list, and
every change it makes in the service. A connection the assistant proposes from inside an automation or a schedule only
becomes a plan card; it cannot be saved from there.

### 2.4 Tier (c), generated tools

`openapi_connect.py` reads OpenAPI 3.x (or a pasted list of endpoints), makes at most 40 tools, names them in plain
words from `summary`, and marks **only** `GET`/`HEAD` as read. Requests go only to the description's server host
(checked per call, recorded in `egress`). No redirects to other hosts. Response bodies are untrusted content.

## 3. Automations: "When X happens, do Y, ask me before Z"

### 3.1 Shape

Today's `automations` row grows into a recipe: one trigger, an ordered list of steps, optional conditions, and limits.
New tables `automation_steps` and `automation_runs` (next `SCHEMA_VERSION`).

| Part | Contents |
|---|---|
| Triggers | Existing: schedule, new mail, calendar, site, folder, share. New: a Teams or Slack message in a chosen channel, a new ticket or form entry (any connected service with a "list new" read tool, polled), a file added in OneDrive, SharePoint or Drive (through 0012's tools), a webhook |
| Steps | Any read or change tool from any connection; "ask the assistant" (a model step with a written goal); a playbook; "wait for my yes" |
| Conditions | Plain comparisons on the trigger's fields ("subject contains invoice", "priority is high"); no code |
| Limits | Time limit per run (default 10 min), cost cap per run and per month (from `usage.py` prices), max runs per hour (today 10), retries for reads (3, backing off), **never** an automatic retry of a change that may have reached the service |
| Run history | Per run: trigger event, each step, its outcome, cost, what is waiting; kept 90 days; exported with the run log |

Webhooks follow 0004 section 7 item 4: a secret path plus HMAC signature, a five-minute timestamp window, a nonce store
and a rate limit. Rooks has no public address, so a webhook works only on the server install or through a relay; the
page says so instead of showing an address that cannot be reached.

### 3.2 Standing rules

A standing rule is the only way a change runs without a fresh yes. It is made **only by the person**, on the
authenticated app (never through the bridge key, a tool, an automation or the app's own tool server), and it is exact:

`allow <tool> on <connection> where <fixed arguments>` - for example "post to #ops in Slack", "add a comment to tickets in
project OPS". It never covers a different channel, recipient, project or a delete. It has an optional end date and a
daily count, shows in Settings and on each run, and is offered after the person has said yes to the same action three
times ("Always allow posting to #ops?"). `hold_reason` checks it last, only for the `automation` and `schedule`
channels, and only when the turn holds no untrusted content that named the target. Every use is a run log row.

### 3.3 How they are built

1. **By chat.** "Every Monday at 8, collect last week's tickets and post a summary to Teams." `automations.parse`
   handles the common phrasings without a model; otherwise the model drafts the recipe. Either way the person sees the
   recipe card and it is created **off**; turning it on is the yes (as `starters.py` does today).
2. **By teaching.** Record once; the playbook becomes a step.
3. **On the Automations page.** Trigger, steps, conditions, limits, picked from lists.

### 3.4 Templates

| Template | Trigger | Steps | Waits for a yes |
|---|---|---|---|
| Weekly report | Monday 08:00 | read tickets and tasks, summarise | posting to Teams or Slack |
| Meeting follow-up | a meeting with a transcript ends | notes, actions, draft mail | sending the mail, creating tasks |
| Invoice chase | daily | read overdue invoices (Xero or QuickBooks), draft reminders | sending each reminder |
| New starter | a form entry or HR ticket | checklist, draft accounts request, calendar invites | each account request, invite and message |
| Ticket triage | new ticket | classify, suggest owner and reply | assigning, replying, closing |

## 4. Admin for a team

Rooks is one person per computer today; a real team admin needs the people and workspace work in 0004 section 7
item 7 and architecture section h rank 2. Until then, a **policy file** an IT team can push (signed with a key the app
pins at install): allowed connections and their maximum scopes, whether tier (b), (c) or (d) is on, whether standing
rules are allowed, and the run log retention. A connection or scope outside the policy shows "Your company has not
allowed this" with no override. **Audit export**: the run log, decisions, egress rows and connection changes as CSV and
JSON, redacted as they are stored, from `history.py`'s existing export. With workspaces later, the same policy becomes
an admin page and the export goes to the admin.

## 5. Security, item by item

| Threat | Answer |
|---|---|
| Too-wide scopes | Ask for read scopes first; change scopes only when a change tool is turned on (0012's pattern). The card lists the scopes the provider actually granted, not those asked for. |
| Token storage | Keychain or Fernet as today; refresh tokens never leave the app; access tokens sent only to the host in the connection's metadata (`resource` indicator); tokens redacted from every log, run log and egress row (test). |
| Malicious tool server | **Ignore the server's own read-only label for holding**: a tool counts as read only when the catalog entry or the person says so. Pin each tool's description and schema; any change, including `tools/list_changed`, disables the changed tools until the person accepts a diff. Local servers only through the skills gate and the sandbox, never a bare `npx`. Name clashes between servers refused. |
| Prompt injection from connected data | Every tool result is untrusted (as today); a tainted turn holds every change and every local write; the held card shows where the instruction came from; a standing rule does not apply when untrusted content in the same run named the target. |
| A background run approving itself | Decisions are accepted only from a signed-in person session or the paired phone; the bridge key, the tool key, the terminal's bridge, automations and teammates have no route to `assistant.decide`, to standing rules or to saving a connection (tests per channel). A repeat of the same held call is the same request, never a second one. |
| Cost and loops | Per-run and monthly caps stop the run and say so; automations cannot create automations or schedules. |
| Phishing through tier (b) | Only registry entries with a verified namespace or the vendor's own domain are offered; the plan card shows the domain. |

## 6. Build order (after 0012's M0 to M4 and G1 to G3)

| Phase | Work | Acceptance tests (real runs against fake servers) |
|---|---|---|
| C0 | Close the gaps: ignore `readOnlyHint` for holding unless the catalog says so; pin tool lists; handle `tools/list_changed` | A fake server that marks "send" read-only is held; a fake that changes a description after approval has that tool disabled until accepted. Both fail on today's code. |
| C1 | Remote sign-in for tool servers: RFC 9728 discovery, OAuth 2.1 with PKCE on the loopback, Client ID Metadata Document | A fake MCP server and fake authorization server: 401 with metadata, sign-in, refresh, revoke; the token never appears in logs or egress |
| C2 | Catalog of checked services, Connections page, terminal `/connect` with the same words | Each entry signs in to a fake that enforces scopes; a call outside the scope is refused by the fake and never sent; parity test across app and terminal |
| C3 | Tier (b): plan card, read-only test, second yes; local servers through the skills gate | A malicious fixture server is High and refused without the typed phrase; nothing is saved without both yeses; an automation that asks to connect only creates a card |
| C4 | Tier (c): OpenAPI tools | A fake API: `GET` runs, `POST` holds and runs once on yes with stored arguments; a call to another host refused |
| C5 | Automations v2: steps, conditions, runs table, limits, retries, webhook, chat and ticket triggers | Fake Slack and fake ticket service fire a run; a step that times out is reported; the cost cap stops a run; a failed change is not retried; a webhook with a bad signature or old timestamp is refused |
| C6 | Standing rules | A rule for #ops lets the fake receive one post with no yes; a post to #general still holds; a rule cannot be created with the bridge key or from an automation; a tainted run ignores the rule |
| C7 | Templates and policy file and audit export | Each template runs end to end against fakes; a blocked connection is refused; the export contains no token |

**Not testable here, said plainly:** any real vendor server or its sign-in; vendor app verification and marketplace
review; a real company's admin consent; real throttling; whether registry listings stay accurate; real model quality
on recipe drafting (tests use the scripted model); the browser extension (a later project); macOS and Windows sandboxing
of local servers (Linux only today).

## 7. Where Rooks would be stronger, and where not

| | Rooks (as designed) | Zapier | Make | n8n | Copilot Studio | ChatGPT |
|---|---|---|---|---|---|---|
| Where it runs | The person's computer; data stays local | Zapier's cloud | Make's cloud | Cloud or self-hosted | Microsoft cloud | OpenAI cloud |
| Writes held by default | Every one, enforced in code | Only where a paid Human in the Loop step is added | Not found | Per tool, if the builder adds review | Approvals in agent flows; per-tool approval was on the roadmap | Asks unless remembered per conversation; admins can allow more |
| Number of apps | ~40 checked plus anything with MCP or OpenAPI | 9,000+ (reported) | Large (not checked) | Large plus self-built | Microsoft and Power Platform connectors | Directory of apps |
| Apps with no API | Teach by showing, browser replay | No | No | No | Computer use (not checked) | Agent mode (not checked) |
| Team admin and SSO | Not yet; policy file only | Yes | Yes | Yes (paid) | Yes, tenant-wide | Yes, business plans |
| Always on without a computer | No (server install only) | Yes | Yes | Yes | Yes | Yes |

**Stronger:** the yes is enforced at the tool boundary, not by a prompt or an optional step; one assistant both talks and
automates, so "do it every Monday" turns a chat into a recipe; injected text cannot use a standing rule; secrets and
data stay on the person's computer with an outbound record; services with no API are reachable by teaching.
**Not stronger:** breadth and maturity of ready connectors (Zapier, Make); always-on cloud triggers and webhooks without
a relay; team accounts, SSO and central admin (all of them); deep Microsoft tenant integration (Copilot Studio). Rooks
should say so on its own comparison page.

## Sources

- MCP Registry announcement: https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/
- Registry state (secondary): https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036 ; https://safedep.io/the-state-of-mcp-registries/
- MCP authorization 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization ; https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update
- Microsoft MCP servers in Copilot Studio: https://learn.microsoft.com/microsoft-copilot-studio/mcp-microsoft-mcp-servers
- Copilot Studio tool approval roadmap: https://mc.merill.net/message/RM570434
- Google managed MCP servers: https://cloud.google.com/blog/products/ai-machine-learning/google-managed-mcp-servers-are-available-for-everyone
- Vendor roundups (secondary, Atlassian, Notion, Asana, HubSpot, Salesforce): https://mcp.so/blog/best-mcp-servers ; https://pagecrawl.io/blog/best-mcp-servers-claude-code-codex.md
- ServiceNow consuming MCP: https://www.servicenow.com/docs/r/SRy58xeijUUqttfwLgfrHQ/wOlzUhhsmmzOWHz4s35Zdg
- Slack MCP guide: https://slack.com/help/articles/48855576908307
- Zoom MCP server: https://developers.zoom.us/docs/mcp/zoom-mcp-server/
- monday.com MCP: https://developer.monday.com/api-reference/docs/mondaycom-mcp
- Xero MCP server: https://glama.ai/mcp/servers/XeroAPI/xero-mcp-server
- Intuit QuickBooks MCP (secondary): https://numeric.io/blog/quickbooks-mcp
- Claude connectors (secondary): https://sunpeak.ai/blogs/what-are-claude-connectors/
- ChatGPT connect and confirmations: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt ; https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup
- Zapier Human in the Loop: https://help.zapier.com/hc/en-us/articles/38838619533069-Get-more-control-over-your-workflows-with-Human-in-the-Loop ; https://www.zapier.com/blog/human-in-the-loop-guide
- Zapier MCP app count (secondary): https://rywalker.com/research/zapier-mcp
- n8n human review for tools: https://docs.n8n.io/advanced-ai/human-in-the-loop-tools
- Make MCP tools: https://help.make.com/mcp-tools-for-ai-agents
- Tool poisoning and rug pulls: https://www.flowhunt.io/blog/mcp-tool-poisoning-rug-pulls-safe-tool-design/ ; https://pluto.security/glossary/mcp-rug-pull-attack/

**Could not confirm:** registry size and GA date; an official ServiceNow, Zendesk, Box or Dropbox MCP server; Google
Workspace MCP general availability; whether Copilot Studio's per-tool approval shipped; Make's own approval step; exact
Atlassian endpoint; ChatGPT write actions on personal plans. Most vendor details above come from secondary pages and must
be checked against each vendor's own documentation before a catalog entry is marked checked.
