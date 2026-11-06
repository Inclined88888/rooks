//! Mail, tasks and a browser checkpoint, against a service that only exists for this test.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use rooks_native::client::Client;
use rooks_native::parse;

fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&buf[..header_end]);
                    let length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if buf.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            let req = String::from_utf8_lossy(&buf);
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let (status, body, extra_headers) = route(&req, path);
            let mut raw = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            for header in extra_headers {
                raw.push_str(&header);
                raw.push_str("\r\n");
            }
            raw.push_str("\r\n");
            raw.push_str(&body);
            let _ = stream.write_all(raw.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn route(req: &str, path: &str) -> (u16, String, Vec<String>) {
    if path.starts_with("/api/tasks") && req.starts_with("POST") {
        return (
            200,
            r#"{"id":4,"title":"Call back","status":"todo","due":null}"#.into(),
            vec![],
        );
    }
    if path == "/api/tasks" {
        return (
            200,
            r#"[{"id":3,"title":"Write the note","status":"todo","due":"2026-11-06"}]"#.into(),
            vec![],
        );
    }
    if path.starts_with("/api/tasks/") && req.starts_with("PATCH") {
        return (
            200,
            r#"{"id":3,"title":"Write the note","status":"done"}"#.into(),
            vec![],
        );
    }
    if path == "/api/mail/accounts" {
        return (200, r#"[{"id":2,"email":"ada@example.com"}]"#.into(), vec![]);
    }
    if path.contains("/messages") {
        return (
            200,
            r#"[{"uid":"9","from":"Ada","subject":"Hello","date":""}]"#.into(),
            vec![],
        );
    }
    if path.contains("/approvals/") && req.starts_with("POST") {
        assert!(
            req.contains("\"approve\":true")
                || req.contains("\"approve\": true")
                || req.contains("\"approve\":false")
                || req.contains("\"approve\": false"),
            "{req}"
        );
        return (200, r#"{"ok":true}"#.into(), vec![]);
    }
    if path == "/api/browser/jobs" {
        return (
            200,
            r#"[{"id":"j1","goal":"Check the site","status":"running","pending_approvals":[{"id":"a1","description":"Sign in on the site","category":"login"}]}]"#.into(),
            vec![],
        );
    }
    if path == "/api/cli-agents/runs" {
        return (
            200,
            r#"[{"id":"c1","task":"Fix the test","status":"needs_approval","folder":"/tmp"}]"#
                .into(),
            vec![],
        );
    }
    if path.contains("/approve") || path.contains("/deny") || path.contains("/cancel") {
        return (200, r#"{"ok":true}"#.into(), vec![]);
    }
    if path == "/api/skills/store" {
        return (
            200,
            r#"{"skills":[{"id":"inbox-check","name":"Inbox check","description":"Look through new mail","added":false}],"connectors":[{"id":"mail","name":"Mail","blurb":"Read and draft mail","on":true}]}"#.into(),
            vec![],
        );
    }
    if path == "/api/mcp/servers" {
        return (
            200,
            r#"{"servers":[{"id":7,"name":"files","transport":"stdio","enabled":true}]}"#.into(),
            vec![],
        );
    }
    if path == "/api/dashboard" {
        return (
            200,
            r#"{"overdue":1,"tasks_due":[{"title":"Write the note","due":"2026-11-06"}],"arrived":[]}"#.into(),
            vec![],
        );
    }
    if path == "/api/assistant/settings" {
        return (200, r#"{"assistant_name":"Atlas"}"#.into(), vec![]);
    }
    if path == "/api/models" {
        return (
            200,
            r#"{"models":[{"model":"gpt","provider":"OpenAI"},{"model":"qwen","provider":"Ollama"}],"default":""}"#.into(),
            vec![],
        );
    }
    if path == "/api/terminal/status" {
        return (
            200,
            r#"{"enabled":true,"platform":"linux","open":0,"max":6}"#.into(),
            vec![],
        );
    }
    if path.starts_with("/api/desktop/session") {
        return (303, r#"{}"#.into(), vec![]);
    }
    if path == "/api/desktop/local-session" && req.starts_with("POST") {
        assert!(
            req.to_ascii_lowercase()
                .contains("authorization: bearer test-key-test-key-test-key"),
            "{req}"
        );
        return (
            200,
            r#"{"ok":true}"#.into(),
            vec!["Set-Cookie: wb_session=session-from-key; Path=/; HttpOnly".into()],
        );
    }
    (404, r#"{"detail":"missing"}"#.into(), vec![])
}

#[test]
fn mail_tasks_and_a_checkpoint_work_against_a_local_service() {
    let base = serve();
    let client = Client::new(base, "test-key-test-key-test-key", "");
    let tasks = client.tasks().unwrap();
    assert_eq!(tasks[0].title, "Write the note");
    client.add_task("Call back").unwrap();
    client.complete_task(3).unwrap();
    let accounts = client.accounts().unwrap();
    assert_eq!(accounts[0].label, "ada@example.com");
    let mail = client.messages(2).unwrap();
    assert_eq!(mail[0].subject, "Hello");
    let jobs = client.browser_jobs().unwrap();
    assert_eq!(jobs[0].checkpoints[0].summary, "Sign in on the site");
    client.browser_answer("j1", "a1", true).unwrap();
    let code = client.code_jobs().unwrap();
    assert_eq!(code[0].status, "needs_approval");
    client.code_answer("c1", false).unwrap();
    assert!(client.notices().unwrap()[0].contains("late"));
    assert_eq!(client.skills().unwrap()[0].name, "Inbox check");
    assert!(client
        .connectors()
        .unwrap()
        .iter()
        .any(|c| c.name == "Mail" && c.on));
    let (enabled, open, _) = client.terminal_status().unwrap();
    assert!(enabled && open == 0);
    let line = parse::format_terminal(enabled, open, "linux");
    assert!(line.contains("No terminal is open"));
    assert!(!line.contains("AI Workspace"));
    assert!(!line.contains("Desktop edition"));
}

#[test]
fn bridge_key_mints_a_session_cookie_when_the_service_was_already_up() {
    let base = serve();
    let cookie = Client::session_from_key(&base, "test-key-test-key-test-key").unwrap();
    assert_eq!(cookie, "session-from-key");
    assert!(Client::session_from_key(&base, "").is_err());
}
