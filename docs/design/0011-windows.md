# 0011: Windows on a par with macOS and Linux

Status: design record, 2026-11-09. Branch `feat/windows`. Builds on 0006 (the Room's terminals), 0007 (the Room's browser) and the Windows notes in BACKLOG.md. Lanes: rooks-try, backend, desktop, CI. Tests first: each one fails on today's code. Read with 0012, whose OneDrive "Open" falls back to the person's own browser only while `can.browser` is false on Windows.

The person: a workplace user who installs Rooks on a Windows 10 or 11 PC, often joined to a work account, often with IT policies. Today on Windows the Room has no terminals (`terminal_pty.enabled()` is false on win32, `ShellDriver.terminal_argv` is None), no browser (`find_engine` returns None, `off_reason` says `windows`), no containment (BACKLOG), and the installer was never run on a real PC.

**On release/1.1.** The owner's rule from `feat/room-pro` holds here too: the Room's Terminal and Browser, and the
app's own Terminal page, are developer tools, off on a new install and shown only with "Show developer tools" on.
Everything below describes what a person with developer tools on gets on Windows; with them off, Windows gets the
Room's Files and Saved points, as macOS and Linux do. The CI jobs switch terminals and the browser on in their
fixtures, as the POSIX tests do.

## 1. Room terminals through ConPTY

