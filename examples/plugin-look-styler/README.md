# plugin-look-styler

Replaces the mascot configurator (slot `agent.lookstyler`: the onboarding's
« Customise » panel and the Avatar tab of the agent editor) with three short
lists — skull, eyes, accessory — and a row of colour swatches. The product's
grids come back as soon as the plugin is removed.

The component takes no props: it reads `useLookStyler()` from `@rooks/ui`
(client API 15) — `look` (always complete and valid), `onChange(look)`, the
agent's `name` and `role`, the `states` the product's preview offers, the
closed lists in `choices` and `random()`. Offer only what `choices` holds: the
daemon refuses any other value, and the host keeps the current one for a field
off the lists.

The panel or tab around the configurator, its title and its « Done » belong to
the screen: a replacement paints the inside only.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `agent.lookstyler`.

The package deliberately ships no `SIGNATURE` file.
