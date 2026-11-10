//! Sidecar processes: the Workbench backend.
//!
//! Every long-running helper the app ships is a frozen executable listed in `tauri.conf.json` →
//! `bundle.externalBin` and described in [`SIDECARS`]. The [`Supervisor`] owns the running children, stops them on
//! exit, and reports their state to the UI (`list_sidecars`). Each child also exits by itself if this shell dies,
//! because it watches its stdin (`--exit-with-parent`).
//!
//! On exit the shell first closes a child's input and gives it a few seconds to end by itself: the one-file sidecar
//! then removes the copy of itself it unpacked into the temporary folder. Only after that is it killed. On Windows
//! each child is also put in a job that ends everything in it when its last handle closes (design 0011, section 3):
//! this process holds the only handle, so when Rooks ends, however it ends (closed, crashed, or ended in Task
//! Manager), Windows ends the sidecar and everything the sidecar started, the Room included.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// A helper process the app can run. `binary` is the externalBin name without the target-triple suffix.
#[derive(Clone, Copy, Serialize)]
pub struct SidecarSpec {
    pub name: &'static str,
    pub binary: &'static str,
    pub description: &'static str,
    /// Roadmap phase that ships it (1 = this release).
    pub phase: u8,
    pub enabled: bool,
}

/// Registry of sidecars. Only helpers that really ship are listed: Settings → Desktop app shows every row. A new
/// helper adds its binary to `bundle.externalBin`, a row here, and starts the same way as Workbench (see
/// [`start_workbench`]). The terminal (`rooks`), the browser helper (`rooks-browser`) and computer use (`rooks-desk`)
/// are installed beside the app by the installer, not frozen into it.
pub const SIDECARS: &[SidecarSpec] = &[
    SidecarSpec {
        name: "workbench",
        binary: "workbench-server",
        description: "Workbench backend: chat, run log, approvals, budgets, MCP server",
        phase: 1,
        enabled: true,
    },
];

#[derive(Default)]
struct State {
    children: HashMap<String, CommandChild>,
    /// Windows: the kill-on-close job every sidecar is put in (made with the first one).
    #[cfg(windows)]
    job: Option<winjob::KillOnClose>,
    status: HashMap<String, String>,
    workbench_url: Option<String>,
    /// Per-launch token the shell shares with the backend (feat/v02-anywhere-voice: the ask shortcut's grab).
    workbench_token: Option<String>,
}

#[derive(Default)]
pub struct Supervisor {
    state: Mutex<State>,
}

impl Supervisor {
    fn set_status(&self, name: &str, status: &str) {
        self.state
            .lock()
            .unwrap()
            .status
            .insert(name.into(), status.into());
    }

    pub fn workbench_url(&self) -> Option<String> {
        self.state.lock().unwrap().workbench_url.clone()
    }

    pub fn workbench_token(&self) -> Option<String> {
        self.state.lock().unwrap().workbench_token.clone()
    }

    /// Stop every sidecar: close its input (it ends by itself and tidies up), wait up to [`STOP_GRACE`], then kill
    /// whatever is still running.
    pub fn stop_all(&self) {
        let children: Vec<(String, CommandChild)> = self.state.lock().unwrap().children.drain().collect();
        let deadline = Instant::now() + STOP_GRACE;
        for (name, child) in children {
            let pid = child.pid();
            log::info!("stopping sidecar {name} ({pid}): closing its input");
            let waiter = exit_waiter(pid);
            drop(child); // closes its stdin: `--exit-with-parent` ends it
            if !waiter.wait_until(deadline) {
                log::warn!("sidecar {name} did not end within {STOP_GRACE:?}; killing it");
                kill_pid(pid);
            }
        }
        let mut st = self.state.lock().unwrap();
        #[cfg(windows)]
        if let Some(job) = st.job.as_ref() {
            job.terminate(); // anything a sidecar left running
        }
        for v in st.status.values_mut() {
            *v = "stopped".into();
        }
    }
}

/// How long a sidecar has to end by itself once its input is closed.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// Waits for one process to end, without owning it.
struct ExitWaiter {
    #[cfg(windows)]
    handle: Option<winjob::ProcessHandle>,
    #[cfg(not(windows))]
    pid: u32,
}

