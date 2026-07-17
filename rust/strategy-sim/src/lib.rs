use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

pub const PROTOCOL_VERSION: u32 = 2;
const DOCK_LIMIT: usize = 7;
const TILE_SIZE: i32 = 10;

fn default_max_steps() -> usize {
    2000
}

#[derive(Debug, Deserialize)]
pub struct SimulationRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub policy: PolicyRequest,
    pub variants: Vec<PolicyVariantRequest>,
    pub board: BoardRequest,
    pub execution: ExecutionRequest,
}

#[derive(Debug, Deserialize)]
pub struct PolicyRequest {
    pub id: String,
    pub version: u32,
}

#[derive(Debug, Deserialize)]
pub struct PolicyVariantRequest {
    pub id: String,
    #[serde(default)]
    pub config: Value,
    pub base_seed: u32,
    #[serde(default)]
    pub collect_trace: bool,
}

#[derive(Debug, Deserialize)]
pub struct BoardRequest {
    pub tiles: Vec<TileInput>,
}

#[derive(Debug, Deserialize)]
pub struct ExecutionRequest {
    pub runs: usize,
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
}

#[derive(Debug, Deserialize)]
pub struct TileInput {
    pub id: i32,
    pub dependencies: Vec<i32>,
    pub element: i32,
    pub pos_x: i32,
    pub pos_y: i32,
    #[serde(default)]
    pub pile: PileInput,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PileInput {
    #[default]
    Desk,
    Dock,
    Discard,
}

#[derive(Debug, Serialize)]
pub struct SimulationResponse {
    pub protocol_version: u32,
    pub request_id: String,
    pub policy: PolicyIdentity,
    pub variants: Vec<VariantSimulationResponse>,
    pub elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct PolicyIdentity {
    pub id: String,
    pub version: u32,
}

#[derive(Debug, Serialize)]
pub struct VariantSimulationResponse {
    pub id: String,
    pub summary: SimulationSummary,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<RunResult>>,
}

#[derive(Debug, Serialize)]
pub struct SimulationSummary {
    pub runs: usize,
    pub wins: usize,
    pub losses: usize,
    pub win_rate: f64,
    pub total_win_steps: usize,
    pub total_loss_steps: usize,
    pub avg_steps_on_win: f64,
    pub avg_steps_on_loss: f64,
}

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub win: bool,
    pub fail_reason: Option<String>,
    pub picks: Vec<i32>,
    pub step_count: usize,
    pub seed: u32,
}

#[derive(Clone)]
struct Tile {
    id: i32,
    dependencies: Vec<usize>,
    element: i32,
    pos_x: i32,
    pos_y: i32,
    initial_pile: Pile,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pile {
    Desk,
    Dock,
    Discard,
}

impl From<PileInput> for Pile {
    fn from(value: PileInput) -> Self {
        match value {
            PileInput::Desk => Self::Desk,
            PileInput::Dock => Self::Dock,
            PileInput::Discard => Self::Discard,
        }
    }
}

struct PreparedRequest {
    request_id: String,
    policy: PolicyIdentity,
    tiles: Vec<Tile>,
    variants: Vec<PreparedVariant>,
    runs: usize,
    max_steps: usize,
}

struct PreparedVariant {
    id: String,
    base_seed: u32,
    mistake_rate: f64,
    collect_trace: bool,
}

impl SimulationRequest {
    fn prepare(self) -> Result<PreparedRequest, String> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported protocol_version {}; expected {}",
                self.protocol_version, PROTOCOL_VERSION
            ));
        }
        if self.policy.id != "mistake_player" || self.policy.version != 1 {
            return Err(format!(
                "unsupported policy {}@{}",
                self.policy.id, self.policy.version
            ));
        }
        if self.variants.is_empty() {
            return Err("at least one policy variant is required".to_string());
        }
        let mut variant_ids = HashSet::with_capacity(self.variants.len());
        let mut variants = Vec::with_capacity(self.variants.len());
        for variant in self.variants {
            if variant.id.is_empty() || !variant_ids.insert(variant.id.clone()) {
                return Err(format!(
                    "duplicate or empty policy variant id {}",
                    variant.id
                ));
            }
            let mistake_rate = variant
                .config
                .get("mistake_rate")
                .and_then(Value::as_f64)
                .ok_or_else(|| format!("{}.config.mistake_rate must be a number", variant.id))?;
            if !mistake_rate.is_finite() || !(0.0..=1.0).contains(&mistake_rate) {
                return Err(format!(
                    "{}.mistake_rate must be within [0,1], got {}",
                    variant.id, mistake_rate
                ));
            }
            variants.push(PreparedVariant {
                id: variant.id,
                base_seed: variant.base_seed,
                mistake_rate,
                collect_trace: variant.collect_trace,
            });
        }

        let mut ids = HashMap::with_capacity(self.board.tiles.len());
        for (index, tile) in self.board.tiles.iter().enumerate() {
            if ids.insert(tile.id, index).is_some() {
                return Err(format!("duplicate tile id {}", tile.id));
            }
        }

        let mut tiles = Vec::with_capacity(self.board.tiles.len());
        for tile in self.board.tiles {
            let mut dependency_ids = HashSet::with_capacity(tile.dependencies.len());
            let mut dependencies = Vec::with_capacity(tile.dependencies.len());
            for dependency_id in tile.dependencies {
                if dependency_id == tile.id {
                    return Err(format!("tile {} depends on itself", tile.id));
                }
                if !dependency_ids.insert(dependency_id) {
                    continue;
                }
                let dependency = ids.get(&dependency_id).copied().ok_or_else(|| {
                    format!(
                        "tile {} references missing dependency {}",
                        tile.id, dependency_id
                    )
                })?;
                dependencies.push(dependency);
            }
            tiles.push(Tile {
                id: tile.id,
                dependencies,
                element: tile.element,
                pos_x: tile.pos_x,
                pos_y: tile.pos_y,
                initial_pile: tile.pile.into(),
            });
        }

        Ok(PreparedRequest {
            request_id: self.request_id,
            policy: PolicyIdentity {
                id: self.policy.id,
                version: self.policy.version,
            },
            tiles,
            variants,
            runs: self.execution.runs,
            max_steps: self.execution.max_steps,
        })
    }
}

