# plugin-bundle

Template of a `kind: bundle` plugin. Guide: [Bundle](../../public-docs/docs/plugins/bundle.md).

`contains` points to the ids `example-page` and `example-widget` (not to this
package). Those two children are the bundle's npm `dependencies`: that is how
`rooks plugin add` knows where to take them from.

```bash
rooks plugin add ./examples/plugin-bundle
# example-bundle@0.1.0 installed (@rooks/plugin-bundle)
#   example-page: installed (@rooks/plugin-page)
#   example-widget: installed (@rooks/plugin-widget)
```

Each child is installed **for itself**, at the top level: you turn it off
(`rooks plugin disable example-widget`), move it, remove it. The config keeps
`installedBy: example-bundle`, and that marker alone is what
`rooks plugin remove example-bundle` takes away. A child installed before the
bundle, or installed again by hand (`rooks plugin add`, which clears the
marker), stays in place.
