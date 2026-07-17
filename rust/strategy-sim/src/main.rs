use reversegen_strategy_sim::{simulate, SimulationRequest};
use std::env;
use std::fs;
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args()
        .nth(1)
        .ok_or("usage: reversegen-strategy-sim <input.json|->")?;
    let json = if path == "-" {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input)?;
        input
    } else {
        fs::read_to_string(path)?
    };
    let request: SimulationRequest = serde_json::from_str(&json)?;
    let response = simulate(request).map_err(|message| format!("invalid request: {message}"))?;
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}
