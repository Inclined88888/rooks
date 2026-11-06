# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, never in a public issue:

- with GitHub's **Report a vulnerability** form, in the **Security** tab of this
  repository;
- or by email to **contact@timon-ai.com**, with "Security" in the subject.

Tell us what you found, how to reproduce it, the version (`timon --version`)
and the system it runs on. You will hear back within 7 days. Once a fix is
released we credit you in the changelog, unless you prefer not to be named.

## What counts

Timon runs agents with access to your files, your shell and your accounts, so
its security boundaries matter. Among the reports we want:

- a request reaching the daemon without the authentication it requires, or an
  account reaching what its permissions deny;
- a secret leaving the vault: in a log, an error message, a URL or an agent's
  context;
- a plugin, a webhook or a page read by an agent escaping the permissions it
  was given;
- a signed update or a signed plugin accepted with a forged signature.

Out of scope: an agent doing what you allowed it to do, a flaw in an agent CLI
itself (report it to its vendor), and attacks that need an account that is
already an administrator of the machine.

## Supported versions

Only the latest release gets security fixes. The app updates itself; please
check that you run the latest version before reporting.
