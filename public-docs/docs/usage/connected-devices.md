---
title: Connected devices
sidebar_position: 4.85
---

A **device** is another Rooks interface that you allowed to open this machine: typically the Rooks on your laptop, which uses [Machines](machines.md) to switch to this server. Devices are authorized with a one-time code and listed in **Settings → Access & network → Devices**, where you can rename or revoke them at any time. Nothing needs to be turned on: every Rooks can authorize devices.

## Authorize a new device

1. Sign in **directly on this machine**: its own interface, its Tailscale address or an SSH tunnel. A code cannot be issued through another device.
2. Open **Settings → Access & network → Devices** and choose **Authorize a new device**.
3. A **pairing code** appears with a countdown. Copy it and enter it on the other computer, in **Settings → Plugins → Machines** → **Add a machine**, together with this machine's address. When this machine's daemon is published with `tailscale serve`, the card shows that address, with a button to copy it; otherwise it links to how to get one ([Run Rooks on a headless server](../installation/headless-server.md#4-drive-it-from-the-rooks-on-your-computer)) and, for an administrator, offers **Make this machine reachable** (below).

### From a terminal on this machine

A server with no interface open issues the code from a shell on the server itself, as the account that runs Rooks:

```bash
rooks device pair
```

It prints the code and, when the daemon is published with `tailscale serve`, the address to type next to it; otherwise the `tailscale serve` command that publishes it. The code is issued for the administrator account. An administrator issues one for another account with `--user <email>`. `rooks device list`, `rooks device rename <id> <name>` and `rooks device revoke <id>` manage the devices the same way. A device or an agent cannot run `rooks device pair`: the request is refused.

### Make this machine reachable

When the card has no address, an administrator signed in directly on this machine can choose **Make this machine reachable**. Rooks publishes its daemon with `tailscale serve`, on the first free HTTPS port among 8443, 10000 and 443 (443 last: it is the usual port of the web interface), and shows the address it got, with a button to copy it.

- It publishes on your **tailnet only**: your own Tailscale devices reach it, the internet does not. Rooks never uses Tailscale Funnel.
- It never replaces what `tailscale serve` already publishes on this machine: a port already in use is skipped. If the daemon is already published, its address is shown as it is.
- When it cannot, the card says why — HTTPS not enabled on your tailnet, not allowed to change Tailscale's configuration, the three ports already in use, or an answer from Tailscale it cannot read (shown as is) — and gives the command to run yourself on this machine: with `sudo` on Linux, in PowerShell opened **as administrator** on Windows.

#### When Tailscale is missing or not signed in

The card walks you through it without leaving Rooks:

1. **Install Tailscale** — Rooks downloads the official installer from Tailscale's site, checks that it is the file Tailscale published and that it is signed by Tailscale, then hands it to your system, which asks for your password itself. Rooks never asks for it and never stores it.
   - **macOS**: the macOS Installer opens with Tailscale's standalone package. Homebrew is not needed.
   - **Windows**: the administrator prompt appears, then a progress bar.
   - When Rooks runs as a background service (the usual setup on Windows and macOS), the **Rooks desktop app** opens the installer for it: click **Install Tailscale** from the app on that computer. From a web browser, the card gives the command to run instead.
   - **Linux**: your desktop's password dialog appears; the same step lets your account manage Tailscale, so Rooks can publish without `sudo` afterwards. Without such a dialog (a server, an SSH session), the card gives the command to paste in a terminal.
2. **Sign in to Tailscale** — the Tailscale sign-in page opens in your browser (the card also shows a link to it). On macOS, the Tailscale app opens too: approve what it asks the first time, then sign in.
3. As soon as Tailscale is connected, the card publishes this machine and shows its address.

If a step cannot be done here — you cancelled the password prompt, the download failed, or you used a web browser while Rooks runs as a background service — the card says so and gives the command to run yourself on this machine.

**HTTPS not enabled on your tailnet**: the card links to the Tailscale admin console. Open **DNS**, turn on **HTTPS Certificates**, then try again.

**Linux, not allowed to change Tailscale's configuration**: choose **Let Rooks manage Tailscale**. Your system asks for your password once (`tailscale set --operator`), then the card publishes again.

To stop publishing it, run `tailscale serve status` on this machine, then `tailscale serve --https=<port> off` for the port shown.

The code:

- works **once**;
- expires after **5 minutes**;
- stops working after a few wrong attempts: ask for a new one;
- is issued for your account. At most five codes can wait at the same time.

When the device is paired, a **New device connected** notification appears here.

## Enter a code from another machine

**Settings → Access & network → Devices** → **Enter a code from another machine** is the other half: it is for the computer that drives other machines. It opens **Settings → Plugins → Machines** with its **Add a machine** form, since the [Machines](machines.md) plugin is what takes the code. When Machines does not run on this computer, the button says why instead (turned off, or not included in your licence) and links to its card in **Plugins**.

## What a device can do

A device acts **as the account that authorized it, with all its rights**: if you are an administrator here, so is the device. It can run missions, open the built-in terminal, change settings, approve plugins, everything you can do from this machine's own interface.

It cannot change that account's password, profile, email or avatar. Connecting an AI provider's account (a CLI sign-in) is done from this machine directly.

## The list

**Connected devices** shows, for each device: its name, its state (*Active*, *Expired*, *Revoked*), when it was paired, its last connection and the IP address this machine saw. That address is the one of the Rooks that relays the device, not necessarily the device's own. **This device** marks the one you are using. An administrator also sees the devices of the other accounts.

- **Rename** changes the name shown in the list.
- **Revoke** cuts the device off at once: its next request is refused, and the terminals and live views it has open on this machine are closed. To use it again, pair it again with a new code. Revoking the device you are using cuts this interface off at once.

A device that has not been used for **90 days** expires by itself. A device also stops working when its account is disabled; what it still has open is closed within a minute.

## Keep it safe

- **Treat a pairing code like a password.** Whoever enters it within 5 minutes gets your account's rights on this machine.
- **Pair only over HTTPS.** Rooks refuses a device connection in plain HTTP from another computer. See [Run Rooks on a headless server](../installation/headless-server.md) for the `tailscale serve` recipe.
- **Review the list from time to time** and revoke what you do not recognise or no longer use: an old laptop, or a reinstalled computer whose former access stays listed until it expires or you revoke it.
- **Removing a machine** from the other computer's **Machines** settings revokes its device here as well, when this machine can be reached at that moment.
