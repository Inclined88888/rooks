//! What to suggest from the short interview. Saved on this computer, used on later launches.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Profile {
    pub role: String,
    pub tools: Vec<String>,
    pub help: Vec<String>,
}

impl Profile {
    pub fn ready(&self) -> bool {
        !self.role.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Suggestion {
    pub group: &'static str,
    pub title: &'static str,
    pub why: &'static str,
    pub id: &'static str,
}

pub const ROLES: &[(&str, &str)] = &[
    ("operator", "I run the day to day"),
    ("maker", "I build things"),
    ("writer", "I write"),
    ("founder", "I keep a company moving"),
];

pub const TOOLS: &[(&str, &str)] = &[
    ("mail", "Mail"),
    ("calendar", "Calendar"),
    ("github", "GitHub"),
    ("browser", "A web browser"),
    ("terminal", "A terminal"),
    ("chat", "Slack or similar"),
];

pub const HELP: &[(&str, &str)] = &[
    ("inbox", "The inbox"),
    ("tasks", "What is due"),
    ("code", "Code in a folder"),
    ("web", "Looking things up"),
    ("writing", "Writing and drafts"),
];

fn has(list: &[String], id: &str) -> bool {
    list.iter().any(|item| item == id)
}

pub fn suggestions(profile: &Profile) -> Vec<Suggestion> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<Suggestion>, item: Suggestion| {
        if !out.iter().any(|have| have.title == item.title) {
            out.push(item);
        }
    };
    if has(&profile.tools, "mail") || has(&profile.help, "inbox") {
        push(
            &mut out,
            Suggestion {
                group: "connector",
                title: "Mail",
                why: "You already use mail, or you want help with the inbox.",
                id: "mail",
            },
        );
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Inbox check",
                why: "A short pass over what still needs a reply.",
                id: "inbox-check",
            },
        );
    }
    if has(&profile.tools, "calendar") || profile.role == "founder" || profile.role == "operator" {
        push(
            &mut out,
            Suggestion {
                group: "connector",
                title: "Calendar",
                why: "The day is easier when what is scheduled is in view.",
                id: "calendar",
            },
        );
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Meeting prep",
                why: "A few lines before the next thing on the calendar.",
                id: "meeting-prep",
            },
        );
    }
    if has(&profile.help, "tasks") || profile.role == "operator" {
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Task sweep",
                why: "Sort what is due into today, waiting, and later.",
                id: "task-sweep",
            },
        );
    }
    if has(&profile.help, "code") || has(&profile.tools, "github") || profile.role == "maker" {
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Careful coding",
                why: "Say what will change before anything is edited.",
                id: "careful-coding",
            },
        );
        push(
            &mut out,
            Suggestion {
                group: "connector",
                title: "GitHub",
                why: "Repositories and reviews, when you want them in reach.",
                id: "github",
            },
        );
    }
    if has(&profile.help, "web") || has(&profile.tools, "browser") {
        push(
            &mut out,
            Suggestion {
                group: "connector",
                title: "Browser",
                why: "Open a site, and stop before anything is sent or paid.",
                id: "browser",
            },
        );
    }
    if has(&profile.help, "writing") || profile.role == "writer" {
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Weekly review",
                why: "A short look at what got done, and what is still open.",
                id: "weekly-review",
            },
        );
    }
    if out.is_empty() {
        push(
            &mut out,
            Suggestion {
                group: "skill",
                title: "Weekly review",
                why: "A calm place to start, until you connect more.",
                id: "weekly-review",
            },
        );
    }
    out
}

pub fn for_group<'a>(profile: &Profile, group: &str) -> Vec<Suggestion> {
    suggestions(profile)
        .into_iter()
        .filter(|item| item.group == group)
        .collect()
}

/// Home never uses this as the whole page. It is the line under the suggestions.
pub fn home_guide(has_work: bool) -> &'static str {
    if has_work {
        "Here is what is waiting, next to what fits how you work."
    } else {
        "Your day is clear. The suggestions below follow what you told Rooks. Add a task when you have one."
    }
}

pub fn greeting(profile: &Profile) -> String {
    match profile.role.as_str() {
        "operator" => "You run the day to day.".into(),
        "maker" => "You build things.".into(),
        "writer" => "You write.".into(),
        "founder" => "You keep a company moving.".into(),
        _ => "Good to see you.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_and_inbox_recommend_mail_and_a_skill_once_each() {
        let profile = Profile {
            role: "writer".into(),
            tools: vec!["mail".into()],
            help: vec!["inbox".into(), "writing".into()],
        };
        let items = suggestions(&profile);
        assert_eq!(items.iter().filter(|item| item.title == "Mail").count(), 1);
        assert!(items
            .iter()
            .any(|item| item.title == "Inbox check" && item.group == "skill"));
        assert!(items
            .iter()
            .any(|item| item.group == "connector" && item.title == "Mail"));
        assert!(!home_guide(false).contains("Nothing new right now"));
        assert!(!home_guide(false).contains("AI Workspace"));
    }

    #[test]
    fn a_maker_who_codes_gets_careful_coding_not_a_second_menu() {
        let profile = Profile {
            role: "maker".into(),
            tools: vec!["github".into(), "terminal".into()],
            help: vec!["code".into()],
        };
        let items = suggestions(&profile);
        assert!(items.iter().any(|item| item.id == "careful-coding"));
        assert!(items.iter().all(|item| item.title != "Customize"
            && item.title != "Skills"
            && item.title != "Connectors"));
    }
}
