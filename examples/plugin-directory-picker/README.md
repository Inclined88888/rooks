# plugin-directory-picker

Replaces the folder browser (slot `directory.picker`) — opened by « Browse… »
in Settings, a project or an agent when the window drives another machine, or
in a web browser — with a breadcrumb list: the current folder, its visible
subfolders, « Up », and a button to use the folder. The product's browser
comes back as soon as the plugin is removed. On this computer's own daemon in
the desktop app, the OS dialog opens instead and the slot is not painted.

The component takes no props: it reads `useDirectoryBrowser()` from
`@rooks/ui` (client API 15). The host keeps the dialog frame (its accessible
name, the focus held inside it and given back on close, Escape, a submit that
never reaches a form around it) and the daemon's calls: `opening()` reads the
first level (the form's folder, or the daemon's home), `read(path)` another
one, `choose(path)` hands a folder back to the form, `cancel()` closes. Every
path is built by the daemon of the machine that will read it: a replacement
hands back a `listing.path` or an `entry.path`, never one it put together.
The same slot answers the file pickers (`host.mode === 'file'`): a plugin
archive or a CLI binary on the machine the window drives. The level then
carries `listing.files` (already filtered by the daemon with `host.accept`),
and `choose(path)` takes a file the host served — never a folder. This
template lists the files after the folders and uses the one clicked.
What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `directory.picker`.

The package deliberately ships no `SIGNATURE` file.