fn exit_waiter(pid: u32) -> ExitWaiter {
    #[cfg(windows)]
    {
        ExitWaiter { handle: winjob::ProcessHandle::open(pid) }
    }
    #[cfg(not(windows))]
    {
        ExitWaiter { pid }
    }
}

impl ExitWaiter {
    /// True when the process ended before `deadline`.
    fn wait_until(&self, deadline: Instant) -> bool {
        #[cfg(windows)]
        {
            match &self.handle {
                Some(h) => h.wait(deadline.saturating_duration_since(Instant::now())),
                None => true, // it could not be opened: it has ended already
            }
        }
        #[cfg(not(windows))]
        {
            loop {
                // signal 0: is there still a process with this id (the shell plugin's own thread reaps it)
                if unsafe { libc::kill(self.pid as libc::pid_t, 0) } != 0 {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    winjob::terminate_pid(pid);
    #[cfg(not(windows))]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// Windows job objects and process handles, through windows-sys (design 0011, section 3).
#[cfg(windows)]
mod winjob {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    /// A job that ends everything in it when its last handle closes. Breakaway is never allowed, so nothing in it can
    /// leave it. This process holds the only handle.
    pub struct KillOnClose(HANDLE);
    // A job handle may be used from any thread.
    unsafe impl Send for KillOnClose {}
    unsafe impl Sync for KillOnClose {}

    impl KillOnClose {
        pub fn new() -> std::io::Result<Self> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let e = std::io::Error::last_os_error();
                    CloseHandle(h);
                    return Err(e);
                }
                Ok(Self(h))
            }
        }

        /// Put a running process (and so everything it starts from now on) in the job.
        pub fn assign(&self, pid: u32) -> std::io::Result<()> {
            unsafe {
                let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if p.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let ok = AssignProcessToJobObject(self.0, p);
                let e = std::io::Error::last_os_error();
                CloseHandle(p);
                if ok == 0 {
                    Err(e)
                } else {
                    Ok(())
                }
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for KillOnClose {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// A handle to wait on a process that this shell does not own.
    pub struct ProcessHandle(HANDLE);

    impl ProcessHandle {
        pub fn open(pid: u32) -> Option<Self> {
            let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if h.is_null() {
                None
            } else {
                Some(Self(h))
            }
        }

        /// True when the process ended within `timeout`.
        pub fn wait(&self, timeout: Duration) -> bool {
            let ms = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
            unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
        }
    }

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn terminate_pid(pid: u32) {
        unsafe {
            let p = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !p.is_null() {
                TerminateProcess(p, 1);
                CloseHandle(p);
            }
        }
    }
}

#[derive(Serialize)]
pub struct SidecarOut {
    #[serde(flatten)]
    spec: SidecarSpec,
    status: String,
}

#[tauri::command]
pub fn list_sidecars(sup: tauri::State<'_, Supervisor>) -> Vec<SidecarOut> {
    let st = sup.state.lock().unwrap();
    SIDECARS
        .iter()
        .map(|s| SidecarOut {
            spec: *s,
            status: st.status.get(s.name).cloned().unwrap_or_else(|| {
                if s.enabled {
                    "not started"
                } else {
                    "coming soon"
                }
                .into()
            }),
        })
        .collect()
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn free_port() -> std::io::Result<u16> {
    Ok(
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port(),
    )
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// One plain HTTP/1.0 GET so the shell needs no HTTP client crate.
fn healthy(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut s) = TcpStream::connect_timeout(&addr.into(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut head = [0u8; 16];
    matches!(s.read(&mut head), Ok(n) if n >= 12 && &head[9..12] == b"200")
}

/// Tell the splash page what is happening (it defines `window.bootStatus`).
fn splash(app: &AppHandle, text: &str, error: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "window.bootStatus && window.bootStatus({}, {})",
            serde_json::to_string(text).unwrap(),
            error
        );
        let _ = w.eval(&js);
    }
}

/// Start the Workbench backend and point the window at it. Runs in the background so the splash paints at once.
pub fn start_workbench(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = boot(&app).await {
            log::error!("workbench failed to start: {e}");
            app.state::<Supervisor>().set_status("workbench", "failed");
            let logs = log_dir(&app)
                .map(|d| d.join("workbench.log").display().to_string())
                .unwrap_or_default();
            splash(
                &app,
                &format!("Workbench could not start: {e}. Details: {logs}"),
                true,
            );
        }
    });
}

async fn boot(app: &AppHandle) -> Result<(), String> {
    let sup = app.state::<Supervisor>();
    sup.set_status("workbench", "starting");
    let data = data_dir(app)?;
    let logs = log_dir(app)?;
    let port = free_port().map_err(|e| e.to_string())?;
    let token = random_token();
    let args = [
        "--port".to_string(),
        port.to_string(),
        "--data-dir".to_string(),
        data.display().to_string(),
        "--exit-with-parent".to_string(),
    ];

    // Development: WORKBENCH_SIDECAR_CMD="python3 desktop/sidecar/workbench_server.py" runs the unfrozen backend.
    let cmd = match std::env::var("WORKBENCH_SIDECAR_CMD") {
        Ok(dev) if !dev.trim().is_empty() => {
            let mut parts = dev.split_whitespace();
            let program = parts.next().unwrap().to_string();
            let pre: Vec<String> = parts.map(str::to_string).collect();
            app.shell().command(program).args(pre).args(args)
        }
        _ => app
            .shell()
            .sidecar("workbench-server")
            .map_err(|e| e.to_string())?
            .args(args),
    }
    .env("WORKBENCH_DESKTOP_TOKEN", &token)
    .env("PYTHONUNBUFFERED", "1");

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("cannot run the backend: {e}"))?;
    {
        let mut st = sup.state.lock().unwrap();
        // Windows: into the kill-on-close job at once. The one-file sidecar unpacks itself before it starts the
        // program that does the work, so that program starts inside the job; nothing the sidecar starts can leave it.
        #[cfg(windows)]
        {
            if st.job.is_none() {
                match winjob::KillOnClose::new() {
                    Ok(job) => st.job = Some(job),
                    Err(e) => log::warn!("no job for the sidecars: {e}"),
                }
            }
            if let Some(job) = st.job.as_ref() {
                if let Err(e) = job.assign(child.pid()) {
                    log::warn!("the backend could not be put in the app's job: {e}");
                }
            }
        }
        st.children.insert("workbench".into(), child);
    }

    // Backend output goes to <log dir>/workbench.log (started fresh each launch, previous one kept as .1).
    let log_path = logs.join("workbench.log");
    let _ = fs::rename(&log_path, logs.join("workbench.log.1"));
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    if let Some(f) = file.as_mut() {
                        let _ = f.write_all(&line);
                        if !line.ends_with(b"\n") {
                            let _ = f.write_all(b"\n");
                        }
                    }
                }
                CommandEvent::Terminated(p) => {
                    let sup = app2.state::<Supervisor>();
                    sup.state.lock().unwrap().children.remove("workbench");
                    sup.set_status("workbench", "stopped");
                    let _ = app2.emit("sidecar-exited", ("workbench", p.code));
                    log::warn!("workbench exited with {:?}", p.code);
                }
                CommandEvent::Error(e) => log::error!("workbench: {e}"),
                _ => {}
            }
        }
    });

    splash(app, "Starting your workspace…", false);
    // A one-file PyInstaller build unpacks itself on first launch, which can take a while on slow disks.
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if healthy(port) {
            break;
        }
        if !sup.state.lock().unwrap().children.contains_key("workbench") {
            return Err("the backend exited during start-up".into());
        }
        if Instant::now() > deadline {
            return Err("the backend did not answer within 2 minutes".into());
        }
        tokio_sleep(Duration::from_millis(250)).await;
    }
    let base = format!("http://127.0.0.1:{port}");
    {
        let mut st = sup.state.lock().unwrap();
        st.workbench_url = Some(base.clone());
        st.workbench_token = Some(token.clone());
    }
    sup.set_status("workbench", "running");
    let url = format!("{base}/api/desktop/session?token={token}");
    if let Some(w) = app.get_webview_window("main") {
        w.navigate(url.parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn tokio_sleep(d: Duration) {
    // tauri's async runtime is tokio; spawn_blocking keeps us off a tokio feature flag.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Settings → Desktop app shows every row, so a row is only listed when its helper really ships in the bundle.
    #[test]
    fn every_listed_sidecar_ships() {
        let conf = include_str!("../tauri.conf.json");
        for s in SIDECARS {
            assert!(s.enabled, "{} is listed but not enabled (a placeholder row)", s.name);
            assert!(conf.contains(&format!("\"binaries/{}\"", s.binary)), "{} is not in bundle.externalBin", s.binary);
        }
    }
}