struct Game<'a> {
    tiles: &'a [Tile],
    pile: Vec<Pile>,
    runtime_deps: Vec<Vec<usize>>,
    clickable: Vec<bool>,
    invisible: Vec<bool>,
    desk: Vec<usize>,
    dock: Vec<usize>,
}

impl<'a> Game<'a> {
    fn new(tiles: &'a [Tile]) -> Self {
        let pile: Vec<Pile> = tiles.iter().map(|tile| tile.initial_pile).collect();
        let desk = pile
            .iter()
            .enumerate()
            .filter_map(|(index, value)| (*value == Pile::Desk).then_some(index))
            .collect();
        let dock = pile
            .iter()
            .enumerate()
            .filter_map(|(index, value)| (*value == Pile::Dock).then_some(index))
            .collect();
        let mut game = Self {
            tiles,
            pile,
            runtime_deps: vec![Vec::new(); tiles.len()],
            clickable: vec![false; tiles.len()],
            invisible: vec![false; tiles.len()],
            desk,
            dock,
        };
        game.update_state();
        game
    }

    fn is_win(&self) -> bool {
        self.desk.is_empty() && self.dock.is_empty()
    }

    fn is_dead(&self) -> bool {
        self.dock.len() >= DOCK_LIMIT
    }

    fn remaining_slots(&self) -> usize {
        DOCK_LIMIT.saturating_sub(self.dock.len())
    }

