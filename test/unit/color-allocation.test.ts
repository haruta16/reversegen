import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildGenerationLogicalLayers,
  buildSingleHeavyTripletPlan,
  getAllTiles,
  loadTerrainFromFile,
  runLayerClosureGen,
} from '../../src/index.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', 'fixtures', '100075.json');

function sequenceRng(): () => number {
  let state = 0;
  return () => ((state++ * 37) % 101) / 101;
}

describe('single-heavy 最大花色后改色', () => {
  it('随机覆盖完整三元组，并精确收敛到目标花色数', () => {
    const plan = buildSingleHeavyTripletPlan(20, 6, 0.4, sequenceRng());
    assert.equal(plan.colorBySourceTriplet.length, 20);
    assert.equal(new Set(plan.colorBySourceTriplet).size, 6);
    assert.equal(plan.heavyTriplets, 8);
    assert.equal(plan.colorTripletCounts[plan.heavyColor - 1], 8);
    assert.equal(plan.colorTripletCounts.reduce((sum, count) => sum + count, 0), 20);
    assert.ok(plan.colorTripletCounts.every(count => count >= 1));
  });

  it('比例过高时优先保留目标花色数，并取可行的最高单色比例', () => {
    const plan = buildSingleHeavyTripletPlan(10, 4, 0.9, sequenceRng());
    assert.equal(plan.requestedHeavyTriplets, 9);
    assert.equal(plan.heavyTriplets, 7);
    assert.equal(new Set(plan.colorBySourceTriplet).size, 4);
  });

  it('非主色按全局三元组逐组随机替换，不再均匀摊配', () => {
    const plan = buildSingleHeavyTripletPlan(20, 6, 0.4, () => 0);
    const sorted = [...plan.colorTripletCounts].sort((a, b) => b - a);
    assert.deepEqual(sorted, [8, 8, 1, 1, 1, 1]);
  });

  it('LayerClosure 最终花色数、主色比例和三倍数约束都命中', () => {
    const terrain = loadTerrainFromFile(FIXTURE);
    const freeTileCount = getAllTiles(terrain).filter(tile => !tile.isConst).length;
    const depthCount = buildGenerationLogicalLayers(terrain).layers.length;
    const targetCloseRates = Array.from({ length: Math.max(0, depthCount - 1) }, (_, index) => (
      (index + 1) / depthCount
    ));
    const result = runLayerClosureGen({
      terrain,
      colorCount: 8,
      colorAllocationMode: 'single-heavy',
      colorAllocationMaxRatio: 0.4,
      closeRates: targetCloseRates,
      dock: 7,
      rng: sequenceRng(),
    });
    const counts = new Map<number, number>();
    for (const color of result.assignments.values()) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    const totalTriplets = freeTileCount / 3;
    assert.equal(counts.size, 8);
    assert.ok([...counts.values()].every(count => count % 3 === 0));
    assert.equal(result.metrics.colorTripletCounts?.reduce((sum, count) => sum + count, 0), totalTriplets);
    assert.equal(
      result.metrics.colorTripletCounts?.[result.metrics.heavyColor! - 1],
      Math.min(Math.ceil(totalTriplets * 0.4), totalTriplets - 8 + 1),
    );
    assert.equal(result.metrics.singleHeavyRecolorStrategy, 'global-triplet-random');
    assert.equal(result.metrics.singleHeavySourceColorCount, totalTriplets);
    assert.equal(result.metrics.singleHeavyRequestedTriplets, Math.ceil(totalTriplets * 0.4));
    assert.equal(result.metrics.singleHeavyAppliedTriplets, Math.ceil(totalTriplets * 0.4));
    assert.ok(targetCloseRates.some((target, index) => (
      Math.abs((result.metrics.actualCloseRates[index] ?? 0) - target) > 1e-9
    )), '全局随机改色后不应再次强制闭合率命中目标');
  });
});
