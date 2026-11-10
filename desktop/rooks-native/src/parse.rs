//! Turn the local server's JSON into the rows this window shows.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub due: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailRow {
    pub uid: String,
    pub from: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorRow {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub on: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub job_id: String,
    pub approval_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRow {
    pub name: String,
    pub where_: String,
}

fn str_of(v: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

pub fn tasks(value: &Value) -> Vec<TaskRow> {
    let list = value.as_array().cloned().unwrap_or_default();
    list.into_iter()
        .filter_map(|v| {
            let id = v.get("id")?.as_i64()?;
            let title = str_of(&v, &["title"]);
            if title.is_empty() {
                return None;
            }
            Some(TaskRow {
                id,
                title,
                status: str_of(&v, &["status"]),
                due: str_of(&v, &["due"]),
            })
        })
        .collect()
}

pub fn accounts(value: &Value) -> Vec<Account> {
    let list = value.as_array().cloned().unwrap_or_default();
    list.into_iter()
        .filter_map(|v| {
            let id = v.get("id")?.as_i64()?;
            let label = str_of(&v, &["email", "address", "name", "username"]);
            Some(Account {
                id,
                label: if label.is_empty() {
                    format!("Mail {id}")
                } else {
                    label
                },
            })
        })
        .collect()
}

pub fn messages(value: &Value) -> Vec<MailRow> {
    let list = value.as_array().cloned().unwrap_or_default();
    list.into_iter()
        .map(|v| MailRow {
            uid: str_of(&v, &["uid", "id"]),
            from: str_of(&v, &["from"]),
            subject: {
                let s = str_of(&v, &["subject"]);
                if s.is_empty() {
                    "(no subject)".into()
                } else {
                    s
                }
            },
        })
        .collect()
}

pub fn skills(value: &Value) -> Vec<SkillRow> {
    let list = value
        .get("skills")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    list.into_iter()
        .filter_map(|v| {
            let id = str_of(&v, &["id"]);
            let name = str_of(&v, &["name"]);
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some(SkillRow {
                id,
                name,
                detail: str_of(&v, &["description", "why"]),
                added: v.get("added").and_then(|x| x.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

pub fn connectors(store: &Value, mcp: &Value) -> Vec<ConnectorRow> {
    let mut rows = Vec::new();
    let list = store
        .get("connectors")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for v in list {
        let id = str_of(&v, &["id"]);
        let name = str_of(&v, &["name"]);
        if id.is_empty() || name.is_empty() {
            continue;
        }
        rows.push(ConnectorRow {
            id,
            name,
            detail: str_of(&v, &["blurb"]),
            on: v.get("on").and_then(|x| x.as_bool()).unwrap_or(false),
        });
    }
    let servers = mcp
        .get("servers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for v in servers {
        let id = v
            .get("id")
            .and_then(|x| x.as_i64())
            .map(|n| format!("mcp-{n}"))
            .unwrap_or_default();
        let name = str_of(&v, &["name"]);
        if name.is_empty() {
            continue;
        }
        rows.push(ConnectorRow {
            id,
            name: format!("{name} (tool server)"),
            detail: str_of(&v, &["transport"]),
            on: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        });
    }
    rows
}

pub fn notices(dashboard: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(n) = dashboard.get("overdue").and_then(|v| v.as_i64()) {
        if n > 0 {
            out.push(if n == 1 {
                "1 task is late".into()
            } else {
                format!("{n} tasks are late")
            });
        }
    }
    if let Some(list) = dashboard.get("tasks_due").and_then(|v| v.as_array()) {
        for task in list.iter().take(5) {
            let title = str_of(task, &["title"]);
            if !title.is_empty() {
                let due = str_of(task, &["due"]);
                out.push(if due.is_empty() {
                    title
                } else {
                    format!("{title} · {due}")
                });
            }
        }
    }
    if let Some(list) = dashboard.get("arrived").and_then(|v| v.as_array()) {
        for item in list.iter().take(3) {
            let title = str_of(item, &["title"]);
            if !title.is_empty() {
                out.push(format!("New: {title}"));
            }
        }
    }
    out
}

fn checkpoints_in(job_id: &str, job: &Value) -> Vec<Checkpoint> {
    let mut out = Vec::new();
    for key in ["pending_approvals", "approvals", "pending"] {
        let Some(list) = job.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        for item in list {
            let approval_id = str_of(item, &["id"]);
            if approval_id.is_empty() {
                continue;
            }
            let summary = str_of(item, &["description", "text", "category", "tool"]);
            out.push(Checkpoint {
                job_id: job_id.to_string(),
                approval_id,
                summary: if summary.is_empty() {
                    "Waiting for you".into()
                } else {
                    summary
                },
            });
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

pub fn browser_jobs(value: &Value) -> Vec<JobRow> {
    let list = value.as_array().cloned().unwrap_or_default();
    list.into_iter()
        .filter_map(|v| {
            let id = str_of(&v, &["id"]);
            if id.is_empty() {
                return None;
            }
            let title = str_of(&v, &["goal", "task", "title"]);
            Some(JobRow {
                checkpoints: checkpoints_in(&id, &v),
                id,
                title: if title.is_empty() {
                    "Browser job".into()
                } else {
                    title
                },
                status: str_of(&v, &["status"]),
            })
        })
        .collect()
}

pub fn code_jobs(value: &Value) -> Vec<JobRow> {
    let list = value.as_array().cloned().unwrap_or_default();
    list.into_iter()
        .filter_map(|v| {
            let id = str_of(&v, &["id"]);
            if id.is_empty() {
                return None;
            }
            let title = str_of(&v, &["task", "title"]);
            let mut job = JobRow {
                checkpoints: Vec::new(),
                id: id.clone(),
                title: if title.is_empty() {
                    "Code job".into()
                } else {
                    title
                },
                status: str_of(&v, &["status"]),
            };
            if job.status == "needs_approval" {
                job.checkpoints.push(Checkpoint {
                    job_id: id,
                    approval_id: "run".into(),
                    summary: "This code job is waiting for you.".into(),
                });
            }
            job.checkpoints.extend(checkpoints_in(&job.id, &v));
            Some(job)
        })
        .collect()
}

pub fn models(value: &Value, allow_cloud: bool) -> Vec<ModelRow> {
    let list = value
        .get("models")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(|| value.as_array().cloned().unwrap_or_default());
    list.into_iter()
        .filter_map(|v| {
            let name = str_of(&v, &["model", "name", "ref"]);
            if name.is_empty() {
                return None;
            }
            let provider = str_of(&v, &["provider"]);
            let local = provider.to_lowercase().contains("ollama")
                || provider.to_lowercase().contains("local");
            let where_ = if local {
                "On this computer".into()
            } else if allow_cloud {
                format!("Cloud · {provider}")
            } else {
                "Cloud · off until you allow sending prompts".into()
            };
            Some(ModelRow { name, where_ })
        })
        .take(12)
        .collect()
}

pub fn assistant_name(value: &Value) -> String {
    let name = str_of(value, &["assistant_name"]);
    if name.is_empty() {
        "Atlas".into()
    } else {
        name
    }
}

pub fn format_terminal(enabled: bool, open: u64, platform: &str) -> String {
    if platform == "win32" || !enabled && platform == "win32" {
        return "The terminal inside this window is not available on Windows. The rooks command in a terminal you already have still works.".into();
    }
    if !enabled {
        return "The terminal is switched off. You can turn it on from the existing app's settings. The rooks command still works.".into();
    }
    match open {
        0 => "No terminal is open on this computer right now. Open one below, or use the rooks command you already have.".into(),
        1 => "1 terminal is open on this computer.".into(),
        n => format!("{n} terminals are open on this computer."),
    }
}

pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\r' {
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mail_tasks_and_a_checkpoint_come_out_of_the_server_json() {
        let tasks = tasks(
            &json!([{"id": 3, "title": "Write the note", "status": "todo", "due": "2026-11-06"}]),
        );
        assert_eq!(tasks[0].title, "Write the note");
        let mail = messages(&json!([{"uid": "9", "from": "Ada", "subject": "Hello"}]));
        assert_eq!(mail[0].from, "Ada");
        let jobs = browser_jobs(&json!([{
            "id": "j1",
            "goal": "Check the site",
            "status": "running",
            "pending_approvals": [{"id": "a1", "description": "Sign in on the site", "category": "login"}]
        }]));
        assert_eq!(jobs[0].checkpoints[0].approval_id, "a1");
        assert!(jobs[0].checkpoints[0].summary.contains("Sign in"));
    }

    #[test]
    fn terminal_words_do_not_use_the_old_name() {
        let line = format_terminal(true, 0, "linux");
        assert!(line.contains("No terminal is open"));
        assert!(!line.contains("AI Workspace"));
        assert!(format_terminal(false, 0, "win32").contains("Windows"));
    }

    #[test]
    fn ansi_codes_do_not_stay_in_the_terminal_text() {
        assert_eq!(strip_ansi("\u{1b}[32mhi\u{1b}[0m"), "hi");
    }

    #[test]
    fn cloud_models_stay_labelled_off_until_the_opt_in() {
        let rows = models(
            &json!({"models": [{"model": "gpt", "provider": "OpenAI"}, {"model": "qwen", "provider": "Ollama"}]}),
            false,
        );
        assert!(rows
            .iter()
            .any(|m| m.name == "gpt" && m.where_.contains("off")));
        assert!(rows
            .iter()
            .any(|m| m.name == "qwen" && m.where_.contains("this computer")));
    }
}
