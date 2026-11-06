
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: WidgetChromeProps

> **WidgetChromeProps** = `object`

Props supplied when a widget declares a custom frame.

## Properties

### className?

> `optional` **className?**: `string`

Forward host layout classes to the widget root.

***

### compact?

> `optional` **compact?**: `boolean`

Paint the compact form, not the card: icons and badges only, side by side
when `orientation` is `horizontal`, stacked otherwise, the detail opening
on click (`AnchoredPopover` from `@timon/ui`). True on the top bar's line
and in the product's two sidebars, and only for a widget registered with
`bar: true` that is not in a stack of tabs. Wide zones (cockpit, chat
columns) keep the card.

***

### editing?

> `optional` **editing?**: `boolean`

True while the user rests on the widget's title or a layout gesture is under way; hide optional configuration controls otherwise.

***

### orientation?

> `optional` **orientation?**: `"vertical"` \| `"horizontal"`

Direction of the zone holding the widget: `horizontal`, one line of the
top bar, 36px tall; `vertical`, a column. Only a widget registered with
`bar: true` is ever given `horizontal`.

***

### poignee

> **poignee**: `unknown`

Render these host controls in the custom widget header.
