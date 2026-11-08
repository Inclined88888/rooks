# Rooks docs

A self hosted AI workspace in one light container. Start with the [README](../README.md) for install and a tour of the features.

- [How Rooks is built: parts, data flows, stores, cleanup](architecture.md)
- [API reference](API.md)
- Old audits and evidence (snapshots, kept as a record): [security audit](history/AUDIT.md), [Phase 0 gate](history/PHASE0-GATE.md), [history folder](history/)
- [Releases](RELEASES.md)
- [Connect Google and Microsoft (OAuth setup)](connect-google-microsoft.md)
- Design notes: [run log and connections](design/0001-run-log-and-connections.md), [adapters](design/0002-adapters.md), [the Workroom](design/0003-workroom.md), [coworkers](design/0004-coworkers.md), [the Rooks Browser app](design/0005-rooks-browser-app.md), [the Room as a small computer](design/0006-room-desktop.md); decision: [the app window](decisions/0001-app-window-is-tauri.md)
- Competitive decode (learn, don’t copy): [competitive/decode.md](competitive/decode.md)

---

# 100 reasons people pick Rooks

> Items marked **(Phase N)** are on the roadmap, not shipped. Everything else is in the product today. Checked against
> the code on 8 November 2026; items that had become false were corrected, and shipped roadmap items lost their marker.

## Weight and footprint

1. Core image is 248 MB (CI, unpacked layers), not multi-GB.
2. ~100 MB RAM at idle, measured outside Docker.
3. Runs comfortably on a €4 VPS.
4. No GPU required for the core.
5. Every add-on is off by default — you pay nothing you don't use.
6. Compose profiles add weight only when you ask for it.
7. Native Ollama on Mac is supported, so the GPU is actually used.
8. The same image runs on a Mac and a small Linux server.
9. Upgrades keep your `.env` and data.
10. Re-running the installer is safe and idempotent.

## A workspace, not just an agent runtime

11. One app (Workbench) holds every core feature.
12. No wiring six services together before you get value.
13. Notes with AI writing assist are built in.
14. Tasks are built in.
15. Calendar is built in (Google and Outlook read+create, ICS read, CalDAV read+create, local).
16. Mail is built in (Google, Microsoft, IMAP/SMTP); the assistant sends an email only after your yes.
17. Research with citations is built in.
18. Side-by-side model comparison is built in.
19. Searchable history across every conversation is built in.
20. The AI can act on all of it through tools, not just chat about it.

## Memory that earns its keep

21. Memory extraction runs automatically after each turn.
22. Capped at 5 durable items per turn so memory doesn't bloat.
23. 40-character minimum stops trivial messages polluting memory.
24. Deduplication is built in.
25. Recall uses SQLite FTS5 bm25, plus local vectors and a graph when present, all in one file — no vector database server.
26. Relevant memories are injected into the system prompt.
27. Memory can be switched off entirely.
28. Memory can be exported (JSON or a zip) and imported — yours to keep.
29. Memory has scopes (shared, one coworker, a team, private) and can belong to a project.
30. The Memory page shows what the AI knows, with correct, why and forget inline.

## Skills you can see and control

31. Skills are auto-saved after 3+ tool calls in a turn.
32. Skills are listed in the system prompt and loaded on demand.
33. You can write a skill yourself: a name, a description and the steps.
34. A Skills page to browse, install and edit skills.
35. Skills triggerable from the API and CLI without a chat turn. **(Phase 2)**
36. Delegated agents can auto-load a named skill. **(Phase 3)**
37. Skills are plain text — inspectable, portable, diffable.
38. No untrusted skill marketplace by default — supply chain risk stays out.

## A company of agents with real controls

39. Mission plus an org chart with titles and `reports_to`.
40. `reports_to` is loop-checked.
41. Delegation depth is capped at 3.
42. Monthly budget per agent, in cents.
43. Monthly token limit per agent.
44. Budget is checked before every model call.
45. Overshoot is bounded to one call — spend is predictable.
46. Over-budget agents auto-pause.
47. One worker runs queued tasks — no runaway parallelism.
48. Kanban: To do, Queued, Running, Done, Needs you.
49. Mission control dashboard for spend, tokens, and stuck tasks. **(Phase 3)**
50. Company templates instantiate in one click. **(Phase 3)**

## Safety by construction

51. Secrets encrypted at rest with Fernet.
52. Encryption key derived from `APP_SECRET`.
53. CSRF header required on every non-GET `/api` call.
54. Session cookie auth.
55. CLI bearer token stored only as a SHA256 hash.
56. Telegram user-ID allowlist.
57. Mail never goes out on its own: each email waits for your yes.
58. No unguarded shell: the assistant runs commands in the Room (its own computer) or a sandbox, and on your computer only after your yes.
59. Tool step limit of 12 per turn.
60. Tool timeout of 180 seconds.
61. Scheduled runs cannot create schedules.
62. `next_run` is booked before running, so failures cannot loop.

## Privacy and local-first

63. Your data stays on your computer or your own server; only what you send to a cloud model leaves it.
64. SQLite local file — no external database.
65. No telemetry.
66. No account required.
67. No vendor lock-in.
68. Data export and delete are documented. **(Phase 6)**
69. Model API keys are stored encrypted, locally.
70. Works fully offline with local Ollama.

## Model freedom

71. OpenAI-compatible layer, so most providers just work.
72. Explicit `providerId/model` refs — no guessing which model ran.
73. Presets for Ollama, OpenAI, Anthropic, OpenRouter, Gemini, OpenCode Go, OpenCode Zen.
74. Free models marked "(free)" in menus.
75. OpenRouter real cost tracked per call.
76. Custom per-1M-token prices for other providers.
77. Never sends temperature, so recent Claude models don't reject requests.
78. Anthropic `max_tokens` handled correctly.

## Automations

79. Cron schedules via croniter.
80. IANA timezone support.
81. Results land in an Inbox.
82. Optional Telegram delivery.
83. Safe by design — see 61 and 62.
84. Telegram `/new` starts a fresh conversation.
85. Automations are core, not an add-on.

## Channels

86. Telegram, Slack and Discord built in (outgoing connections, no public address, allowlist, encrypted token).
87. Signal built in, through your own signal-cli-rest-api, with an allowlist.
88. WhatsApp built in (Business Cloud API, signed webhooks), with an allowlist.
89. Matrix and tagged email as channels too, with the same allowlists.

## Install and ops

90. Install is one `curl | bash`.
91. `install-server.sh` (the Docker server installer) wraps everything in `main()`, so a cut-off download runs nothing.
92. OS and Docker checks with helpful prompts instead of silent failures.
93. Tarball fallback when git is missing or is only the macOS stub.
94. `setup.sh` is bash 3.2 compatible, so stock macOS works.
95. Prints the URL and a one-time setup code when done.

## Extension without the bloat

96. Minimal add-on manifest spec. **(Phase 5)**
97. Build-your-own add-on guide with a 20-line working example. **(Phase 5)**
98. Community add-on registry, but never auto-installed. **(Phase 5)**

## Credibility

99. Measured numbers are published, reproducible, and updated when they drift.
100. The README's Known limits say plainly what is not done or not tested, and the competitive notes state rivals' strengths plainly.
