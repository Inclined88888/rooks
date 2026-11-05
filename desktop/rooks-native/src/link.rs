//! Find the Rooks service on this computer, or start the one already installed.

use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Link {
    pub url: String,
    pub key: String,
    pub cookie: String,
}

pub struct Started {
    child: Child,
    pub link: Link,
}

impl Drop for Started {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AI_WORKSPACE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "macos")]
    {
        return home().join("Library/Application Support/com.inclined88888.aiworkspace");
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData/Roaming"));
        return base.join("com.inclined88888.aiworkspace");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".local/share"));
        base.join("com.inclined88888.aiworkspace")
    }
}

pub fn app_json_path() -> PathBuf {
    if let Ok(path) = std::env::var("AI_WORKSPACE_APP_FILE") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData/Roaming"));
        return base.join("ai-workspace").join("app.json");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config"));
        base.join("ai-workspace").join("app.json")
    }
}

fn install_path() -> PathBuf {
    let home = std::env::var("AI_WORKSPACE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".ai-workspace"));
    home.join("install.json")
}

pub fn read_link(path: &Path) -> Option<Link> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let url = value
        .get("url")?
        .as_str()?
        .trim_end_matches('/')
        .to_string();
    if url.is_empty() {
        return None;
    }
    Some(Link {
        url,
        key: value
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        cookie: String::new(),
    })
}

pub fn healthy(url: &str) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    agent.get(&format!("{url}/healthz")).call().is_ok()
}

/// Use the service that is already running, or start the installed one.
pub fn ensure() -> Result<Link, String> {
    if let Ok(link) = discover() {
        return Ok(link);
    }
    let started = start_installed()?;
    let link = started.link.clone();
    if let Ok(mut slot) = HOLD.lock() {
        *slot = Some(started);
    }
    Ok(link)
}

static HOLD: Mutex<Option<Started>> = Mutex::new(None);

pub fn discover() -> Result<Link, String> {
    if let Some(link) = read_link(&app_json_path()) {
        if healthy(&link.url) {
            return Ok(link);
        }
    }
    Err("Rooks is not running on this computer yet. Open the app you already use, or run ai-workspace, then open Rooks again.".into())
}

/// Start the installed service when it is not already up. Keeps the child so closing this window stops it.
pub fn start_installed() -> Result<Started, String> {
    if let Some(link) = read_link(&app_json_path()) {
        if healthy(&link.url) {
            return Ok(Started {
                child: idle_child()?,
                link,
            });
        }
    }
    if let Some(started) = start_from_install() {
        return started;
    }
    start_from_launcher()
}

fn idle_child() -> Result<Child, String> {
    // A service we did not start. This process exits at once, so closing Rooks does not stop it.
    let mut cmd = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/c", "exit"]);
        command
    } else {
        Command::new("true")
    };
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())
}

fn start_from_install() -> Option<Result<Started, String>> {
    let text = fs::read_to_string(install_path()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let python = value.get("python")?.as_str()?.to_string();
    let src = value.get("src")?.as_str()?.to_string();
    let server = PathBuf::from(&src).join("desktop/sidecar/workbench_server.py");
    if !server.is_file() || !Path::new(&python).is_file() {
        return None;
    }
    Some(spawn_server(&python, &server, &src))
}

fn spawn_server(python: &str, server: &Path, src: &str) -> Result<Started, String> {
    let port = free_port()?;
    let token = random_token();
    let data = data_dir();
    let _ = fs::create_dir_all(&data);
    let mut child = Command::new(python)
        .arg(server)
        .arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(&data)
        .arg("--exit-with-parent")
        .current_dir(src)
        .env("WORKBENCH_DESKTOP_TOKEN", &token)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the local service: {e}"))?;
    // Keep stdin open so --exit-with-parent stays up. Drop closes it.
    let _ = child.stdin.as_mut().map(|stdin| stdin.write_all(b" "));
    let url = format!("http://127.0.0.1:{port}");
    wait_healthy(&url, &mut child)?;
    let cookie = crate::client::Client::session_from_token(&url, &token).unwrap_or_default();
    let key = read_link(&app_json_path())
        .map(|l| l.key)
        .unwrap_or_default();
    Ok(Started {
        child,
        link: Link { url, key, cookie },
    })
}

fn start_from_launcher() -> Result<Started, String> {
    let Some(bin) = find_launcher() else {
        return Err("Rooks is not running on this computer yet. Open the app you already use, or run ai-workspace, then open Rooks again.".into());
    };
    let mut child = Command::new(&bin)
        .arg("--no-open")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the local service: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return Err("The local service stopped while starting.".into());
        }
        if let Some(link) = read_link(&app_json_path()) {
            if healthy(&link.url) {
                return Ok(Started { child, link });
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    let _ = child.kill();
    Err(
        "The local service did not answer. Open the app you already use, then try Rooks again."
            .into(),
    )
}

fn find_launcher() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ai-workspace.exe"
    } else {
        "ai-workspace"
    };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in [home().join(".local/bin"), home().join(".ai-workspace/bin")] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn wait_healthy(url: &str, child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return Err("The local service stopped while starting.".into());
        }
        if healthy(url) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("The local service did not answer.".into())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_link_is_read_without_calling_the_network() {
        let dir = std::env::temp_dir().join(format!("rooks-native-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.json");
        fs::write(&path, r#"{"url":"http://127.0.0.1:9","key":"abc"}"#).unwrap();
        let link = read_link(&path).unwrap();
        assert_eq!(link.url, "http://127.0.0.1:9");
        assert_eq!(link.key, "abc");
        let _ = fs::remove_dir_all(&dir);
    }
}
