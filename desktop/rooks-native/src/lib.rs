//! The Rooks window's logic. The pixels live in `main.rs`. Nothing here draws a web page.

pub mod client;
pub mod copy;
pub mod link;
pub mod parse;
pub mod prefs;
pub mod term;

pub use client::Client;
pub use copy::{window_title, BODY, HEADLINE, KICKER, PRODUCT, RAIL};
pub use link::{app_json_path, data_dir, discover, Link};
pub use prefs::{load as load_prefs, save as save_prefs, Prefs};
