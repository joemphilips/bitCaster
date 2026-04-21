use cashu::nuts::nut_ctf::test_helpers::{create_test_announcement, create_test_oracle};

fn main() {
    let oracle = create_test_oracle();

    let markets: Vec<(&str, Vec<&str>, &str)> = vec![
        (
            "Will Bitcoin reach $100K before end of 2026?",
            vec!["Yes", "No"],
            "btc-100k-2026",
        ),
        (
            "2026 NBA Championship Winner",
            vec!["Lakers", "Celtics", "Warriors", "Bucks", "Other"],
            "nba-champ-2026",
        ),
        (
            "Fed Q1 2026 Rate Decision",
            vec!["Cut 50+ bps", "Cut 25 bps", "Hold", "Hike"],
            "fed-rate-q1-2026",
        ),
    ];

    for (description, outcomes, event_id) in &markets {
        let (_, hex_tlv) = create_test_announcement(&oracle, outcomes, event_id);
        println!("# {description}");
        println!("# outcomes: {outcomes:?}");
        println!("# event_id: {event_id}");
        println!("{hex_tlv}");
        println!();
    }
}
