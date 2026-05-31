# ReverseGen Extracted

Standalone board generation algorithm and ReplayCode serializer, fully decoupled from Unity.

Extracted from the TileMatch game project — provides the **ReverseGen CostLadder algorithm** and **ReplaySerializer v4** as a pure TypeScript package for fast iteration, testing, and integration.

## Architecture

```
                    ┌──────────────────────┐
                    │   Terrain JSON File   │
                    │  (Unity level format) │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Terrain Loader     │
                    │  (terrain-loader.ts) │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌────────────┐   ┌──────────────┐  ┌──────────────┐
     │ Dep Graph  │   │    Tiles     │  │ Const Tiles  │
     │ (BFS)      │   │ (free tiles) │  │ (fixed elem) │
     └─────┬──────┘   └──────┬───────┘  └──────┬───────┘
           │                 │                  │
           └─────────┬───────┘                  │
                     │                          │
                     ▼                          │
           ┌──────────────────┐                 │
           │  Triple Builder  │                 │
           │  C(n,3) enum     │                 │
           └────────┬─────────┘                 │
                    │                           │
                    ▼                           │
           ┌──────────────────┐                 │
           │  ReverseGen      │                 │
           │  CostLadder Algo │                 │
           │  + Pooling       │                 │
           │  + Blacklist     │                 │
           │  + Rescue        │                 │
           └────────┬─────────┘                 │
                    │                           │
                    ▼                           │
           ┌──────────────────┐                 │
           │  Greedy Sim      │                 │
           │  (verification)  │                 │
           └────────┬─────────┘                 │
                    │                           │
                    └───────────┬───────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │  Element Values  │
                      │  (all tiles)     │
                      └────────┬─────────┘
                               │
                               ▼
                      ┌──────────────────┐
                      │  ReplaySerializer│
                      │  v4 binary       │
                      │  + Deflate       │
                      │  + CRC16/MODBUS  │
                      │  + Base64        │
                      └────────┬─────────┘
                               │
                               ▼
                      ┌──────────────────┐
                      │   ReplayCode     │
                      │  (Base64 string) │
                      └──────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Generate a board from a terrain file
npx tsx cli/generate.ts --terrain test/fixtures/sample-terrain.json \
  --cost 3,3,2,2,2,1 --colors 6

# Or use a test terrain
npx tsx cli/generate.ts --test-terrain --layers 3 --tiles 18 \
  --cost 3,3,2,2,2,1 --colors 6

# Get just the ReplayCode (for piping)
npx tsx cli/generate.ts -t terrain.json -c 3,3,2 -k 6 -q

# JSON output
npx tsx cli/generate.ts -t terrain.json -c 3,3,2 -k 6 --json

# Decode an existing ReplayCode
npx tsx cli/generate.ts -d "eJx1kEsOAUEQRH..."
```

## API Usage

```typescript
import {
  generateBoard,
  loadTerrainFromFile,
  generateTestTerrain,
  runReverseGen,
  generateReplayCode,
  getCanonicalTileOrder,
  getAllTiles,
  decodeFromString,
  looksLikeReplayCode,
  setLogLevel,
  LogLevel,
} from 'reversegen';

// ── High-Level API ──
const terrain = loadTerrainFromFile('level.json');
const result = generateBoard({
  terrain,
  costArray: [3, 3, 2, 2, 2, 1],
  colorCount: 8,
});

console.log(result.replayCode);     // Base64 ReplayCode
console.log(result.costLog);        // Actual costs per step
console.log(result.matchRate);      // % match with cost targets
console.log(result.assignments);    // Map<tileId, elementValue>

// ── Natural minCost mode (no cost targets) ──
const result2 = generateBoard({
  terrain,
  costArray: null,  // or omit
  colorCount: 6,
});

// ── Low-Level API ──
const tiles = getAllTiles(terrain);

// Run algorithm directly
const algoResult = runReverseGen({
  tiles,
  costArray: [3, 3, 2, 2, 2, 1],
  colorCount: 8,
});

// Generate ReplayCode manually
const orderedTiles = getCanonicalTileOrder(tiles);
const elementValues = new Map<number, number>();
for (const [tileId, ev] of algoResult.assignments) {
  elementValues.set(tileId, ev);
}
const code = generateReplayCode(orderedTiles, elementValues, terrain.levelHash);
```

