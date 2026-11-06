# plugin-bundle

Template of a `kind: bundle` plugin. Guide: [Bundle](../../public-docs/docs/plugins/bundle.md).

`contains` points to the ids `example-page` and `example-widget` (not to this
package). Those two children are the bundle's npm `dependencies`: that is how
`timon plugin add` knows where to take them from.

```bash
timon plugin add ./examples/plugin-bundle
# example-bundle@0.1.0 installed (@timon-ai/plugin-bundle)
#   example-page: installed (@timon-ai/plugin-page)
#   example-widget: installed (@timon-ai/plugin-widget)
```

Each child is installed **for itself**, at the top level: you turn it off
(`timon plugin disable example-widget`), move it, remove it. The config keeps
`installedBy: example-bundle`, and that marker alone is what
`timon plugin remove example-bundle` takes away. A child installed before the
bundle, or installed again by hand (`timon plugin add`, which clears the
marker), stays in place.