    fn update_state(&mut self) {
        for index in 0..self.tiles.len() {
            self.runtime_deps[index].clear();
            self.clickable[index] = false;
            self.invisible[index] = false;
            if self.pile[index] != Pile::Desk {
                continue;
            }
            for &dependency in &self.tiles[index].dependencies {
                if self.pile[dependency] == Pile::Desk {
                    self.runtime_deps[index].push(dependency);
                }
            }
            self.clickable[index] = self.runtime_deps[index].is_empty();
        }

        for index in 0..self.tiles.len() {
            if self.pile[index] != Pile::Desk {
                continue;
            }
            let perfectly_covered = self.runtime_deps[index]
                .iter()
                .any(|&dependency| self.overlap_area(index, dependency) >= 90);
            self.invisible[index] = perfectly_covered || self.projection_fully_covered(index);
        }
    }

    fn overlap_area(&self, a: usize, b: usize) -> i32 {
        let a = &self.tiles[a];
        let b = &self.tiles[b];
        let width = (a.pos_x + 5).min(b.pos_x + 5) - (a.pos_x - 5).max(b.pos_x - 5);
        let height = (a.pos_y + 5).min(b.pos_y + 5) - (a.pos_y - 5).max(b.pos_y - 5);
        if width <= 0 || height <= 0 {
            0
        } else {
            width * height
        }
    }

    fn projection_fully_covered(&self, tile_index: usize) -> bool {
        if self.runtime_deps[tile_index].is_empty() {
            return false;
        }
        let tile = &self.tiles[tile_index];
        let mut covered = [false; (TILE_SIZE * TILE_SIZE) as usize];
        let mut contributors = 0;
        for &dependency in &self.runtime_deps[tile_index] {
            if self.pile[dependency] != Pile::Desk {
                continue;
            }
            contributors += 1;
            let dependency_tile = &self.tiles[dependency];
            let start_x = (dependency_tile.pos_x - tile.pos_x).max(0);
            let start_y = (dependency_tile.pos_y - tile.pos_y).max(0);
            let end_x = (dependency_tile.pos_x - tile.pos_x + TILE_SIZE).min(TILE_SIZE);
            let end_y = (dependency_tile.pos_y - tile.pos_y + TILE_SIZE).min(TILE_SIZE);
            if start_x >= end_x || start_y >= end_y {
                continue;
            }
            for y in start_y..end_y {
                for x in start_x..end_x {
                    covered[(y * TILE_SIZE + x) as usize] = true;
                }
            }
        }
        contributors > 0 && covered.into_iter().all(|value| value)
    }

    fn collect(&mut self, tile: usize) {
        debug_assert!(self.pile[tile] == Pile::Desk && self.clickable[tile]);
        self.desk.retain(|&value| value != tile);
        self.pile[tile] = Pile::Dock;
        self.dock.push(tile);
        self.sort_dock();
        if let Some(matched) = self.first_match() {
            for matched_tile in matched {
                self.dock.retain(|&value| value != matched_tile);
                self.pile[matched_tile] = Pile::Discard;
            }
        }
        self.update_state();
    }

    fn sort_dock(&mut self) {
        let mut groups: Vec<(i32, Vec<usize>)> = Vec::new();
        for &tile in &self.dock {
            let color = self.tiles[tile].element;
            if let Some((_, items)) = groups.iter_mut().find(|(existing, _)| *existing == color) {
                items.push(tile);
            } else {
                groups.push((color, vec![tile]));
            }
        }
        self.dock = groups.into_iter().flat_map(|(_, items)| items).collect();
    }

    fn first_match(&self) -> Option<Vec<usize>> {
        let mut groups: Vec<(i32, Vec<usize>)> = Vec::new();
        for &tile in &self.dock {
            let color = self.tiles[tile].element;
            if let Some((_, items)) = groups.iter_mut().find(|(existing, _)| *existing == color) {
                if items.len() < 3 {
                    items.push(tile);
                }
            } else {
                groups.push((color, vec![tile]));
            }
        }
        groups
            .into_iter()
            .find_map(|(_, items)| (items.len() == 3).then_some(items))
    }