## Terrain Format

Supports the original Unity level JSON format:

```json
{
  "levelResId": 100001,
  "LevelHash": "550ede7fd250e2d4",
  "layers": [
    {
      "tiles": [
        {
          "ID": 1,
          "Layer": 0,
          "Dependencies": [],
          "IsConst": false,
          "ConstElementValue": 0,
          "PosX": 15,
          "PosY": 3
        }
      ]
    }
  ]
}
```

Key fields per tile:
- `ID` — unique tile identifier
- `Layer` — layer index (0 = bottom, higher = on top)
- `Dependencies` — array of tile IDs this tile sits on top of
- `IsConst` — whether the tile has a fixed element value
- `ConstElementValue` — the fixed element value (only when `IsConst` is true)

## Algorithm Details

### ReverseGen CostLadder

The algorithm works by simulating the game in reverse:

1. **Dependency graph**: BFS-based transitive closure for every tile
2. **Triple enumeration**: C(n,3) combinations of all free tiles, each with a merged dependency set
3. **Greedy selection**: At each step, pick the triple with minimum dynamic cost (uncollected dependencies)
4. **Blacklisting**: Candidates with cost ≤ the chosen triple's cost are banned, preventing internal contradictions
5. **Pooling**: Consecutive same-cost steps (cost ≤ 3) are merged — multiple non-overlapping triples are selected under a single snapshot, sharing dependency sets
6. **Rescue**: When candidates are exhausted, search backward through the ban list for the most recently banned valid triple
7. **Color safety**: Each triple's color is chosen to minimize "violations" where banned triples would become same-colored

### ReplaySerializer v4

Binary format:
```
[0]       version (1B = 4)
[1]       N tile count (1B)
[2]       elementCount K (1B)
[3..10]   levelHash uint64 LE (8B)
[11..N+10] instanceArray N × 1B (2bit state | 6bit elemIndex)
[N+11]    dockCount (1B, 0-7)
[N+12..]  dockEntries dockCount × 2B
[last-1..] CRC16/MODBUS (2B, LE)
```

Pipeline: `binary → Deflate → Base64`

## Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:algo
npm run test:serializer
```

## Project Structure

```
reversegen/
├── src/
│   ├── types.ts              # Core data types
│   ├── logger.ts             # Console logger
│   ├── crc16.ts              # CRC16/MODBUS (table + bitwise)
│   ├── dependency-graph.ts   # BFS transitive closure
│   ├── triple-builder.ts     # C(n,3) enumeration + cost calc
│   ├── reverse-gen.ts        # Main ReverseGen algorithm
│   ├── greedy-sim.ts         # Post-assignment pure greedy sim
│   ├── replay-serializer.ts  # v4 encode/decode + Deflate
│   ├── terrain-loader.ts     # JSON terrain loading + test gen
│   └── index.ts              # Public API + high-level generateBoard()
├── cli/
│   └── generate.ts           # CLI tool
├── test/
│   ├── fixtures/
│   │   └── sample-terrain.json
│   ├── test-reverse-gen.ts
│   └── test-serializer.ts
├── package.json
├── tsconfig.json
└── README.md
```

## ReplayCode Format

The ReplayCode is a self-contained, compact string that encodes a complete board state:

- **Self-describing**: Contains `levelHash` to identify the terrain
- **Complete restoration**: Color assignments, Dock state, and eliminated tiles are fully recoverable
- **Cross-platform deterministic**: Deflate compression + CRC16/MODBUS checksum
- **Compact**: Typically 50-200 characters, suitable for IM, copy-paste, config tables

When decoded and loaded via `TileMatchBattle.LoadLevel_V2`, the ReplayCode reconstructs the exact board state — including which tiles share colors and which are in Dock — without needing the original algorithm or random seed.

## License

Internal tool — extracted from the TileMatch game project for algorithm testing purposes.
