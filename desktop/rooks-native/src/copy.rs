//! Words people see, and the menus that stay on screen.

pub const PRODUCT: &str = "Rooks";
pub const KICKER: &str = "The new version";
pub const HEADLINE: &str = "The new version we are building.";
pub const BODY: &str = "A personal assistant on this computer. It takes a task, reads how a service works, and does the work. Mail, tasks, the terminal, the browser and code open inside this window.";

pub fn window_title() -> &'static str {
    PRODUCT
}

/// The left rail, in order. Customize, Skills and Connectors are the core menus.
pub const RAIL: &[(&str, &str)] = &[
    ("Workplace", "workplace"),
    ("Customize", "customize"),
    ("Skills", "skills"),
    ("Connectors", "connectors"),
    ("Mail", "mail"),
    ("Tasks", "tasks"),
    ("Terminal", "terminal"),
    ("Browser", "browser"),
    ("Code", "code"),
];

pub fn welcome_blob() -> String {
    format!("{PRODUCT}\n{KICKER}\n{HEADLINE}\n{BODY}")
}

pub fn core_menus() -> Vec<&'static str> {
    RAIL.iter()
        .skip(1)
        .take(3)
        .map(|(label, _)| *label)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn welcome_is_the_new_version_not_the_old_desktop_words() {
        let text = welcome_blob();
        assert!(text.contains("Rooks"));
        assert!(text.contains("The new version we are building."));
        assert!(!text.contains("Desktop edition"));
        assert!(!text.contains("AI Workspace"));
        assert_eq!(window_title(), "Rooks");
    }

    #[test]
    fn customize_skills_and_connectors_are_always_on_the_rail() {
        let labels: Vec<_> = RAIL.iter().map(|(label, _)| *label).collect();
        assert!(labels.contains(&"Customize"));
        assert!(labels.contains(&"Skills"));
        assert!(labels.contains(&"Connectors"));
        assert!(
            labels.iter().position(|l| *l == "Customize")
                < labels.iter().position(|l| *l == "Mail")
        );
        let core = core_menus();
        assert_eq!(core, vec!["Customize", "Skills", "Connectors"]);
    }

    #[test]
    fn the_crate_does_not_depend_on_a_web_view() {
        let toml = include_str!("../Cargo.toml").to_ascii_lowercase();
        for banned in ["wry", "tauri", "webkit", "webview", "electron", "cef"] {
            assert!(!toml.contains(banned), "{banned} must not be a dependency");
        }
    }
}
