//! Words people see, and the menus that stay on screen.

pub const PRODUCT: &str = "Rooks";
pub const KICKER: &str = "The new version";
pub const HEADLINE: &str = "The new version we are building.";
pub const BODY: &str = "A personal assistant on this computer. It takes a task, reads how a service works, and does the work. Mail, tasks, the terminal, the browser and code open inside this window.";

pub fn window_title() -> &'static str {
    PRODUCT
}

/// Work surfaces. Setup is not repeated here.
pub const SURFACES: &[(&str, &str)] = &[
    ("Home", "home"),
    ("Mail", "mail"),
    ("Tasks", "tasks"),
    ("Terminal", "terminal"),
    ("Browser", "browser"),
    ("Code", "code"),
];

/// Customize, Skills and Connectors, once, in the top bar.
pub const SETUP: &[(&str, &str)] = &[
    ("Customize", "customize"),
    ("Skills", "skills"),
    ("Connectors", "connectors"),
];

pub fn welcome_blob() -> String {
    format!("{PRODUCT}\n{KICKER}\n{HEADLINE}\n{BODY}")
}

pub fn setup_labels() -> Vec<&'static str> {
    SETUP.iter().map(|(label, _)| *label).collect()
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
    fn setup_appears_once_and_not_beside_mail() {
        let surfaces: Vec<_> = SURFACES.iter().map(|(label, _)| *label).collect();
        for word in ["Customize", "Skills", "Connectors"] {
            assert!(!surfaces.contains(&word), "{word} is not a work surface");
            assert_eq!(SETUP.iter().filter(|(label, _)| *label == word).count(), 1);
        }
        assert_eq!(setup_labels(), vec!["Customize", "Skills", "Connectors"]);
        assert!(surfaces.contains(&"Mail"));
        assert!(surfaces.contains(&"Home"));
    }

    #[test]
    fn the_crate_does_not_depend_on_a_web_view() {
        let toml = include_str!("../Cargo.toml").to_ascii_lowercase();
        for banned in ["wry", "tauri", "webkit", "webview", "electron", "cef"] {
            assert!(!toml.contains(banned), "{banned} must not be a dependency");
        }
    }
}
