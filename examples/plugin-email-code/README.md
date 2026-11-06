# plugin-email-code

Replaces the code screen (slot `email.code`: the first account's confirmation
in the onboarding, a forgotten password on the login) with one plain field
instead of six boxes. The product's boxes come back as soon as the plugin is
removed.

The component takes no props: it reads `useEmailCode()` from `@timon/ui`
(client API 15) — `purpose` (`verify` or `reset`), `email`, `length`, `digits`,
`input(value)`, `state` (`idle`, `checking`, `ok`, `bad`, `sent`, `failed`),
`attemptsLeft`, `message`, `resendIn`, `resending`, `resend()` and
`changeEmail()`. The host keeps the digits, talks to the daemon and counts the
waits down: a replacement never calls the daemon itself, it paints and passes
what was typed to `input`.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `email.code`.

The package deliberately ships no `SIGNATURE` file.
