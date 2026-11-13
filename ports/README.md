# Ported from Rooks 1.0 / 1.1 (PR #31)

These trees won their areas in the Rooks-body takeover comparison and are kept alongside the Rooks kernel.

| Path | Why kept |
| --- | --- |
| `../rooks-code/` | Terminal coding agent (any model, approvals, MCP) |
| `../rooks-browser/` | Browser agent on the user's Chrome/Edge |
| `../rooks-desk/` | Computer-use agent |
| `../rooks-try/` | The Room (isolated computer on this machine) |
| `../integrations/work-suites/` | Microsoft 365 + Google Workspace work account (PR #31) |
| `../integrations/brand/` | Rooks mark, industrial tokens, Work apps page |
| `installers/` | Frictionless curl/irm installers from Rooks |
| `windows-pack/` | Windows MSI / Job-object Room packaging from PR #31 |
| `icons/` | Rooks tower mark and platform icons |

Wiring these into the Rooks daemon (providers, MCP bridges, settings slots) is follow-up work after the owner decides on proprietary distribution.
