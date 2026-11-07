//! Talk to the running local service with the real key. Not shipped; a check for a person.
use std::io::BufRead;
use rooks_native::chat::{self, Event};
use rooks_native::{discover, Client};

fn main() {
    let link = discover().expect("app.json");
    let client = Client::new(link.url.clone(), link.key.clone(), link.cookie.clone());
    let question = std::env::args().nth(1).unwrap_or_else(|| "In one sentence, what can you do in this window?".into());
    let reader = client.ask(&question, None).expect("ask");
    let mut cid = 0;
    for line in std::io::BufReader::new(reader).lines().map_while(Result::ok) {
        if let Some(event) = chat::parse_line(&line) {
            println!("{event:?}");
            if let Event::Start { conversation_id } | Event::Done { conversation_id } = &event { cid = *conversation_id; }
        }
    }
    println!("stop -> {:?}", client.stop_turn(cid));
    let chats = client.conversations().expect("conversations");
    println!("chats: {} first={:?}", chats.len(), chats.first().map(|c| (&c.title, &c.updated)));
    let turns = client.transcript(cid).expect("transcript");
    for t in &turns { println!("  [{}] {}", t.role, t.content.chars().take(90).collect::<String>()); }
}
