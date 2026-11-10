//! A terminal session on this computer. The window draws the text itself.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

use crate::parse::strip_ansi;

pub struct Term {
    output: Arc<Mutex<String>>,
    input: Option<std::sync::mpsc::Sender<String>>,
}

impl Term {
    pub fn output(&self) -> String {
        self.output.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn send_line(&self, line: &str) {
        if let Some(tx) = &self.input {
            let _ = tx.send(line.to_string());
        }
    }

    /// Open a shell through the local service. `cookie` is the session from this window.
    pub fn open(base: &str, cookie: &str) -> Result<Self, String> {
        if cookie.is_empty() {
            return Err("This window is not signed in to the terminal. The service is up; open a terminal from the app you already use, or start Rooks when that service is not already running.".into());
        }
        let url = ws_url(base);
        let host = host_of(base);
        let cookie = cookie.to_string();
        let output = Arc::new(Mutex::new(String::new()));
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let sink = output.clone();
        thread::spawn(move || {
            if let Err(err) = run(&url, &host, &cookie, &sink, rx) {
                if let Ok(mut text) = sink.lock() {
                    if text.is_empty() {
                        text.push_str(&err);
                    }
                }
            }
        });
        Ok(Self {
            output,
            input: Some(tx),
        })
    }
}

pub fn ws_url(base: &str) -> String {
    let rest = base
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');
    format!("ws://{rest}/api/terminal/ws")
}

fn host_of(base: &str) -> String {
    base.trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

pub fn input_frame(data: &str) -> String {
    serde_json::json!({"type": "input", "data": data}).to_string()
}

fn run(
    url: &str,
    host: &str,
    cookie: &str,
    output: &Arc<Mutex<String>>,
    rx: std::sync::mpsc::Receiver<String>,
) -> Result<(), String> {
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let origin = format!("http://{host}")
        .parse()
        .map_err(|e: tungstenite::http::header::InvalidHeaderValue| e.to_string())?;
    let cookie_header = format!("wb_session={cookie}")
        .parse()
        .map_err(|e: tungstenite::http::header::InvalidHeaderValue| e.to_string())?;
    request.headers_mut().insert("Origin", origin);
    request.headers_mut().insert("Cookie", cookie_header);
    let (mut socket, _) = connect(request).map_err(|e| e.to_string())?;
    if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = socket.get_mut() {
        tcp.set_read_timeout(Some(Duration::from_millis(200))).ok();
    }
    loop {
        while let Ok(line) = rx.try_recv() {
            let frame = input_frame(&format!("{line}\n"));
            socket
                .send(Message::Text(frame))
                .map_err(|e| e.to_string())?;
        }
        match socket.read() {
            Ok(Message::Text(text)) => push(output, &strip_ansi(&text)),
            Ok(Message::Binary(bytes)) => {
                let text = String::from_utf8_lossy(&bytes);
                push(output, &strip_ansi(&text));
            }
            Ok(Message::Close(frame)) => {
                if let Some(frame) = frame {
                    push(output, frame.reason.as_ref());
                }
                break;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(tungstenite::Error::ConnectionClosed) => break,
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(())
}

fn push(output: &Arc<Mutex<String>>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut slot) = output.lock() {
        slot.push_str(text);
        if slot.len() > 20_000 {
            let drain = slot.len() - 16_000;
            slot.drain(..drain);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terminal_address_stays_on_this_computer() {
        assert_eq!(
            ws_url("http://127.0.0.1:8765"),
            "ws://127.0.0.1:8765/api/terminal/ws"
        );
        let frame = input_frame("ls");
        assert!(frame.contains("\"type\":\"input\""));
        assert!(frame.contains("ls"));
        assert!(!frame.contains("AI Workspace"));
    }
}
