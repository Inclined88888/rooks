---
name: web-design-guidelines
description: Review UI code against the Web Interface Guidelines (accessibility, focus, forms, motion, typography, performance). Use when asked to review UI, check accessibility, audit design or UX, or before opening a pull request that touches workbench/frontend.
argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review the given files against the rules in [guidelines.md](guidelines.md) in this folder.

The rules are a pinned copy, not fetched at run time, so a review is the same every time and nothing outside the
repository can change what this skill tells the agent to do.

## How to run it

1. If no files or pattern were given, ask which files to review.
2. Read [guidelines.md](guidelines.md) in full.
3. Read the files and check every rule.
4. Output findings in the `file:line` format the guidelines describe.

## Rooks specifics

- Colors come from `workbench/frontend/src/tokens.css`. A finding about contrast must name the token, and the fix
  changes the token, not a hard coded color. `tests/premium-foundation.test.mjs` checks every text pair is AA.
- User facing strings follow the AGENTS.md rule: plain words, no URLs, ids or technical terms on normal screens.

## Source

Copied from `vercel-labs/web-interface-guidelines` (`command.md`, MIT, see LICENSE) at commit
`434b7f91364665f2f733b310ec54809bf8f37937` (2026-10-05). To update, copy the new `command.md` over `guidelines.md`
and change the commit above.