    fn clickable_tiles(&self) -> Vec<usize> {
        self.desk
            .iter()
            .copied()
            .filter(|&tile| self.clickable[tile])
            .collect()
    }

    fn unlock_gain(&self, removing: usize) -> usize {
        self.desk
            .iter()
            .copied()
            .filter(|&target| {
                target != removing
                    && !self.clickable[target]
                    && self.runtime_deps[target].contains(&removing)
                    && self.runtime_deps[target].iter().all(|&dependency| {
                        dependency == removing || self.pile[dependency] != Pile::Desk
                    })
            })
            .count()
    }
}

struct Rng {
    state: u32,
}

impl Rng {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let mut value = (self.state ^ (self.state >> 15)).wrapping_mul(self.state | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        ((value ^ (value >> 14)) as f64) / 4_294_967_296.0
    }
}

struct Group {
    tiles: [usize; 3],
    path: Vec<usize>,
    cost: usize,
}

fn collect_dependencies(game: &Game<'_>, tile: usize, seen: &mut [bool], path: &mut Vec<usize>) {
    for &dependency in &game.runtime_deps[tile] {
        if !seen[dependency] {
            seen[dependency] = true;
            path.push(dependency);
            collect_dependencies(game, dependency, seen, path);
        }
    }
}

fn visible_groups(game: &Game<'_>) -> Vec<Group> {
    let mut colors: Vec<(i32, Vec<usize>)> = Vec::new();
    for tile in 0..game.tiles.len() {
        if game.pile[tile] == Pile::Discard || game.tiles[tile].element <= 0 {
            continue;
        }
        let color = game.tiles[tile].element;
        if let Some((_, items)) = colors.iter_mut().find(|(existing, _)| *existing == color) {
            items.push(tile);
        } else {
            colors.push((color, vec![tile]));
        }
    }

    let mut groups = Vec::new();
    for (_, mut tiles) in colors {
        if tiles.len() < 3 {
            continue;
        }
        tiles.sort_by(|&a, &b| {
            let dock_a = if game.pile[a] == Pile::Dock { 0 } else { 1 };
            let dock_b = if game.pile[b] == Pile::Dock { 0 } else { 1 };
            dock_a
                .cmp(&dock_b)
                .then_with(|| game.runtime_deps[a].len().cmp(&game.runtime_deps[b].len()))
        });
        tiles.truncate(9);
        for first in 0..tiles.len() - 2 {
            for second in first + 1..tiles.len() - 1 {
                for third in second + 1..tiles.len() {
                    let chosen = [tiles[first], tiles[second], tiles[third]];
                    if chosen
                        .iter()
                        .any(|&tile| game.pile[tile] == Pile::Discard || game.invisible[tile])
                    {
                        continue;
                    }
                    let mut seen = vec![false; game.tiles.len()];
                    let mut path = Vec::new();
                    for &tile in &chosen {
                        if game.pile[tile] == Pile::Dock {
                            continue;
                        }
                        collect_dependencies(game, tile, &mut seen, &mut path);
                        if !seen[tile] {
                            seen[tile] = true;
                            path.push(tile);
                        }
                    }
                    groups.push(Group {
                        tiles: chosen,
                        cost: path.len(),
                        path,
                    });
                }
            }
        }
    }
    groups.sort_by_key(|group| group.cost);
    groups
}

