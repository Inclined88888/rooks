# plugin-overlay

Template of a `kind: ["widget", "overlay"]` plugin. Guide: [Overlay](../../public-docs/docs/plugins/overlay.md).

One identity, two insertions, like `plugin-hello` (nav + widget):

- `cockpit.widget` → a card in a rail (`WidgetHost`)
- `overlay` → an in-app layer; the component positions itself

`overlay` is not a `*.widget` slot: a mascot does not slide into the chat's
rail. It is not an operating-system window either: it lives inside Rooks's
window.
