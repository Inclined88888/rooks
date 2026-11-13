# plugin-mascot

Replaces every agent's mascot (slot `agent.mascot`: the onboarding, the agent
creation, the chat) with a flat pixel face in the agent's colour, whose eyes
follow its state. The product's meerkat comes back as soon as the plugin is
removed.

The component takes no props: it reads `useAgentMascot()` from `@rooks/ui`
(client API 15) — `look` (`shape`, `color`, `eyes`, `acc`, always complete and
valid), `size`, `live`, `state` (or `null`), `fit`, `shadow`, `label` and
`reducedMotion`. The host has already folded the user's reduced-motion setting
into `live`: a replacement never animates when `reducedMotion` is true.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `agent.mascot`.

The package deliberately ships no `SIGNATURE` file.