fn strategic_pick(game: &Game<'_>, rng: &mut Rng) -> Option<usize> {
    let groups: Vec<Group> = visible_groups(game)
        .into_iter()
        .filter(|group| group.cost <= game.remaining_slots())
        .collect();
    if !groups.is_empty() {
        let chosen = &groups[(rng.next() * groups.len() as f64).floor() as usize];
        for &tile in &chosen.tiles {
            if game.pile[tile] == Pile::Desk && game.clickable[tile] {
                return Some(tile);
            }
        }
        for &tile in &chosen.path {
            if game.pile[tile] == Pile::Desk && game.clickable[tile] {
                return Some(tile);
            }
        }
        for group in &groups {
            for &tile in &group.tiles {
                if game.pile[tile] == Pile::Desk && game.clickable[tile] {
                    return Some(tile);
                }
            }
            for &tile in &group.path {
                if game.pile[tile] == Pile::Desk && game.clickable[tile] {
                    return Some(tile);
                }
            }
        }
    }

    let clickable = game.clickable_tiles();
    let max_gain = clickable.iter().map(|&tile| game.unlock_gain(tile)).max()?;
    let best: Vec<usize> = clickable
        .into_iter()
        .filter(|&tile| game.unlock_gain(tile) == max_gain)
        .collect();
    Some(best[(rng.next() * best.len() as f64).floor() as usize])
}

fn run_once(
    tiles: &[Tile],
    seed: u32,
    mistake_rate: f64,
    max_steps: usize,
    collect_trace: bool,
) -> RunResult {
    let mut game = Game::new(tiles);
    let mut rng = Rng::new(seed);
    let mut picks = collect_trace.then(Vec::new).unwrap_or_default();
    let mut steps = 0;

    while steps < max_steps {
        if game.is_win() {
            break;
        }
        if game.is_dead() {
            return RunResult {
                win: false,
                fail_reason: Some(format!("Dock full at step {steps}")),
                picks,
                step_count: steps,
                seed,
            };
        }
        let selected = if rng.next() < mistake_rate {
            let clickable = game.clickable_tiles();
            clickable
                .get((rng.next() * clickable.len() as f64).floor() as usize)
                .copied()
        } else {
            strategic_pick(&game, &mut rng)
        };
        let Some(tile) = selected else {
            return RunResult {
                win: false,
                fail_reason: Some(format!("No clickable tiles at step {steps}")),
                picks,
                step_count: steps,
                seed,
            };
        };
        if collect_trace {
            picks.push(game.tiles[tile].id);
        }
        game.collect(tile);
        steps += 1;
    }

    let win = game.is_win();
    let fail_reason = if win {
        None
    } else if game.is_dead() {
        Some("Dock full".to_string())
    } else {
        Some(format!("Max steps ({max_steps}) reached"))
    };
    RunResult {
        win,
        fail_reason,
        picks,
        step_count: steps,
        seed,
    }
}

fn simulate_variant(
    tiles: &[Tile],
    variant: PreparedVariant,
    runs: usize,
    max_steps: usize,
) -> VariantSimulationResponse {
    let started = Instant::now();
    let mut wins = 0;
    let mut total_win_steps = 0;
    let mut total_loss_steps = 0;
    let mut results = variant.collect_trace.then(|| Vec::with_capacity(runs));

    for run_index in 0..runs {
        let result = run_once(
            tiles,
            variant.base_seed.wrapping_add(run_index as u32),
            variant.mistake_rate,
            max_steps,
            variant.collect_trace,
        );
        if result.win {
            wins += 1;
            total_win_steps += result.step_count;
        } else {
            total_loss_steps += result.step_count;
        }
        if let Some(items) = results.as_mut() {
            items.push(result);
        }
    }

    VariantSimulationResponse {
        id: variant.id,
        summary: SimulationSummary {
            runs,
            wins,
            losses: runs - wins,
            win_rate: if runs > 0 {
                wins as f64 / runs as f64
            } else {
                0.0
            },
            total_win_steps,
            total_loss_steps,
            avg_steps_on_win: if wins > 0 {
                total_win_steps as f64 / wins as f64
            } else {
                0.0
            },
            avg_steps_on_loss: if runs > wins {
                total_loss_steps as f64 / (runs - wins) as f64
            } else {
                0.0
            },
        },
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        results,
    }
}

