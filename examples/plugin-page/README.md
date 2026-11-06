# plugin-page

Template of a `kind: page` plugin. Guide: [Page](../../public-docs/docs/plugins/page.md).

- `route: /example`
- `declares: { "example.widget": "list" }`: a host zone that other widgets
  fill; this page does not fix their list.

The app's catch-all route renders the `page` entry keyed by the visited path:
install this package and open `/example` to see the screen.

A route the product already serves (`/settings`, `/kanban`…) never reaches
the catch-all: a plugin cannot hide it.
