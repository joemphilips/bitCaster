use cashu::nuts::nut28::test_helpers::{create_test_announcement, create_test_oracle};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;

#[derive(Serialize)]
struct RegisterConditionRequest {
    threshold: u32,
    description: String,
    announcements: Vec<String>,
    condition_type: String,
}

#[derive(Deserialize)]
struct RegisterConditionResponse {
    condition_id: String,
}

#[derive(Serialize)]
struct RegisterPartitionRequest {
    collateral: String,
    partition: Vec<String>,
    parent_collection_id: String,
}

#[derive(Deserialize)]
struct RegisterPartitionResponse {
    keysets: HashMap<String, String>,
}

struct MarketDef {
    description: &'static str,
    outcomes: Vec<&'static str>,
    event_id: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mint_url = env::var("MINT_URL").unwrap_or_else(|_| "http://mintd:8085".to_string());
    let client = reqwest::Client::new();
    let oracle = create_test_oracle();

    let markets = vec![
        MarketDef {
            description: "Will Bitcoin reach $100K before end of 2026?",
            outcomes: vec!["Yes", "No"],
            event_id: "btc-100k-2026",
        },
        MarketDef {
            description: "2026 NBA Championship Winner",
            outcomes: vec!["Lakers", "Celtics", "Warriors", "Bucks", "Other"],
            event_id: "nba-champ-2026",
        },
        MarketDef {
            description: "Fed Q1 2026 Rate Decision",
            outcomes: vec!["Cut 50+ bps", "Cut 25 bps", "Hold", "Hike"],
            event_id: "fed-rate-q1-2026",
        },
    ];

    for market in &markets {
        println!("Seeding: {}", market.description);

        let (_, hex_tlv) = create_test_announcement(&oracle, &market.outcomes, market.event_id);

        // Register condition
        let cond_resp = client
            .post(format!("{mint_url}/v1/conditions"))
            .json(&RegisterConditionRequest {
                threshold: 1,
                description: market.description.to_string(),
                announcements: vec![hex_tlv],
                condition_type: "enum".to_string(),
            })
            .send()
            .await?;

        if !cond_resp.status().is_success() {
            let status = cond_resp.status();
            let body = cond_resp.text().await?;
            eprintln!("  Failed to register condition ({}): {}", status, body);
            continue;
        }

        let cond: RegisterConditionResponse = cond_resp.json().await?;
        println!("  condition_id: {}", cond.condition_id);

        // Register partition
        let part_resp = client
            .post(format!(
                "{mint_url}/v1/conditions/{}/partitions",
                cond.condition_id
            ))
            .json(&RegisterPartitionRequest {
                collateral: "sat".to_string(),
                partition: market.outcomes.iter().map(|s| s.to_string()).collect(),
                parent_collection_id: "0".repeat(64),
            })
            .send()
            .await?;

        if !part_resp.status().is_success() {
            let status = part_resp.status();
            let body = part_resp.text().await?;
            eprintln!("  Failed to register partition ({}): {}", status, body);
            continue;
        }

        let part: RegisterPartitionResponse = part_resp.json().await?;
        println!("  keysets: {:?}", part.keysets);
    }

    println!("Seeding complete.");
    Ok(())
}
