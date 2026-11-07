//! Talks only to the Rooks service on this computer.

use serde_json::{json, Value};
use ureq::Agent;

use crate::chat::{self, Conversation, Turn};
use crate::parse::{self, Account, JobRow, MailRow, ModelRow, SkillRow, TaskRow};

#[derive(Clone)]
pub struct Client {
    base: String,
    bearer: String,
    cookie: String,
    agent: Agent,
}

impl Client {
    pub fn new(
        base: impl Into<String>,
        bearer: impl Into<String>,
        cookie: impl Into<String>,
    ) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            bearer: bearer.into(),
            cookie: cookie.into(),
            agent: Agent::new(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn cookie(&self) -> &str {
        &self.cookie
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let response = self
            .prep(self.agent.get(&self.url(path)))
            .call()
            .map_err(|e| e.to_string())?;
        response.into_json().map_err(|e| e.to_string())
    }

    fn send(&self, method: &str, path: &str, body: Value) -> Result<Value, String> {
        let req = match method {
            "POST" => self.agent.post(&self.url(path)),
            "PATCH" => self.agent.request("PATCH", &self.url(path)),
            "PUT" => self.agent.put(&self.url(path)),
            _ => return Err(format!("unsupported {method}")),
        };
        let response = self.prep(req).send_json(body).map_err(|e| e.to_string())?;
        if response.status() == 204 {
            return Ok(Value::Null);
        }
        response.into_json().map_err(|e| e.to_string())
    }

    fn prep(&self, req: ureq::Request) -> ureq::Request {
        // X-Workbench is the CSRF gate on state-changing /api calls (main.py guard).
        let mut req = req
            .set("Accept", "application/json")
            .set("X-Workbench", "1");
        if !self.bearer.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", self.bearer));
        }
        if !self.cookie.is_empty() {
            req = req.set("Cookie", &format!("wb_session={}", self.cookie));
        }
        req
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn tasks(&self) -> Result<Vec<TaskRow>, String> {
        Ok(parse::tasks(&self.get("/api/tasks")?))
    }

    pub fn add_task(&self, title: &str) -> Result<TaskRow, String> {
        let value = self.send(
            "POST",
            "/api/tasks",
            json!({"title": title, "status": "todo"}),
        )?;
        Ok(parse::tasks(&Value::Array(vec![value]))
            .into_iter()
            .next()
            .unwrap_or(TaskRow {
                id: 0,
                title: title.to_string(),
                status: "todo".into(),
                due: String::new(),
            }))
    }

    pub fn complete_task(&self, id: i64) -> Result<(), String> {
        self.send(
            "PATCH",
            &format!("/api/tasks/{id}"),
            json!({"status": "done"}),
        )?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<Account>, String> {
        Ok(parse::accounts(&self.get("/api/mail/accounts")?))
    }

    pub fn messages(&self, account: i64) -> Result<Vec<MailRow>, String> {
        Ok(parse::messages(
            &self.get(&format!("/api/mail/{account}/messages"))?,
        ))
    }

    pub fn skills(&self) -> Result<Vec<SkillRow>, String> {
        Ok(parse::skills(&self.get("/api/skills/store")?))
    }

    pub fn add_skill(&self, id: &str) -> Result<(), String> {
        self.send("POST", &format!("/api/skills/store/{id}"), json!({}))?;
        Ok(())
    }

    pub fn connectors(&self) -> Result<Vec<crate::parse::ConnectorRow>, String> {
        let store = self.get("/api/skills/store")?;
        let mcp = self
            .get("/api/mcp/servers")
            .unwrap_or(json!({"servers": []}));
        Ok(parse::connectors(&store, &mcp))
    }

    pub fn notices(&self) -> Result<Vec<String>, String> {
        Ok(parse::notices(&self.get("/api/dashboard")?))
    }

    pub fn assistant_name(&self) -> Result<String, String> {
        Ok(parse::assistant_name(&self.get("/api/assistant/settings")?))
    }

    pub fn save_assistant_name(&self, name: &str) -> Result<(), String> {
        self.send(
            "PUT",
            "/api/assistant/settings",
            json!({"assistant_name": name}),
        )?;
        Ok(())
    }

    pub fn models(&self, allow_cloud: bool) -> Result<Vec<ModelRow>, String> {
        Ok(parse::models(&self.get("/api/models")?, allow_cloud))
    }

    pub fn terminal_status(&self) -> Result<(bool, u64, String), String> {
        let value = self.get("/api/terminal/status")?;
        let enabled = value
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let open = value.get("open").and_then(|v| v.as_u64()).unwrap_or(0);
        let platform = value
            .get("platform")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok((enabled, open, platform))
    }

    pub fn browser_jobs(&self) -> Result<Vec<JobRow>, String> {
        Ok(parse::browser_jobs(&self.get("/api/browser/jobs")?))
    }

    pub fn browser_answer(&self, job: &str, approval: &str, approve: bool) -> Result<(), String> {
        self.send(
            "POST",
            &format!("/api/browser/jobs/{job}/approvals/{approval}"),
            json!({"approve": approve}),
        )?;
        Ok(())
    }

    pub fn browser_stop(&self, job: &str) -> Result<(), String> {
        self.send(
            "POST",
            &format!("/api/browser/jobs/{job}/cancel"),
            json!({}),
        )?;
        Ok(())
    }

    pub fn code_jobs(&self) -> Result<Vec<JobRow>, String> {
        Ok(parse::code_jobs(&self.get("/api/cli-agents/runs")?))
    }

    pub fn code_answer(&self, id: &str, approve: bool) -> Result<(), String> {
        if approve {
            self.send(
                "POST",
                &format!("/api/cli-agents/runs/{id}/approve"),
                json!({}),
            )?;
        } else {
            self.send(
                "POST",
                &format!("/api/cli-agents/runs/{id}/deny"),
                json!({}),
            )?;
        }
        Ok(())
    }

    /// One turn, streamed. The caller reads `data:` lines until the service closes the body.
    pub fn ask(
        &self,
        message: &str,
        conversation_id: Option<i64>,
    ) -> Result<Box<dyn std::io::Read + Send>, String> {
        let mut body = json!({"message": message, "channel": "web"});
        if let Some(cid) = conversation_id {
            body["conversation_id"] = json!(cid);
        }
        let response = self
            .prep(self.agent.post(&self.url("/api/assistant/chat")))
            .set("Accept", "text/event-stream")
            .send_json(body)
            .map_err(ask_error)?;
        Ok(Box::new(response.into_reader()))
    }

    /// Cancel the turn that is running in a chat. What was written stays.
    pub fn stop_turn(&self, conversation_id: i64) -> Result<(), String> {
        self.send(
            "POST",
            "/api/assistant/stop",
            json!({"conversation_id": conversation_id}),
        )?;
        Ok(())
    }

    /// Yes or no to an action the service is holding.
    pub fn decide(&self, approval: i64, approve: bool) -> Result<(), String> {
        self.send(
            "POST",
            &format!("/api/approvals/{approval}"),
            json!({"approve": approve}),
        )?;
        Ok(())
    }

    pub fn conversations(&self) -> Result<Vec<Conversation>, String> {
        Ok(chat::conversations(&self.get("/api/conversations?channel=web")?))
    }

    pub fn transcript(&self, conversation_id: i64) -> Result<Vec<Turn>, String> {
        Ok(chat::transcript(
            &self.get(&format!("/api/conversations/{conversation_id}"))?,
        ))
    }

    /// Trade the desktop launch token for the session cookie the terminal expects.
    pub fn session_from_token(base: &str, token: &str) -> Result<String, String> {
        let agent = ureq::AgentBuilder::new().redirects(0).build();
        let response = agent
            .get(&format!(
                "{}/api/desktop/session?token={token}",
                base.trim_end_matches('/')
            ))
            .call()
            .map_err(|e| e.to_string())?;
        cookie_from_response(&response)
    }

    /// Trade the bridge key from app.json for a session cookie when the service was already up.
    pub fn session_from_key(base: &str, key: &str) -> Result<String, String> {
        if key.is_empty() {
            return Err("No local bridge key.".into());
        }
        let agent = ureq::AgentBuilder::new().redirects(0).build();
        let response = agent
            .post(&format!(
                "{}/api/desktop/local-session",
                base.trim_end_matches('/')
            ))
            .set("Authorization", &format!("Bearer {key}"))
            .set("X-Workbench", "1")
            .call()
            .map_err(|e| e.to_string())?;
        cookie_from_response(&response)
    }
}

/// The service answers a bad turn with a short reason. Show that, not the whole HTTP line.
fn ask_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
                .unwrap_or(body);
            if detail.trim().is_empty() {
                format!("The local service said {code}.")
            } else {
                detail
            }
        }
        other => other.to_string(),
    }
}

fn cookie_from_response(response: &ureq::Response) -> Result<String, String> {
    let header = response.header("set-cookie").unwrap_or("");
    let cookie = header.split(';').next().unwrap_or("").trim();
    let Some(value) = cookie.strip_prefix("wb_session=") else {
        return Err("The local service did not sign this window in.".into());
    };
    Ok(value.to_string())
}
