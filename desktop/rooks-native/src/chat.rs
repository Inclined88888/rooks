//! Ask Rooks. One turn at a time, streamed from the local service, drawn by this window.

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;

use crate::client::Client;

/// What the service says while it works on a turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Start { conversation_id: i64 },
    Writing(String),
    Tool(String),
    Approval(Approval),
    Message(String),
    Error(String),
    Done { conversation_id: i64 },
}

/// An action the service holds until you say yes or no.
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub id: i64,
    pub tool: String,
    pub args: String,
    pub reason: String,
}

/// One line in the transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

/// A chat in the list on the side.
#[derive(Debug, Clone, PartialEq)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub updated: String,
}

/// A turn in flight. The thread fills `events`; the window drains them on a tick.
pub struct Chat {
    events: Arc<Mutex<Vec<Event>>>,
    finished: Arc<AtomicBool>,
}

impl Chat {
    /// Send one message. The reply streams in on a background thread.
    pub fn send(client: Client, message: String, conversation_id: Option<i64>) -> Self {
        let events = Arc::new(Mutex::new(Vec::new()));
        let finished = Arc::new(AtomicBool::new(false));
        let sink = events.clone();
        let flag = finished.clone();
        thread::spawn(move || {
            match client.ask(&message, conversation_id) {
                Ok(reader) => read_stream(reader, &sink),
                Err(err) => push(&sink, Event::Error(err)),
            }
            flag.store(true, Ordering::SeqCst);
        });
        Self { events, finished }
    }

    /// Take every event that arrived since the last call.
    pub fn drain(&self) -> Vec<Event> {
        self.events
            .lock()
            .map(|mut slot| std::mem::take(&mut *slot))
            .unwrap_or_default()
    }

    /// True once the stream closed, whatever it said last.
    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }
}

fn push(sink: &Arc<Mutex<Vec<Event>>>, event: Event) {
    if let Ok(mut slot) = sink.lock() {
        slot.push(event);
    }
}

fn read_stream(reader: Box<dyn Read + Send>, sink: &Arc<Mutex<Vec<Event>>>) {
    let mut lines = BufReader::new(reader).lines();
    while let Some(Ok(line)) = lines.next() {
        if let Some(event) = parse_line(&line) {
            push(sink, event);
        }
    }
}

/// One `data: {...}` line from the stream, or nothing for blanks and comments.
pub fn parse_line(line: &str) -> Option<Event> {
    let data = line.trim().strip_prefix("data:")?.trim();
    if data.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(data).ok()?;
    parse_event(&value)
}

/// Keep only what the window draws. Thoughts, receipts and cards stay in the service.
pub fn parse_event(value: &Value) -> Option<Event> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let number = |key: &str| {
        value.get(key).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
    };
    if value.get("type").is_none() {
        let error = text("error");
        return (!error.is_empty()).then_some(Event::Error(error));
    }
    match value.get("type").and_then(|v| v.as_str())? {
        "start" => Some(Event::Start {
            conversation_id: number("conversation_id")?,
        }),
        "writing" => {
            let piece = text("text");
            (!piece.is_empty()).then_some(Event::Writing(piece))
        }
        "tool_call" => Some(Event::Tool(text("name"))),
        "approval_required" => Some(Event::Approval(Approval {
            id: number("id")?,
            tool: text("tool"),
            args: text("args"),
            reason: text("reason"),
        })),
        "message" => Some(Event::Message(text("content"))),
        "error" => Some(Event::Error(text("error"))),
        "done" => Some(Event::Done {
            conversation_id: number("conversation_id").unwrap_or(0),
        }),
        _ => None,
    }
}

