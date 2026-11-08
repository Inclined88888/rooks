# UI design skills

Project skills for Claude Code (and any agent that reads `.claude/skills`). They are guidance for working on
`workbench/frontend`. None of them ships in the app.

| Skill | Use it for | Source, license, pinned commit |
| --- | --- | --- |
| `impeccable` | `/impeccable audit`, `critique`, `polish`, `quieter`, `harden`, `typeset` on product UI | `pbakaus/impeccable` 4.8.1, Apache 2.0, `924bbd194d02e5e15a227e75b5901fb0d7a4ecad` |
| `frontend-design` | Picking a visual direction for a new or reshaped page | `anthropics/skills`, Apache 2.0, `2c5958ecac7cee2b583967a2c4981d0f4a75c579` |
| `web-design-guidelines` | A rule by rule review (accessibility, focus, forms, motion) before a UI pull request | `vercel-labs/web-interface-guidelines`, MIT, `434b7f91364665f2f733b310ec54809bf8f37937` |

## What to know before using them

* Rooks already has a design system: `workbench/frontend/src/tokens.css` ("restraint" v3, design record
  `docs/design/0003-workroom.md`). The skills work inside it. A suggestion to add Tailwind, shadcn or a new palette
  is out of scope unless the owner asks for a redesign.
* **Impeccable runs a native program.** Its detector and live mode call `scripts/impeccable`, which downloads a
  prebuilt binary from the project's GitHub releases on first use into `~/.impeccable` and checks it against
  `scripts/engine-checksums.txt`. The checksums come from the same project, so they guard the download, not the
  author. Reading commands (`critique`, `quieter`, `typeset` and the references) need no binary.
* **Impeccable's edit hook is off.** `/impeccable hooks on` would add a hook that runs the detector after every UI
  edit. Turn it on only on purpose; it writes `.claude/settings.local.json`, which is gitignored.
* `web-design-guidelines` reads a pinned local copy of the rules. The upstream skill fetched them from the internet on
  every run; this copy does not.

## Updating

Copy the new skill folder over the old one, keep the LICENSE file, and change the commit in the table above.
