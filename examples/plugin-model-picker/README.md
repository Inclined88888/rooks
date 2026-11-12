# plugin-model-picker

Replaces the model selector of the whole interface (slot `model.picker`) with
one flat list and a search. The product's picker comes back as soon as the
plugin is removed.

The component takes no props: it reads `useModelPicker()` from `@rooks/ui`,
and the catalogue with `useBackendCatalog()`, which already answers for the
mission the host chooses for (`host.target`): a backend it could not run on is
not listed, and `host.onChange` refuses it. In a popover the product keeps
the trigger, the anchoring, the focus and the closing; the plugin paints the
content only. What a replacement must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under `model.picker`.

The package deliberately ships no `SIGNATURE` file.
