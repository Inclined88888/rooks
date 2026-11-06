# plugin-update-banner

Replaces Timon's « new version » banner (slot `updates.banner`) with a single
compact line: the version, one download link and « Later ». The product's
banner comes back as soon as the plugin is removed.

The component takes no props: it reads `useUpdateStatus()` from `@timon/ui`
(client API 15) — `installed`, `channel`, the `offer` (`version`,
`publishedAt`, plain-text `notes`, `notesUrl`, every `artifacts` entry), the
`installers` picked for this browser's system (the first one is the one to
download), `buildExpiresAt` and `later()`. The host only paints the slot while
the daemon has verified a newer version that the person has not put off.

What a replacement must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under `updates.banner`.

The package deliberately ships no `SIGNATURE` file.
