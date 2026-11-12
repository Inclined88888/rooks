---
title: Upgrading
sidebar_position: 9
---

Plan an update when no mission is running. Updating or restarting the daemon can interrupt active work.

## Preserve your data

```bash
rooks export --out rooks-backup.tar.gz
```

Exports contain portable configuration and mission state, including the connections and message history of your messaging integrations, but **exclude secrets**. Preserve your secret material and backend authentication separately. Keep the previous application package until the new one has been checked.

## Restore a backup on another machine

```bash
rooks service uninstall
rooks import rooks-backup.tar.gz --force
rooks service install
```

Quit Rooks from the tray or menu bar and uninstall the service first, so nothing holds the database open. Without `--force`, Rooks refuses to import into a folder that already holds data. With `--force`, each part of the archive **replaces** what the install has: the agents of the backup become the agents of this install, and the main agent is the orchestrator you exported (the fresh `_main` of a new install disappears). The previous database is replaced as well. If Windows refuses to delete `rooks.db`, Rooks retries, then moves the old file aside as `rooks.db.replaced-<date>`. If that fails too, the error gives the system codes: `EBUSY` means a process still holds the file (quit Rooks, uninstall the service, try again); `EPERM` or `EACCES` is a permissions problem, usually a data folder copied from another Windows account — fix its owner with `takeown /f %USERPROFILE%\.rooks /r /d y`, or import into a new folder with `--to`.

Projects point to folders on the machine they were created on. After the restore, `rooks import` lists the projects whose folder does not exist on this machine. To leave every project out of the restore (the `projects/` folder and the projects in the database), add `--no-projects`:

```bash
rooks import rooks-backup.tar.gz --force --no-projects
```

Secrets and backend sign-ins are not in the archive: reconnect your backends and re-enter your keys afterwards.

## Know when a new version is out

Rooks checks whether a newer version is published for its channel: at startup, then every 6 hours. A beta build is offered release candidates as well as final versions; a stable build is offered final versions only, and never a version older than or equal to the one you run.

When one is out, a banner at the top of the app names it and gives:

- **Download for …**: the installer for the system of the browser or app you are using (`.pkg` on macOS, AppImage on Linux with a `.deb` next to it, the setup program on Windows); on a phone, a link to the download page;
- **What's new**: the release notes;
- **Later**: hides the banner for this version; the next one is announced again.

