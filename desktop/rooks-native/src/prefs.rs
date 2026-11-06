//! Whether this window may send a prompt to a cloud provider. Off until the person turns it on.
//! The website and the old desktop app are not changed by this file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fit::Profile;
use crate::link::data_dir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Prefs {
    #[serde(default)]
    pub send_prompts_to_provider: bool,
    #[serde(default)]
    pub profile: Option<Profile>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            send_prompts_to_provider: false,
            profile: None,
        }
    }
}

pub fn path() -> PathBuf {
    data_dir().join("rooks-native.json")
}

pub fn load() -> Prefs {
    load_at(&path())
}

pub fn load_at(path: &Path) -> Prefs {
    let Ok(text) = fs::read_to_string(path) else {
        return Prefs::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(prefs: &Prefs) -> Result<(), String> {
    save_at(&path(), prefs)
}

pub fn save_at(path: &Path, prefs: &Prefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

pub fn cloud_line(on: bool) -> &'static str {
    if on {
        "Sending prompts to a cloud provider is on. A cloud model receives the prompt. A model on this computer does not."
    } else {
        "Sending prompts to a cloud provider is off. Models on this computer stay available. Turn this on only if you want a cloud model to receive the prompt."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_prompts_are_off_until_someone_opts_in() {
        let dir = std::env::temp_dir().join(format!("rooks-native-prefs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rooks-native.json");
        assert!(!load_at(&file).send_prompts_to_provider);
        save_at(
            &file,
            &Prefs {
                send_prompts_to_provider: true,
                profile: None,
            },
        )
        .unwrap();
        assert!(load_at(&file).send_prompts_to_provider);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cloud_line_says_what_leaving_the_computer_means() {
        assert!(cloud_line(false).contains("off"));
        assert!(cloud_line(true).contains("cloud model receives the prompt"));
        assert!(!cloud_line(false).contains("AI Workspace"));
    }
}
