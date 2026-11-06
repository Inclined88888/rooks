# plugin-provider-cards

Replaces the AI CLI cards (slot `providers.cli`) — the onboarding's « Your
AIs » step, its « cannot start » screen and Settings › AI models — with one
compact list. The product's cards come back as soon as the plugin is removed.

The component takes no props: it reads `useProviderCliCards()` from
`@timon/ui`. The host owns the data and the gestures: `install(name)` starts
the vendor's official installer on the daemon (the plugin never names a
command), the host follows it and exposes its console in `jobs[name].lines`,
`signIn(name)` types its sign-in command in Timon's terminal (or copies it when
the view has none), `refresh()` asks every CLI again whether it is signed in. What a replacement
must respect is in [Slots](../../public-docs/docs/plugins/slots.md), under `providers.cli`.

The package deliberately ships no `SIGNATURE` file.