pub fn simulate(request: SimulationRequest) -> Result<SimulationResponse, String> {
    let request = request.prepare()?;
    let started = Instant::now();
    let variants = request
        .variants
        .into_iter()
        .map(|variant| simulate_variant(&request.tiles, variant, request.runs, request.max_steps))
        .collect();
    Ok(SimulationResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        policy: request.policy,
        variants,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(id: i32, element: i32) -> TileInput {
        TileInput {
            id,
            dependencies: Vec::new(),
            element,
            pos_x: id * 20,
            pos_y: 0,
            pile: PileInput::Desk,
        }
    }

    fn request(tiles: Vec<TileInput>) -> SimulationRequest {
        SimulationRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "test".to_string(),
            policy: PolicyRequest {
                id: "mistake_player".to_string(),
                version: 1,
            },
            variants: vec![PolicyVariantRequest {
                id: "default".to_string(),
                config: serde_json::json!({"mistake_rate": 0.0}),
                base_seed: 10021,
                collect_trace: true,
            }],
            board: BoardRequest { tiles },
            execution: ExecutionRequest {
                runs: 1,
                max_steps: 2000,
            },
        }
    }

    #[test]
    fn mulberry32_matches_typescript_reference() {
        let mut rng = Rng::new(10021);
        let expected = [0.777693291194737, 0.14170631673187017, 0.7892358526587486];
        for value in expected {
            assert!((rng.next() - value).abs() < f64::EPSILON);
        }
    }

    #[test]
    fn three_matching_desk_tiles_win_in_three_steps() {
        let response = simulate(request(vec![tile(1, 1), tile(2, 1), tile(3, 1)])).unwrap();
        assert_eq!(response.variants[0].summary.wins, 1);
        assert_eq!(response.variants[0].summary.total_win_steps, 3);
        assert_eq!(
            response.variants[0].results.as_ref().unwrap()[0]
                .picks
                .len(),
            3
        );
    }

    #[test]
    fn two_matching_dock_tiles_need_one_desk_pick() {
        let mut first = tile(1, 1);
        first.pile = PileInput::Dock;
        let mut second = tile(2, 1);
        second.pile = PileInput::Dock;
        let response = simulate(request(vec![first, second, tile(3, 1)])).unwrap();
        assert_eq!(response.variants[0].summary.wins, 1);
        assert_eq!(response.variants[0].summary.total_win_steps, 1);
    }

    #[test]
    fn seven_unmatched_tiles_fill_the_dock() {
        let tiles = (1..=7).map(|id| tile(id, id)).collect();
        let response = simulate(request(tiles)).unwrap();
        assert_eq!(response.variants[0].summary.losses, 1);
        assert_eq!(response.variants[0].summary.total_loss_steps, 7);
        assert_eq!(
            response.variants[0].results.as_ref().unwrap()[0]
                .fail_reason
                .as_deref(),
            Some("Dock full at step 7")
        );
    }

    #[test]
    fn executes_multiple_variants_in_one_request() {
        let mut input = request(vec![tile(1, 1), tile(2, 1), tile(3, 1)]);
        input.variants.push(PolicyVariantRequest {
            id: "mistake_15".to_string(),
            config: serde_json::json!({"mistake_rate": 0.15}),
            base_seed: 20021,
            collect_trace: false,
        });
        let response = simulate(input).unwrap();
        assert_eq!(response.variants.len(), 2);
        assert_eq!(response.variants[0].id, "default");
        assert_eq!(response.variants[1].id, "mistake_15");
        assert!(response.variants[1].results.is_none());
    }

    #[test]
    fn validates_protocol_and_dependency_ids() {
        let mut bad_protocol = request(vec![tile(1, 1)]);
        bad_protocol.protocol_version = 99;
        assert!(simulate(bad_protocol)
            .unwrap_err()
            .contains("protocol_version"));

        let mut missing_dependency = tile(1, 1);
        missing_dependency.dependencies.push(2);
        assert!(simulate(request(vec![missing_dependency]))
            .unwrap_err()
            .contains("missing dependency"));
    }
}