The banner also appears in the notification centre, once per version. Installing what you downloaded follows [Apply the update](#apply-the-update) below; the app never installs anything by itself.

### Download it from the desktop app

In the desktop app, the banner offers **Download and verify** instead of a link. The app downloads the installer for this computer (`.pkg` on macOS, the setup program on Windows, the AppImage or `.deb` you installed on Linux), shows its progress, and checks it against the size and checksum published in the signed list before keeping it. A file that does not match is deleted. **Cancel** stops the download and deletes what was received; an interrupted download resumes where it stopped (**Resume**).

Once verified:

- **Install** (**Install and restart** for an AppImage) installs it, the way your system installs software — see [Install it from the desktop app](#install-it-from-the-desktop-app);
- **Show in folder** shows the file, kept in the `updates` folder of your data directory (for example `~/.rooks/updates/0.1.8/`). Only the latest version downloaded is kept there.

The download needs room for the installer plus a small margin; when the disk is too full, the banner says so and nothing is written. Like the check, it sends no licence, account or machine identifier. A browser, or a desktop window showing another machine, keeps the plain download link.

### Install it from the desktop app

**Install** first counts the missions running on this computer. When some are, the banner says how many: **Wait** leaves everything as it is (install later, once they are done), **Install anyway** goes on and they stop when the service moves to the new version. Then, depending on the package:

- **AppImage**: the AppImage you launched is replaced by the verified one, in the same folder and under the same name, and Rooks restarts on it. The previous file stays next to it, hidden, as `.<name>.previous`, until the new version has started; if the replacement or the restart fails, your current AppImage is left as it was. When the AppImage's folder is not writable, nothing is replaced: the new AppImage stays in the `updates` folder for you to move;
- **`.deb`**: installing a package needs administrator rights, which Rooks never asks for itself. The package opens in your software manager, and the banner shows the command that installs it (`sudo apt install '…/rooks_<version>_amd64.deb'`) with a **Copy** button;
- **macOS**: the `.pkg` opens in Installer, which asks for your password. Once it is done, quit Rooks and open it again;
- **Windows**: the setup program opens, visibly, and Rooks closes so it can be replaced. The installer pauses the background service, and the missions it ran stop.

In every case, the next start shows **Update Rooks from X to Y**, as in [Apply the update](#apply-the-update): nothing is migrated without your approval.

From a terminal:

```bash
rooks update check          # the version offered, its notes and its installers
rooks update check --json   # the same, as JSON
```

The check reads a signed list of releases on `rooks.local`. The request carries no licence, account or machine identifier, and a list whose signature does not check out is ignored. To turn it off, switch off **Settings › Plugins › Rooks updates › Check for Rooks updates**, or set it in `rooks.config.json`:

```json
{ "settings": { "ROOKS_UPDATES_CHECK": false } }
```

The environment variable `ROOKS_UPDATES_CHECK=0` overrides both. Turned off, Rooks makes no request at all. Checking needs neither a valid licence nor an unexpired build: a build near its end can always find its successor.

## When a beta build ends

A beta build has an end date, and a paid licence may have one too. Fourteen days before either, a banner tells you; it turns red for the last three days. When a newer version is already out, the update banner gives the build's end date instead. A licence that ends does not stop Rooks: it continues on Free. After the build's end date, Rooks shows a full-screen notice instead of the app: **This build has expired**, install a newer build.

When a newer version is published, this notice shows it too, with its notes and the download link for your system (in the desktop app, **Download and verify**). **Later** is not offered there: installing it is the way back into the app.

It keeps an **Export my data** button, so you can save your data before moving on.

## Apply the update

Install the new package for your platform: the one the desktop app downloaded and verified, the one the update banner or `rooks update check` links, or the one supplied to you.

On Linux and macOS, installing the package replaces the program, not the
background service: the service runs from its own copy of the release inside
your data directory, and keeps running the previous version until it is moved
onto the new package. On Windows, the installer moves it.

Packaged daemons then wait for explicit approval before updating an existing
database. This includes data from 0.1.0 that has no recorded version. A new
installation without a database starts normally. Closing the application or
restarting the service does not give approval. Until you approve, a `rooks`
command of the new package that opens your data (`rooks export`, `rooks plugin`…)
stops with a message instead of updating them; `rooks update` and `rooks doctor`
keep working.

**With the desktop app.** Quit Rooks completely (from the tray or menu bar,
not just its window), then open it again. It moves the service onto the new
package, then asks you to approve the update. When missions are still running
on the previous version, that screen says how many: **Wait** quits and leaves
them running (open Rooks again once they are done), **Update anyway** moves the
service now and stops them.

**Without the desktop app** (a headless server, or a session over SSH), run
these commands on the daemon host, as the OS user who runs Rooks, not with
`sudo` (set `ROOKS_HOME` if you use a separate data directory):

```bash
rooks update apply
rooks update status
rooks update approve <daemon-version>
```

`rooks update apply` restarts the service on the installed package, checks that
it answers, and ends with `The service now runs Rooks <version>.` If the new
service does not start, the previous one is restored, your data are not
modified, and the details are in `desktop-runtime/update-apply.log` inside your
data directory. When the service already runs the installed version, the
command says so and changes nothing.

Then check that the `daemonVersion` returned by `rooks update status` is the
version of the package you installed: if it still shows the previous version,
the service was not moved (`rooks update status` and `rooks doctor` say so and
name the command to run). Approve that exact `daemonVersion`. Approval applies
only to that version and requires no superadmin password. Rooks saves a copy
before migrating. If the copy fails, a destructive migration remains blocked;
an additive migration can proceed with a warning. Check the returned result
before continuing. Remote operators can run the same commands over SSH.

The copy is kept in `backups/pre-<version>/` inside your data directory. It
holds the database, the integrations database (connections and messaging
history), the settings and the plugins. When
only your plugins could not be copied (a partial backup), Rooks tells you once:
your databases and settings are saved, and restoring that copy leaves your
plugins as they are. Keep your own copy of the `plugins` and `plugins-data`
folders if you need them. When nothing could be copied, the desktop app tells
you after each start, and Rooks tries again each time it starts.

For an authorised source checkout, obtain the intended revision from your configured source, run `npm ci` and `npm run build` in `orchestrator/` and `app/`, and restart the daemon using your OS supervisor from your own terminal. For a container-served app, rebuild that service instead of starting a second host app.

The configuration loader migrates supported older configuration versions and rejects a file newer than it understands. Do not edit the version number to bypass that check.

## After the update

Updating from a version before 0.1.7 signs you out once. Rooks opens its welcome screen: pick your language, choose **Continue**, then sign in with your Rooks account (**Forgot your password?** resets it with an emailed code). Next, Rooks offers to dress your main agent's mascot: **Keep this look** saves it and shows the mascot as the agent's picture, **Not now** keeps everything as it was. You can change it later in the agent's **Avatar** tab. Paired phones and the `rooks` command stay signed in.

## Verify

```bash
rooks service status
rooks doctor
rooks plugin list
```

Open the UI, inspect your projects and run a small mission. If the update does not work for you, see [Going back to a previous version](downgrading.md). If a plugin requires a newer SDK contract, update Rooks or install a compatible plugin version; changing the manifest's version number does not add missing capabilities.
