import {
  runTerrainGeneration,
  type BatchConfig,
  type TerrainProgress,
  type UnifiedParams,
} from './batch-generator.js';
import { LogLevel, setLogLevel } from './index.js';

setLogLevel(LogLevel.Silent);

interface BatchWorkerData {
  config: BatchConfig;
  terrainIndex: number;
  terrainPath: string;
}

function send(message: unknown): void {
  if (process.send) process.send(message);
}

function cloneProgressWithPendingRows(tp: TerrainProgress): TerrainProgress {
  const rows = tp.rows.splice(0);
  return { ...tp, rows };
}

async function run(data: BatchWorkerData): Promise<void> {
  const { config, terrainIndex, terrainPath } = data;
  const unified: UnifiedParams = {
    closeRates: config.closeRates,
    colorCount: config.colorCount,
    colorCountRatio: config.colorCountRatio,
    spreadParam: config.spreadParam,
    debtPersistenceWeight: config.debtPersistenceWeight,
  };

  const finalTerrain = await runTerrainGeneration(
    config,
    unified,
    terrainIndex,
    terrainPath,
    (tp, rowsAdded) => {
      send({
        type: 'progress',
        terrainIndex,
        terrain: cloneProgressWithPendingRows(tp),
        rowsAdded,
      });
    },
  );
  send({
    type: 'done',
    terrainIndex,
    terrain: { ...finalTerrain, rows: [] },
  });
}

process.on('message', (message) => {
  run(message as BatchWorkerData)
    .then(() => process.exit(0))
    .catch((err) => {
      send({
        type: 'error',
        terrainIndex: (message as Partial<BatchWorkerData>)?.terrainIndex ?? -1,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
});
