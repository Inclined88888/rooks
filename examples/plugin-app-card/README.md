# plugin-app-card

Replaces the cards of the official connectors (slot `apps.card`, Connectors tab of Capabilities) with one compact row per
connector: its logo (or monogram), its name, its state and the one action that state allows. A
key app gets a masked field inline. The product's cards come back as soon as
the plugin is removed.

The component takes no props: it reads `useAppCard()` from `@timon/ui` (client
API 15) — `app` (texts already in the viewer's language, `auth`, `links`,
`icon`, `mcpId`), `status` (`available`, `connecting`, `consent`, `connected`,
`blocked`), `consentUrl`, `vaultOff`, and the two gestures `connect(key?)` and
`disconnect()`. The host keeps the data and the gestures: it creates the MCP
server on the reviewed endpoint, opens the publisher's consent page, keeps a
key in the vault and refreshes the state. A replacement never calls the daemon.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `apps.card`.

The package deliberately ships no `SIGNATURE` file.