**Mechanism.** A new module `rooks_try/winproc.py` (pure `ctypes`, no wheel to freeze; the app already imports rooks_try and the sidecar spec bundles it) gives three things: a `Job` (section 3), `spawn(argv, env, cwd, *, job, conpty=None, crt_handles=None)` built on `CreateProcessW` with `STARTUPINFOEXW`, and `ConPty`. We do not use pywinpty: it creates the process itself, so the shell could start children before it joins a job. `spawn` puts `PROC_THREAD_ATTRIBUTE_JOB_LIST` (0x2000D), `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (exactly the handles meant for the child) and, for a terminal, `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` (0x20016) in one attribute list, so the process is in its job from its first instruction and inherits nothing else from the threaded server. For a terminal, `STARTF_USESTDHANDLES` is set with null handles so a sidecar whose own output is redirected does not pass its pipes in place of the console.

`ConPty`: `CreatePipe` twice, `CreatePseudoConsole(COORD(cols, rows), in_read, out_write, 0)`, then our copies of the far ends are closed. Resize is `ResizePseudoConsole`. A preferred build is the MIT `conpty.dll` with `OpenConsole.exe` from Microsoft's Windows Terminal release (what VS Code bundles), shipped in the sidecar; without it, kernel32's own. Windows older than 10 1809 has neither: terminals stay off with "This version of Windows is too old for terminals in the Room."

**Shells.** The person's terminals are PowerShell by default: `pwsh.exe` (PowerShell 7) when installed, else `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, by full path, found as `host_which` does (never in the Room's folders). Started `-NoLogo -NoProfile -NoExit -Command <the Room's PowerShell profile as plain text>`: a command is not subject to execution policy, so we never pass `-ExecutionPolicy Bypass`, and we avoid `-EncodedCommand`, which security software flags. That profile puts the Room's bins first on `PATH`, keeps `ROOKS_MARK` in an unexported variable and removes it from the environment, dot-sources the Room's own `Documents\PowerShell\profile.ps1` when the person made one, and defines `prompt` to print the exit code marker (`$ok=$?`; 0 when `$ok`, else `$LASTEXITCODE` when non-zero, else 1). When Git for Windows is present (`windows_sh()`), the New terminal menu also offers Git Bash: `bash.exe --login -i`, reading the Room's existing `.profile` and its marker. Terminals Rooks opens use Git Bash when present, as `run_argv` does, else PowerShell. Each terminal row and tool result carries `shell` (`powershell`, `bash`), so the assistant writes the right syntax.

**Same keepers.** `room_terminal` gets a small `Pty` interface (`read`, `write`, `resize`, `hang_up`, `pid`, `exit_code`, `busy`), with `PosixPty` (today's code, moved) and `ConPty`. The registry, the 256 KiB ring, the 0600 log, scrollback replay on attach, the one-viewer WebSocket and `_refusal` stay as they are. Differences, each with a test:

- **Exit code marker.** ConPTY re-renders output and may drop an OSC it does not know. At the first prompt the app checks whether the marker arrived with the first output. If it did not, the terminal switches to a side channel: a named pipe `\\.\pipe\rooks-mark-<nonce>` the app creates with a DACL for the person alone, whose name reaches the profile through `ROOKS_MARK` and is then removed from the environment. A command ends when the code arrives and the output has been quiet for 150 ms (at most 1 s), so its last lines are not cut. A program running as the person could find and write to that pipe. That is the same strength as the nonce on POSIX, and it is said under Advanced.
- **Busy.** There is no foreground process group. Busy means `pending`, or the terminal's job holds a process other than the shell (`JobObjectBasicProcessIdList`). A background `Start-Process` counts as busy, and the row says "A program is running".
- **Hidden input.** The console's echo mode cannot be read from outside, so on Windows the run log keeps only the length of every line sent through the send route ("(a line was sent, N characters)"). Commands Rooks itself starts are still logged in full.
- **Hang up and exit codes.** `ClosePseudoConsole` (it sends `CTRL_CLOSE_EVENT`) runs on a worker thread while the reader keeps draining, because older builds block until the output pipe is empty. After 3 s, `TerminateJobObject(job, 129)`, so a hung-up shell shows 129 as on POSIX. The shell's own code comes from `GetExitCodeProcess`.

`terminal_pty` (the app's own terminal) uses the same `ConPty` and drops its win32 refusal. The rooks terminal's `/room` commands already go through the app's routes, so they work unchanged.

**Built on `feat/windows` (section 1), and where it differs from the text above.** `rooks_try/winproc.py` has `Job`,
`spawn`, `ConPty`, `Terminal` and `MarkPipe`; `room_terminal.py` keeps one registry with a POSIX path and a Windows
path rather than a separate `Pty` class (`t.win` holds the Windows terminal), so the POSIX code is unchanged. The side
channel's name reaches the profile as `ROOKS_MARK_PIPE` (the nonce stays in `ROOKS_MARK`); both are removed from the
environment. Instead of choosing one channel at the first prompt, the shell always prints the in-band marker and
writes the same line to the pipe, each carrying a count, and a prompt counts once whichever arrives first: on the
windows-2022 runner (build 20348) ConPTY passed the in-band marker through and the pipe also delivered, and which came
first varied between runs. The field is `shell_kind` (`powershell`, `bash`, and on POSIX the shell's name), because
`shell` already carries the shell's path under Advanced. Status lists the kinds as `can.terminal_shells`. Not yet: the
bundled `conpty.dll` and `OpenConsole.exe` (Windows' own ConPTY is used), nesting each terminal's job in one Room job
with the UI limits (section 3), and the sidecar smoke test opening a terminal (section 4).

## 2. The Room's browser on Windows

**The pipe.** On Windows Chromium reads `--remote-debugging-pipe` from C runtime file descriptors 3 and 4, which the CRT rebuilds at startup from `STARTUPINFO.lpReserved2`/`cbReserved2`. This is how Node passes extra stdio to Puppeteer. `winproc.crt_block(handles)` packs that block with no padding: an `int` count (5), then one flag byte per descriptor, then one pointer-sized `HANDLE` per descriptor. Descriptors 0 to 2 point at an inheritable `NUL` handle (`FOPEN|FDEV`). Descriptor 3 is the read end of our request pipe and descriptor 4 the write end of our response pipe (`FOPEN|FPIPE`). The same `NUL` handle goes in `hStdInput/Output/Error`. Only these handles are inheritable, and only through `HANDLE_LIST`. Our ends are turned into descriptors with `msvcrt.open_osfhandle`, so the existing `Pipe` class runs unchanged. There is no pipe step on Windows: `spawn` gives the real browser pid, the job and `CREATE_NO_WINDOW` in one call. `workbench_server.py --rooks-pipe-step` on win32 exits with "Not used on Windows". `check_flags` still refuses `--remote-debugging-port`, `--no-sandbox`, `--disable-web-security` and file access flags. There is never a port.

`Pipe.close` on Windows closes the write end, ends the job, and lets the reader see `ERROR_BROKEN_PIPE` before closing the read end. Closing a handle under a blocked `ReadFile` can hang.

**Engine.** `find_engine` on win32, first found wins: the Room's own Chrome for Testing (win64, SHA-256 checked as today), Playwright's Chromium (`%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win\chrome.exe`), Google Chrome (`%ProgramFiles%`, then the per-user `%LOCALAPPDATA%\Google\Chrome\Application`), then Microsoft Edge (`%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`), which every Windows 10 and 11 has. It always runs headless with the Room's profile at `<Room home>\.room-browser\profile`, never the person's `User Data`. `chrome_flags` for win32 leave out `--password-store` (Windows always uses DPAPI) and keep the rest.

**IT policy is respected, not worked around.** Before launch, `winreg` reads `RemoteDebuggingAllowed` under `HKLM` and `HKCU` `Software\Policies\Microsoft\Edge` (and `Google\Chrome`, `Chromium`). When it is 0 for the engine found, the browser is off with a new reason `policy`: "Your organisation has switched this off in Edge. Ask your IT team." We do not offer a download to get around it.

**Windows-specific rules.** `Rules` compares `file://` paths case-insensitively with drive letters, and refuses every `file://` URL with a host (UNC). A UNC address would send the person's Windows sign-in hash to that server. Downloads keep Chromium's Mark of the Web, and a hand-off copies the `Zone.Identifier` stream so SmartScreen still checks the file. There is no managed policy file on Windows (that would mean writing the machine's registry), so it is as on macOS: `file://` outside the Room's home is refused at the controller, and the window says "Not locked off: this browser runs as you."

**Work sign-in.** On a PC joined to a work account, Edge (and Chrome with Microsoft's cloud sign-in on) can sign in to Microsoft 365 sites through Windows without the person typing. A fresh profile does not stop that, and we cannot test it here. When `HKLM\SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo` has entries and the engine is Edge, the Browser window says under Advanced: "On a work PC, Edge may sign in to work sites as you through Windows." The holds of 0007 section 1.5 (submit, message, purchase, login) apply as everywhere.

`off_reason` loses `windows`. `OFF_WORDS["windows"]` stays for an older helper.

**Built on `feat/windows` (section 2), and where it differs from the text above.** `winproc.crt_block` packs the block
and `winproc.PipedProcess` starts the engine: fds 0 and 1 are `NUL`, fd 2 is a pipe for what the engine prints (it is
the Advanced detail when it does not start; Chromium on Windows prints its errors there), 3 and 4 the DevTools pipe;
those handles only, through `HANDLE_LIST`, in a job of its own (`CREATE_NO_WINDOW`). `Session.close` asks the browser
to close, then ends the job and waits until it is empty; `Pipe.close` closes the write end first and the read end only
once the reader saw the end. The memory watchdog reads the job's working set (`Job.memory`). The job's own memory limit
is twice `MEMORY_CLOSE`, not `MEMORY_CLOSE`: the job counts memory set aside (commit), which for Chromium runs well
above the working set the watchdog reads, so at `MEMORY_CLOSE` it would fail allocations before the watchdog closed the
browser cleanly. The browser's job has none of the UI limits of section 3: on windows-2022 each one alone (handles,
clipboard read, clipboard write, system parameters, display settings, global atoms, desktop, exit Windows) stopped
Chromium's sandbox from creating its GPU process ("GPU process launch failed: error_code=18", then "GPU process isn't
usable. Goodbye."), with Chrome and with Edge, and with none the browser started (CI runs 42552436202 and 42553112016).
Pages still get no permission to read the clipboard (`--deny-permission-prompts`); the job does not hold it back.
The engine keeps the person's own `USERPROFILE` (the rest of `room_env` stays): with the Room's home there, Chromium
could not find its own folders and refused the pipe ("DevTools remote debugging requires a non-default data
directory"). The profile is the Room's all the same. The policy words
name the engine ("... in Edge." or "... in Chrome."); status carries them as `can.browser_off_words`, and opening the
browser answers 403 with them. `Software\Policies\Chromium` is read for Playwright's Chromium and `Google\Chrome for
Testing` as well for the Room's own build. A `file://` address with any host other than `localhost` is refused on every
system, not only Windows. The work PC line is `can.browser_advanced`, shown in the Room's Advanced sheet. A hand-off
copies the `Zone.Identifier` stream. The app's own listening ports on Windows come from `GetExtendedTcpTable`. The
backend's Room browser tests (`tests/test_room_browser.py`) now run on Windows too, in the "Windows: terminals and
browser" job. Not yet: the sidecar smoke test starting the browser (section 4), and a Room job the browser's job nests in
(section 3).

## 3. Containment, and what is said about it

Every Room process runs in a Job object. A Room job is created when the Room starts, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway flags (`BREAKAWAY_OK` and `SILENT_BREAKAWAY_OK` are never set). Inside it there is a nested job (Windows 8 and later) per terminal, one for the browser and one per quick command (`ShellDriver.run`, which also gets `CREATE_NO_WINDOW`). The sidecar holds the handles, so if it crashes Windows ends everything in the Room. The desktop shell's supervisor also puts the sidecar in a kill-on-close job, so closing or killing Rooks ends the sidecar too. Limits:

- The browser job has `JobMemoryLimit` = `MEMORY_CLOSE`, as a backstop under the existing watchdog. `tree_memory` and `_kill_tree` read the job's process list on Windows instead of `ps`.
- Every Room job gets `JOB_OBJECT_UILIMIT_READCLIPBOARD | WRITECLIPBOARD | GLOBALATOMS | SYSTEMPARAMETERS | DISPLAYSETTINGS | EXITWINDOWS | DESKTOP | HANDLES`. The Room never reads the person's clipboard, and nothing leaves it through the clipboard without the yes in Needs you. If CI shows the headless browser fails under one of these limits, that limit alone is removed for the browser job, and the reason is recorded here.

What a job is not: a wall. Room processes run with the person's own token. They can read and change the person's files and `HKCU`, reach the network, and decrypt anything protected by the person's DPAPI, including the Room browser's cookies. Status stays `isolation: "none"` and gains `containment: "job"`. The note reads: "Commands run as you, in a folder of its own. What they start stops when the Room stops, except a program handed to Windows to start, such as a scheduled task. It is not a locked off computer: they can read and change your files." (A program Windows starts on a Room program's behalf, through Task Scheduler, WMI's `Win32_Process.Create` or an out-of-process COM server such as explorer's `ShellExecute`, is not a child of anything in the job, so it is outside the job and outlives it; the release/1.1 review found the first wording overclaimed.) An offline Room on Windows points programs at a proxy that answers nothing, and Advanced says "a closed door, not a wall." `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` point into the Room's home. Programs that ask Windows for known folders still find the person's own, and Advanced says so. rooks-code's `NOT_CONTAINED_ON_WINDOWS` stays true. Its `_run_windows` gains a job so that a timeout ends the whole tree. A real wall (AppContainer or a restricted, low-integrity token, or a Hyper-V or QEMU guest) is later work in BACKLOG, not this branch.

**Built on `feat/windows` (section 3), and where it differs from the text above.** `winproc.room_job()` is the one Room
job of the process (the sidecar), made on first use, kill on close, no breakaway flag. Each terminal
(`winproc.Terminal`), each quick command (`winproc.run_captured`) and the browser (`winproc.PipedProcess`) get a job of
their own nested in it through the same `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so each is in both from its first
instruction. `ShellDriver.down` (Stop) calls `winproc.end_room()`, which ends everything still in the Room job; the
next start makes a new one. The UI limits are not on the Room job but on the terminal and quick command jobs
(`ROOM_UI_LIMITS`, every limit listed above): a nested job takes its parent's UI limits, and the browser's job, nested
in the Room job, cannot have any (section 2, CI runs 42552436202 and 42553112016). A quick command on Windows no longer
goes through `subprocess.Popen`: it runs with `CREATE_NO_WINDOW`, `NUL` for input and pipes for its output, and when
it ends or its time runs out its job is ended, so nothing it started outlives it (with Popen a timeout killed only Git
Bash and then waited on the output its children still held: on windows-2022 the command never came back, run
42556804352). The app's own Terminal page (`terminal_pty`) is the person's own and stays outside the Room job, without
UI limits. Status carries `containment: "job"` on Windows (`"none"` elsewhere) and the note above; the Room page shows
it under the command view and Advanced says what the job does and does not do, with "a closed door, not a wall" when
offline. `room_env` points `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` into the Room's home (`AppData\Roaming`,
`AppData\Local`, `AppData\Local\Temp`); the browser keeps the person's `APPDATA` and `LOCALAPPDATA`, as it keeps
`USERPROFILE`. The memory watchdog still reads the browser job's working set (section 2), not a `MEMORY_CLOSE` job limit.
Not done: rooks-code's `_run_windows` still ends a timed-out tree with `taskkill /T` rather than a job.

## 4. Installer and app

- **NSIS, per user** (`installMode: currentUser`, `%LOCALAPPDATA%\Rooks`), no administrator prompt. A Start menu entry "Rooks". A desktop shortcut only when the person ticks it. "Run Rooks" is ticked on the last page. The MSI stays for IT teams (Intune); the release notes say which file is for whom.
- **WebView2:** `webviewInstallMode: embedBootstrapper` (silent), so the installer does not first fetch the bootstrapper. Windows 11 and an updated Windows 10 already have the runtime. When it is missing and cannot be fetched, the installer says: "Rooks needs Microsoft Edge WebView2. Ask your IT team to install it."
- **Its own window:** the app opens its own WebView2 window titled "Rooks", never the person's browser. The splash shows until `/healthz` answers.
- **Autostart is off by default.** If a switch for it is added (`tauri-plugin-autostart`, an `HKCU\...\Run` value), it starts off, and the uninstaller removes the value.
- **Sidecar:** the PyInstaller spec collects `rooks_try` (with `winproc`) and the bundled `conpty.dll` and `OpenConsole.exe` as binaries. `smoke_sidecar.py` on Windows also opens a ConPTY terminal through the frozen sidecar and starts the browser over its pipe, so freezing cannot drop a module unnoticed.
- **Uninstall** through installer hooks (`bundle.windows.nsis.installerHooks`, `desktop/src-tauri/windows/hooks.nsh`) removes everything the installer and app added: the program folder, Start menu and desktop entries, the uninstall key, the `aiworkspace` link handler under `HKCU\Software\Classes`, the Run value and the WebView2 data folder. The person's chats, keys and Room are kept unless they tick "Also remove my chats, keys and the Room". Then the hook first runs `workbench-server.exe --forget-secrets`, which deletes the app's Credential Manager entries, and then removes `%APPDATA%\com.inclined88888.aiworkspace`, `%APPDATA%\ai-workspace` and `%USERPROFILE%\.ai-workspace`. A `/CLEANDATA` switch of our own, read with `GetOptions`, lets CI test both paths. Tools that install.ps1 put in place are separate and are not removed.

**Built on `feat/windows` (section 4), and where it differs from the text above.** `tauri.conf.json`:
`webviewInstallMode` `embedBootstrapper` (silent), NSIS `currentUser`, `installerHooks` `windows/hooks.nsh`,
`customLanguageFiles` `windows/English.nsh` (only English is built). The Start menu entry is
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Rooks.lnk`, pointing at the program, whose icon is `icons/icon.ico`
(the Rooks mark). Tauri's template makes a desktop shortcut on every silent or passive install (they skip the finish
page) and ticks the finish page's box; the hooks untick the box (`MUI_FINISHPAGE_SHOWREADME_NOTCHECKED`) and remove
the shortcut after a silent or passive install unless `/DESKTOP` was given or the person already had one. "Run Rooks"
stays ticked (Tauri's). Uninstall: Tauri removes the program files, the Start menu and desktop entries, the uninstall
key, the `aiworkspace` link handler and the `Rooks` Run value; the hooks add the window's data and the logs
(`%LOCALAPPDATA%\com.inclined88888.aiworkspace`), the key where the setup remembered its folder
(`HKCU\Software\Inclined88888\Rooks`), and copies of the one-file sidecar left in `%TEMP%\_MEI*` (only those holding
the app's own `app\packs\bundles`). The box is Tauri's "Delete the application data", worded "Also remove my chats,
keys and the Room"; ticked, or with `/CLEANDATA`, the hook first runs `workbench-server.exe --forget-secrets` (it
deletes the Credential Manager entries keyring wrote, `ai-workspace` and `<name>@ai-workspace`, and no other; the
packaged app keeps its own secrets in a file in its data folder, so on a fresh install there are none), then removes
`%APPDATA%\com.inclined88888.aiworkspace`, `%APPDATA%\ai-workspace`, `%USERPROFILE%\.ai-workspace\try-room` and
`appearance.json`, and `.ai-workspace` itself only when empty: `.ai-workspace\bin` belongs to other installers. When the
sidecar's file is still in use a moment after Tauri closed the app (the sidecar ends with the app's job), the hook
waits 3 s and deletes it again. There is no
autostart switch in the app, so there is no Run value to add; the uninstaller removes one anyway.

The shell (`sidecars.rs`) puts each sidecar in a kill-on-close job right after starting it. The job is the second
guard, not the only one: the sidecar also runs with `--exit-with-parent` and ends itself when its input closes, which
Windows does however the shell ends, and its Room job (which the sidecar holds) then ends the Room's programs. The one-file sidecar
unpacks itself for a second or more before it starts the program that does the work, so that program starts inside
the job; the unpacking step itself is assigned a moment after it starts (the shell plugin offers no suspended start).
On exit the shell first closes the sidecar's input (it ends by itself and removes its unpacked copy) and kills it only
after 5 s. The splash, the window titled "Rooks" and `/healthz` were already there.

## 5. What CI runs on windows-2022

The runner (Server 2022, build 20348) has Edge and Chrome preinstalled. A new job "Windows: terminals and browser" in `ci.yml`, plus the Try Room job's Windows leg, runs these:

1. `rooks-try/tests/test_winproc.py`, a real ConPTY session. PowerShell prints a line. `exit 3` gives code 3. A resize to 100×30 shows in `$Host.UI.RawUI.WindowSize`. `cmd /c exit 5` gives a marker of 5 with the nonce (in-band or side channel; the test records which). A `ping -n 999` child dies on close. A helper process that holds a job is killed, and its grandchild is gone within 5 s. `IsProcessInJob` is true for the shell. Git Bash gives a `.profile` marker.
2. `workbench/backend/tests/test_room_terminal_windows.py` (backend installed on Windows, these files only). Open a terminal over the real WebSocket, type, detach, attach again: the scrollback arrives. The exit code shows in the row. Close gives 129. The run log keeps only the lengths of sent lines.
3. `rooks-try/tests/test_browser_windows.py`, run with Edge and with Chrome. `find_engine` finds them. `Browser.getVersion` answers over the pipe. A page from a local `http.server` gives its text and one screencast frame. Every engine process is in the browser's job. `Get-NetTCPConnection -State Listen` shows no port owned by any of them. The profile lies under the Room's home, and the person's `Edge\User Data\Default` was not created. A `file://` UNC address is refused. Close leaves the job empty within 5 s. A fake `RemoteDebuggingAllowed=0` under `HKCU` gives `policy`; the test removes it afterwards.
4. In `desktop.yml`'s Windows leg, after the build: install the NSIS setup silently (`/S`). Check the folder, the Start menu link, the uninstall key, and that there is no Run value. Start `ai-workspace-desktop.exe` and wait for a window titled "Rooks" and a `/healthz` answer from the sidecar. Kill the app, and the sidecar is gone within 10 s. Uninstall with `/S` and check that everything in section 4 is gone and the data is kept. Then install again and uninstall with `/S /CLEANDATA`: the data and the Credential Manager entries are gone.

Fail first: on today's code, `find_engine` returns None on win32, `terminal_pty.enabled()` is false, `winproc` does not exist, and there are no hooks. Every test above fails.

## 6. Not tested here

A real Windows 10 PC (the runner is Server 2022), Windows on Arm, and ConPTY on builds before 20348 (the old `ClosePseudoConsole` blocking is handled but not seen). Not tested either: Edge and Chrome under real IT policies, sign-in through a work account (no work tenant), AppLocker or WDAC and PowerShell's constrained language mode, Defender's view of the bundled `OpenConsole.exe`, SmartScreen on an unsigned setup, and WebView2 missing on a locked-down network. The changelog and the pull request say so in these words.
