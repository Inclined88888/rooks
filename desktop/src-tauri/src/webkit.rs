//! What the system webview (WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows) does not do on its own, and
//! a browser does (docs/design/0007 2.4):
//!
//! - `window.open(...)` and `<a target="_blank">` open nothing in WebKit. A web address leaves for the system browser;
//!   anything else is refused. The page itself sends links through `open_external` (desktop.ts), this is the backstop.
//! - A download (`<a download>`, a file the server sends as an attachment) is dropped unless the shell takes it. It
//!   is saved to the Downloads folder under a name that does not overwrite anything, and a notification says where.
//! - The microphone (voice, meetings) is a permission request the shell answers. It is granted; the camera, the
//!   screen, location and the rest are left to the system's own prompt.
//!
//! The main window keeps its settings (title, size) in tauri.conf.json with `create: false` and is built here, so
//! these handlers can be attached to it.

use std::path::{Path, PathBuf};

use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// A web address the system browser may open: http or https with a host. Never file:, javascript:, data: or an
/// app link, which would let a page start other programs.
pub fn is_web_address(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty())
}

/// The app's own pages (the backend on this computer). They are not sent to another browser: it is not signed in.
fn is_this_app(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    )
}

/// A file name from the server's suggestion or the address, with nothing that could leave the Downloads folder.
pub fn safe_name(suggested: Option<&str>, url: &Url) -> String {
    let from_url = url
        .path_segments()
        .and_then(|mut s| s.next_back().map(str::to_string))
        .unwrap_or_default();
    let raw = suggested
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or(from_url);
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(120)
        .collect();
    if name.is_empty() {
        "download".into()
    } else {
        name
    }
}

/// `dir/name`, or `dir/stem (2).ext` and so on when that file is already there.
pub fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (2..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| dir.join(format!("{stem} ({}){ext}", std::process::id())))
}

fn downloads_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn tell(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Build the main window from its config entry, with the handlers above.
pub fn build_main(app: &AppHandle) -> tauri::Result<()> {
    let Some(conf) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    let for_links = app.clone();
    let for_files = app.clone();
    WebviewWindowBuilder::from_config(app, &conf)?
        .on_new_window(move |url, _features| {
            if is_web_address(&url) && !is_this_app(&url) {
                if let Err(e) = for_links.opener().open_url(url.as_str(), None::<&str>) {
                    log::warn!("could not open a link in the browser: {e}");
                }
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dir = downloads_dir(&for_files);
                    let _ = std::fs::create_dir_all(&dir);
                    let suggested = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(str::to_string);
                    *destination = unique_in(&dir, &safe_name(suggested.as_deref(), &url));
                }
                DownloadEvent::Finished { path, success, .. } => {
                    if success {
                        let name = path
                            .as_deref()
                            .and_then(|p| p.file_name())
                            .and_then(|n| n.to_str())
                            .map(|n| format!("{n} is in your Downloads folder."))
                            .unwrap_or_else(|| "It is in your Downloads folder.".into());
                        tell(&for_files, "Saved", &name);
                    } else {
                        tell(
                            &for_files,
                            "The download did not finish",
                            "Try again from the page.",
                        );
                    }
                }
                _ => {}
            }
            true
        })
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_web_addresses_leave() {
        assert!(is_web_address(&u("https://accounts.google.com/x")));
        assert!(is_web_address(&u("http://example.com")));
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "aiworkspace://chat?q=x",
            "smb://h/s",
        ] {
            assert!(!is_web_address(&u(bad)), "{bad}");
        }
        assert!(is_this_app(&u("http://127.0.0.1:8123/api/x")));
        assert!(!is_this_app(&u("https://example.com")));
    }

    #[test]
    fn download_names_stay_in_the_folder() {
        let url = u("http://127.0.0.1:1/api/files/7/download");
        assert_eq!(safe_name(Some("../../.bashrc"), &url), "_.._.bashrc");
        assert_eq!(safe_name(Some("report.pdf"), &url), "report.pdf");
        assert_eq!(safe_name(None, &url), "download");
        assert_eq!(safe_name(Some("a/b\\c:d.txt"), &url), "a_b_c_d.txt");
        let dir = std::env::temp_dir().join(format!("rooks-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("r.pdf"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "r.pdf"), dir.join("r (2).pdf"));
        assert_eq!(unique_in(&dir, "new.pdf"), dir.join("new.pdf"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
