# Who holds which key: the person, the native window, the terminal and background agents

Integration of PR #10 (native Ask) and PR #11 (the Workroom) on branch `integration/auth-native-workroom`, 2026-11-07.

## The rule

A background agent (a coding job the app starts, the browser or desk helper, a user's MCP server, a model CLI) must
never approve its own request or get the person's full access through a key the app shares with it. The server
enforces this; no client is trusted to hold back.

## Credentials

| Credential | Who is given it | What the server lets it do |
| --- | --- | --- |
| Session cookie (`wb_session`) | The person's browser or app window after sign in | Everything the person can do |
| `TOOLS_API_KEY` | The backend (keychain or the 0600 `.desktop-secrets.json`); on a server install, the add-ons for `/tools` and `/mcp` | Not an account login: `surfaces.bearer_ok` refuses it and `/api/desktop/local-session` no longer takes it (security hardening, 2026-11-07), so `/api` is closed to it. Opens `/tools` and `/mcp` only |
| `NATIVE_SIGNIN_KEY` (new) | The native Rooks window only, through `native.json` (0600, next to `app.json`, new every launch, removed on quit) | One thing: mint a session cookie at `/api/desktop/local-session` on loopback. Not a bearer anywhere |
| Terminal access token | The person's `rooks` after `rooks login` | Chat (`require_user_or_cli`) and the seven Workroom routes, including answering Needs you and acting in the Room |
| `BROWSER_API_KEY` (`app.json`) | The terminal, the browser and desk helpers | `/v1`; with the terminal's channel header, reads the Workroom routes only; records the person's y/n on terminal prompts |
| `DESK_API_KEY` | The desk helper (same value as the browser key in the desktop app) | As the browser key |
| `CODING_BRIDGE_KEY` | Coding jobs the app starts (`WORKBENCH_API_KEY`), always its own random key | `/v1` only. No Workroom reads, no answers to terminal prompts, no session |

## What changed to enforce it

* PR #10's `check_app_key` let `BROWSER_API_KEY` mint a session and act as a full bearer. Removed. The native window
  now signs in with its own `NATIVE_SIGNIN_KEY` (`security.check_native_key`, `api.desktop_local_session`).
* `cli_agents.coding_bridge_key()` returned `BROWSER_API_KEY` when set, so coding jobs held the shared app key. It now
  always returns its own key, and the server tells a job apart by it (`security.is_coding_job_key`).
* Child processes inherited the sidecar's environment, which holds `APP_SECRET`, `TOOLS_API_KEY` and the bridge
  keys: a coding job could sign in as the person or forge a session. `security.scrub_env` removes every app secret
  for coding jobs and model CLIs (`cli_agents.child_env`), user MCP servers (`mcp_client`), and the browser and desk
  helpers (`local_agents.helper_env`, and the sidecar's own `helper_env`), which get back only their one key. This
  hole existed on `main` before either pull request.
* `/v1/rooks/approvals/{id}` refuses an answer sent with the coding job key (403).

Tests: `workbench/backend/tests/test_auth_boundaries.py` (privilege escalation, approval bypass, credential reuse,
background job environment, legitimate native sign in, the sidecar's files) and the rewritten
`test_desktop.py::test_local_session_takes_the_native_key_not_the_shared_app_json_key`; the native window's own
test is `desktop/rooks-native/src/link.rs::the_window_signs_in_with_native_json_not_app_json`.

## The trust boundary that remains: the operating system user

Everything above stops an agent from gaining power through what the app hands it. It does not stop a process that runs
as the same operating system user and reads files that user can read. Verified on this branch: a child started with
the scrubbed environment has none of the secrets in its environment, but it can still read
`.desktop-secrets.json` (`APP_SECRET`, `TOOLS_API_KEY`) and `native.json` from disk, both 0600 and owned by the same
user. A coding job, a model CLI or an MCP server with shell access can therefore reach full access if it sets out to.
The same holds for a Terminal access token stored by `rooks login` (keychain on macOS and Windows, or a 0600 file), and
for the Companion token in `~/.rooks/companion.json` (0600): the notch app and the agent hooks share it, and it answers
`/api/companion/requests/{id}/decide`, so a coding agent that reads that file could answer its own Companion request.
Splitting it would not help while the full token must stay on disk for the notch app.

Closing that needs operating system isolation, not another key:

1. Run coding jobs inside the Room's isolation (on Linux, `unshare` with the Room's home bound over the person's
   home, which hides `~/.config` and the app's data folder), or under a separate operating system user.
2. Keep `APP_SECRET` and `TOOLS_API_KEY` in the operating system keychain on every platform (desktop builds use the
   0600 file today because ad hoc signed macOS builds cannot use the keychain reliably).
3. Make the native window's key single use, rotated by the backend after each exchange.

Until then, a job's shell is as trusted as the person's own login session.