/// The list of chats, newest first.
pub fn conversations(value: &Value) -> Vec<Conversation> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(Conversation {
                        id: row.get("id")?.as_i64()?,
                        title: row
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("New chat")
                            .to_string(),
                        updated: row
                            .get("updated_at")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .chars()
                            .take(16)
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The lines of one chat, as the window draws them. Tool rows become one quiet line each.
pub fn transcript(value: &Value) -> Vec<Turn> {
    let Some(rows) = value.get("messages").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let role = row.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let content = row
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match role {
                "user" => Some(Turn {
                    role: "you".into(),
                    content,
                }),
                "assistant" => {
                    let tools: Vec<&str> = row
                        .get("tool_calls")
                        .and_then(|v| v.as_array())
                        .map(|list| list.iter().filter_map(|t| t.as_str()).collect())
                        .unwrap_or_default();
                    if content.trim().is_empty() {
                        (!tools.is_empty()).then(|| Turn {
                            role: "tool".into(),
                            content: tool_line(&tools.join(", ")),
                        })
                    } else {
                        Some(Turn {
                            role: "rooks".into(),
                            content,
                        })
                    }
                }
                _ => None,
            }
        })
        .collect()
}

/// "web_search" reads as "Using web search".
pub fn tool_line(name: &str) -> String {
    format!("Using {}", name.replace('_', " "))
}

/// Words for a held action: the tool, and why it waits.
pub fn approval_line(approval: &Approval) -> String {
    let what = approval.tool.replace('_', " ");
    if approval.reason.trim().is_empty() {
        format!("Rooks wants to {what}. It waits for you.")
    } else {
        format!("Rooks wants to {what}. {}", approval.reason.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_stream_becomes_events_the_window_draws() {
        assert_eq!(
            parse_line(r#"data: {"type":"start","conversation_id":12}"#),
            Some(Event::Start {
                conversation_id: 12
            })
        );
        assert_eq!(
            parse_line("data: {\"type\":\"writing\",\"text\":\"Hel\"}"),
            Some(Event::Writing("Hel".into()))
        );
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line(": keep-alive"), None);
        assert_eq!(
            parse_event(&json!({"type":"tool_call","name":"web_search","args":"{}"})),
            Some(Event::Tool("web_search".into()))
        );
        assert_eq!(
            parse_event(&json!({"type":"thought","content":"hmm"})),
            None,
            "thoughts stay in the service"
        );
        assert_eq!(
            parse_event(&json!({"type":"approval_required","id":"41","tool":"send_mail","args":"{}","reason":"It sends mail."})),
            Some(Event::Approval(Approval {
                id: 41,
                tool: "send_mail".into(),
                args: "{}".into(),
                reason: "It sends mail.".into()
            }))
        );
        assert_eq!(
            parse_event(&json!({"error":"No model is set"})),
            Some(Event::Error("No model is set".into())),
            "a stream error has no type"
        );
        assert_eq!(
            parse_event(&json!({"type":"done","conversation_id":12,"cost_cents":0})),
            Some(Event::Done {
                conversation_id: 12
            })
        );
    }

    #[test]
    fn a_saved_chat_reads_as_you_rooks_and_quiet_tool_lines() {
        let turns = transcript(&json!({"id":3,"messages":[
            {"role":"user","content":"Find the invoice","tool_calls":[]},
            {"role":"assistant","content":"","tool_calls":["search_mail"]},
            {"role":"tool","content":"3 hits","name":"search_mail"},
            {"role":"assistant","content":"It is from Ada, sent Monday.","tool_calls":[]}
        ]}));
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "you");
        assert_eq!(turns[1].content, "Using search mail");
        assert_eq!(turns[2].role, "rooks");
        assert_eq!(
            approval_line(&Approval {
                id: 1,
                tool: "send_mail".into(),
                args: String::new(),
                reason: String::new()
            }),
            "Rooks wants to send mail. It waits for you."
        );
        let list = conversations(&json!([{"id":9,"title":"Invoices","updated_at":"2026-11-06T09:30:00Z"}]));
        assert_eq!(list[0].title, "Invoices");
        assert_eq!(list[0].updated, "2026-11-06T09:30");
    }
}
