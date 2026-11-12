# plugin-mascot-pack

A **mascot pack**: adds a woolly hat and a scarf (accessories), a midnight fur
and snowflake eyes to the mascot configurator (the onboarding's « Customise »
panel and the Avatar tab of the agent editor). They show in their own group
under the pack's name, after the product's choices. Client API 15.

Two halves say the same ids:

- `package.json`, `rooks.mascot`: the slug of each part by look field
  (`shape`, `color`, `eyes`, `acc`). The daemon accepts
  `example-mascot-pack:<slug>` in an agent's look while the plugin is enabled,
  and refuses any other id.
- `lib/client.js`: registers each part in the `mascot.parts` slot,
  `ctx.slots.register({ slot: 'mascot.parts', key: '<slug>', mascotPart })`,
  with no component. A part the manifest does not declare, or whose data fails
  a check, is refused when it registers.

A part is data: a skull is four bounded numbers, a fur a `#rrggbb`, eyes are
outlines of points, an accessory is SVG markup drawn around (0, 0) in a box of
about 32 × 32. The markup may hold `g`, `path`, `rect`, `circle`, `ellipse`,
`line`, `polyline` and `polygon` with geometry and presentation attributes only;
text, `style`, links, `on*` handlers and `url(…)` are refused, never trimmed.

Remove the plugin: its parts leave the configurator, and an agent that wore one
shows its job's default for that part until the pack is back.

Guide: [Create a mascot pack](../../public-docs/docs/plugins/mascot-pack.md).

The package deliberately ships no `SIGNATURE` file.
