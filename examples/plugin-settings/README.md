# plugin-settings

Template of a plugin that writes settings. Guide: [Settings](../../public-docs/docs/plugins/settings.md).

No invented `kind`: `behavior` (inferred whenever `client.slots` matches no
`KIND_SLOT`). One identity, two insertions:

- `settings.missions`: adds a row **after** the built-in Missions settings
  (not a card, no `border`). Empty, the slot reserves no space.
- `settings.section`: takes a category of its own (key = the plugin id). The
  component opens `settings.acme` (`list`) so that another plugin can add to
  it.

Admission is **exact**: a `cockpit.widget` widget enters neither here nor
`settings.section`. Declaring `settings.missions` does not open
`settings.resources`.

Without a client half, `rooks.settings: [...]` is enough: the automatic form
is the category's pane (sidebar), laid out by the product. If the plugin also
occupies `settings.section`, the occupant wins: one item, not the automatic
form as well.

Deep link: `/settings?group=` + `encodeURIComponent(id)` (an id may hold a
`/`, the same trap as `/api/plugins/:id`).
