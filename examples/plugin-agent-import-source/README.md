# plugin-agent-import-source

A third-party **source adapter** for the agent import, written with the SDK
alone and no permission. It adds « Acme Bots » to the import assistant (Agents
page › Import agents, Settings, onboarding): the user picks the
`acme-bots.json` file that a made-up tool exports, and gets the import's
preview — names, roles, working folders, what is left out — before anything
is written.

What it shows:

- **The socket.** `client.slots: ["agentimport.source"]`: a list socket the
  import (`@timon-ai/plugin-agent-import`, built in) opens while it is on.
  Exact admission: a plugin that does not name it is refused, a widget
  included. Switched off, the import takes its adapters with it.
- **The assistant.** `useAgentImport()` from
  `@timon-ai/plugin-agent-import/hooks`. This template is one hand-written
  file, so it reads the same React context by its global symbol
  (`Symbol.for('timon.plugin.agent-import.context')`); a bundled adapter
  imports the hook and keeps `react` external.
- **The conversion.** `toManifest(text)` is pure: `acme-bots.json` →
  `timon-agent-import` v1 (bots → agents, persona → `SOUL.md`, prompt →
  system prompt, notes → memory rules, daily jobs → routines in the state
  they had, the API key by NAME only — the value field is never read). What
  cannot be carried becomes a warning, in words for the user.
- **The hand-over.** `zipOne()` packs the manifest alone in a zip (stored, no
  dependency) and `submitFile('acme-bots', zip)` stages it. From there the
  import does the rest: preview, choices, apply, re-import of the same file
  without duplicates (`sourceRef`).

Why the conversion runs in the browser: the engine only runs its own adapters
on an archive (its built-in sources, Timon), TODO #808. Its manifest is the one format it
always reads, so an adapter that ships it works on any Timon with the import.

The contract — socket, hook, manifest and its evolution rule, the
`agent-import:applied@1` event — is in [Slots](../../public-docs/docs/plugins/slots.md), under
`agentimport.source`. The test
`app/src/lib/agent-import-source-template.test.ts` loads this file as the
platform does and reads its zip with the real engine.

## The made-up format

```json
{
  "format": "acme-bots",
  "version": 1,
  "timezone": "UTC",
  "bots": [
    {
      "id": "ada",
      "name": "Ada",
      "role": "Research assistant",
      "persona": "Curious and precise.",
      "prompt": "Read the papers and summarise them.",
      "notes": ["Prefers short answers"],
      "jobs": [{ "title": "Morning digest", "task": "Summarise the new papers.", "dailyAt": "08:00", "enabled": true }],
      "apiKeyName": "ACME_API_KEY"
    }
  ]
}
```

The package deliberately ships no `SIGNATURE` file.
