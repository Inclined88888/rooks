# plugin-widget

Template of a `kind: widget` plugin. Guide: [Widget](../../public-docs/docs/plugins/widget.md).

It registers in `cockpit.widget` (and so in any `*.widget` zone). The
placement host provides the handle, the close button and the resizing; this
package provides only the body.

No host half.
