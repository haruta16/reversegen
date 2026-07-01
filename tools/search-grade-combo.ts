/**
 * Search a small, interpretable combination of mistake-rate simulation results
 * for ordinal online-win-rate grading.
 *
 * Validation is grouped by terrain id so replays from one terrain never appear
 * in both train and validation folds.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Row {
  terrain: string;
  online: number;
  sims: number[];
}

interface Metrics {
  exact: number;
  withinOne: number;
  severe: number;
  catastrophic: number;
  hardIntoEasy: number;
  easyIntoHard: number;
  gradeMae: number;
  winRateMae: number;
  counts: number[];
  medians: number[];
  confusion: number[][];
}

const input = resolve(process.argv[2] ?? 'output/sim_mistake_sweep.csv');
const lines = readFileSync(input, 'utf8').trim().split(/\r?\n/);
const rows: Row[] = lines.slice(1).map(line => {
  const p = line.split(',');
  return {
    terrain: p[2],
    online: Number(p[3]) / 100,
    sims: p.slice(4, 19).map(v => Number(v) / 100),
  };
});

// Online target bands: 90-100, 60-90, 40-60, 25-40, 20-25,
// 10-20, 5-10, 0-5. Higher grade number means harder.
function onlineGrade(v: number): number {
  if (v >= 0.90) return 0;
  if (v >= 0.60) return 1;
  if (v >= 0.40) return 2;
  if (v >= 0.25) return 3;
  if (v >= 0.20) return 4;
  if (v >= 0.10) return 5;
  if (v >= 0.05) return 6;
  return 7;
}

// Current standard grading thresholds based directly on sim5.
function currentGrade(v: number): number {
  if (v >= 0.90) return 0;
  if (v >= 0.80) return 1;
  if (v >= 0.70) return 2;
  if (v >= 0.50) return 3;
  if (v >= 0.35) return 4;
  if (v >= 0.20) return 5;
  if (v >= 0.10) return 6;
  return 7;
}

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let c = col; c <= n; c++) m[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map(row => row[n]);
}

function fitRidge(train: Row[], features: number[], lambda = 1): {
  beta: number[];
  means: number[];
  stds: number[];
} {
  const means = features.map(j => train.reduce((s, r) => s + r.sims[j], 0) / train.length);
  const stds = features.map((j, k) => {
    const variance = train.reduce((s, r) => s + (r.sims[j] - means[k]) ** 2, 0) / train.length;
    return Math.sqrt(variance) || 1;
  });
  const p = features.length + 1;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  for (const row of train) {
    const x = [1, ...features.map((j, k) => (row.sims[j] - means[k]) / stds[k])];
    for (let i = 0; i < p; i++) {
      xty[i] += x[i] * row.online;
      for (let j = 0; j < p; j++) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < p; i++) xtx[i][i] += lambda;
  return { beta: solveLinear(xtx, xty), means, stds };
}

function predict(row: Row, features: number[], model: ReturnType<typeof fitRidge>): number {
  let y = model.beta[0];
  for (let k = 0; k < features.length; k++) {
    y += model.beta[k + 1] * (row.sims[features[k]] - model.means[k]) / model.stds[k];
  }
  return Math.max(0, Math.min(1, y));
}

const terrains = [...new Set(rows.map(r => r.terrain))].sort();
const foldByTerrain = new Map(terrains.map((t, i) => [t, i % 5]));

function crossValidatedPredictions(features: number[]): number[] {
  const result = Array(rows.length).fill(0);
  for (let fold = 0; fold < 5; fold++) {
    const train = rows.filter(r => foldByTerrain.get(r.terrain) !== fold);
    const model = fitRidge(train, features);
    rows.forEach((row, i) => {
      if (foldByTerrain.get(row.terrain) === fold) result[i] = predict(row, features, model);
    });
  }
  return result;
}

function nearestGrade(value: number, centers: number[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let grade = 0; grade < centers.length; grade++) {
    const distance = Math.abs(value - centers[grade]);
    if (distance < bestDistance) {
      best = grade;
      bestDistance = distance;
    }
  }
  return best;
}

function crossValidatedOrdinal(features: number[]): { rates: number[]; grades: number[] } {
  const rates = Array(rows.length).fill(0);
  const grades = Array(rows.length).fill(0);
  for (let fold = 0; fold < 5; fold++) {
    const train = rows.filter(r => foldByTerrain.get(r.terrain) !== fold);
    const model = fitRidge(train, features);
    const centerValues = Array.from({ length: 8 }, () => [] as number[]);
    for (const row of train) centerValues[onlineGrade(row.online)].push(predict(row, features, model));
    const centers = centerValues.map(values => values.reduce((s, v) => s + v, 0) / values.length);
    // Sampling noise can make adjacent rare classes slightly non-monotonic.
    for (let grade = 1; grade < 8; grade++) {
      centers[grade] = Math.min(centers[grade], centers[grade - 1] - 1e-6);
    }
    rows.forEach((row, i) => {
      if (foldByTerrain.get(row.terrain) !== fold) return;
      rates[i] = predict(row, features, model);
      grades[i] = nearestGrade(rates[i], centers);
    });
  }
  return { rates, grades };
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function evaluate(predictedRates: number[], directGrades?: number[]): Metrics {
  const confusion = Array.from({ length: 8 }, () => Array(8).fill(0));
  const actualByPred = Array.from({ length: 8 }, () => [] as number[]);
  let exact = 0, withinOne = 0, severe = 0, catastrophic = 0, hardIntoEasy = 0, easyIntoHard = 0, gradeError = 0, rateError = 0;
  rows.forEach((row, i) => {
    const actual = onlineGrade(row.online);
    const predicted = directGrades ? directGrades[i] : onlineGrade(predictedRates[i]);
    const diff = Math.abs(predicted - actual);
    confusion[actual][predicted]++;
    actualByPred[predicted].push(row.online);
    if (diff === 0) exact++;
    if (diff <= 1) withinOne++;
    if (diff >= 2) severe++;
    if (diff >= 3) catastrophic++;
    if (predicted <= 2 && row.online < 0.20) hardIntoEasy++;
    if (predicted >= 5 && row.online >= 0.60) easyIntoHard++;
    gradeError += diff;
    rateError += Math.abs(predictedRates[i] - row.online);
  });
  return {
    exact: exact / rows.length,
    withinOne: withinOne / rows.length,
    severe: severe / rows.length,
    catastrophic: catastrophic / rows.length,
    hardIntoEasy,
    easyIntoHard,
    gradeMae: gradeError / rows.length,
    winRateMae: rateError / rows.length,
    counts: actualByPred.map(a => a.length),
    medians: actualByPred.map(a => median(a)),
    confusion,
  };
}

function score(m: Metrics): number {
  // Severe crossing is primary; large crossings and general ordinal error break ties.
  return m.severe + 0.75 * m.catastrophic + 0.08 * m.gradeMae;
}

const candidates: { features: number[]; metrics: Metrics; predictions: number[] }[] = [];
const ordinalCandidates: { features: number[]; metrics: Metrics; predictions: number[]; grades: number[] }[] = [];
for (let size = 1; size <= 3; size++) {
  const visit = (start: number, selected: number[]) => {
    if (selected.length === size) {
      const predictions = crossValidatedPredictions(selected);
      candidates.push({ features: [...selected], metrics: evaluate(predictions), predictions });
      const ordinal = crossValidatedOrdinal(selected);
      ordinalCandidates.push({
        features: [...selected],
        metrics: evaluate(ordinal.rates, ordinal.grades),
        predictions: ordinal.rates,
        grades: ordinal.grades,
      });
      return;
    }
    for (let i = start; i < 15; i++) visit(i + 1, [...selected, i]);
  };
  visit(0, []);
}
candidates.sort((a, b) => score(a.metrics) - score(b.metrics));
ordinalCandidates.sort((a, b) => score(a.metrics) - score(b.metrics));

const baselineRates = rows.map(r => r.sims[4]);
const baseline = evaluate(baselineRates, rows.map(r => currentGrade(r.sims[4])));
const calibrated5 = candidates.find(c => c.features.length === 1 && c.features[0] === 4)!;
const best = candidates[0];
const bestOrdinal = ordinalCandidates[0];
const fullModel = fitRidge(rows, best.features);
const rawCoefficients = best.features.map((feature, i) => fullModel.beta[i + 1] / fullModel.stds[i]);
const intercept = fullModel.beta[0] - rawCoefficients.reduce((s, b, i) => s + b * fullModel.means[i], 0);

interface BlendCandidate {
  rates: number[];
  weights: number[];
  metrics: Metrics;
}

const blends: BlendCandidate[] = [];
function addBlend(rateIndexes: number[], weights: number[]): void {
  const values = rows.map(row => rateIndexes.reduce((s, rate, i) => s + row.sims[rate] * weights[i], 0));
  blends.push({ rates: rateIndexes, weights, metrics: evaluate(values, values.map(currentGrade)) });
}
for (let a = 0; a < 15; a++) addBlend([a], [1]);
for (let a = 0; a < 15; a++) {
  for (let b = a + 1; b < 15; b++) {
    for (let wa = 1; wa <= 9; wa++) addBlend([a, b], [wa / 10, 1 - wa / 10]);
  }
}
function blendScore(m: Metrics): number {
  const coarseCross = (m.hardIntoEasy + m.easyIntoHard) / rows.length;
  return 4 * coarseCross + m.catastrophic + 0.08 * m.gradeMae;
}
blends.sort((a, b) => blendScore(a.metrics) - blendScore(b.metrics));
const bestBlend = blends[0];
const baselineCross = baseline.hardIntoEasy + baseline.easyIntoHard;
const balancedBlend = [...blends]
  .filter(c => c.metrics.hardIntoEasy + c.metrics.easyIntoHard <= baselineCross)
  .sort((a, b) => {
    const sa = a.metrics.severe + a.metrics.catastrophic + 0.08 * a.metrics.gradeMae;
    const sb = b.metrics.severe + b.metrics.catastrophic + 0.08 * b.metrics.gradeMae;
    return sa - sb;
  })[0];

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function printMetrics(label: string, m: Metrics): void {
  console.log(`${label}\texact=${pct(m.exact)}\twithin1=${pct(m.withinOne)}\tsevere=${pct(m.severe)}\tcatastrophic=${pct(m.catastrophic)}\thard->easy=${m.hardIntoEasy}\teasy->hard=${m.easyIntoHard}\tgradeMAE=${m.gradeMae.toFixed(3)}\twinMAE=${pct(m.winRateMae)}`);
}

console.log(`rows=${rows.length}, terrains=${terrains.length}`);
printMetrics('current-sim5', baseline);
printMetrics('calibrated-sim5', calibrated5.metrics);
printMetrics(`best-[${best.features.map(i => `${i + 1}%`).join(',')}]`, best.metrics);
printMetrics(`best-ordinal-[${bestOrdinal.features.map(i => `${i + 1}%`).join(',')}]`, bestOrdinal.metrics);
printMetrics(`best-direct-blend-[${bestBlend.rates.map((r, i) => `${(bestBlend.weights[i] * 100).toFixed(0)}%*sim${r + 1}`).join('+')}]`, bestBlend.metrics);
console.log(`best-direct-counts: ${bestBlend.metrics.counts.join(',')}`);
console.log(`best-direct-medians: ${bestBlend.metrics.medians.map(v => Number.isNaN(v) ? '-' : pct(v)).join(',')}`);
printMetrics(`balanced-blend-[${balancedBlend.rates.map((r, i) => `${(balancedBlend.weights[i] * 100).toFixed(0)}%*sim${r + 1}`).join('+')}]`, balancedBlend.metrics);
console.log(`balanced-counts: ${balancedBlend.metrics.counts.join(',')}`);
console.log(`balanced-medians: ${balancedBlend.metrics.medians.map(v => Number.isNaN(v) ? '-' : pct(v)).join(',')}`);
for (const tolerance of [0, 1, 2]) {
  const selectedIndexes: number[] = [];
  const selectedGrades: number[] = [];
  const selectedRates: number[] = [];
  rows.forEach((row, i) => {
    const baseGrade = currentGrade(row.sims[4]);
    const riskRate = 0.6 * row.sims[0] + 0.4 * row.sims[13];
    const riskGrade = currentGrade(riskRate);
    if (Math.abs(baseGrade - riskGrade) <= tolerance) {
      selectedIndexes.push(i);
      selectedGrades.push(baseGrade);
      selectedRates.push(row.sims[4]);
    }
  });
  const originalRows = [...rows];
  const selectedRows = selectedIndexes.map(i => originalRows[i]);
  rows.splice(0, rows.length, ...selectedRows);
  const m = evaluate(selectedRates, selectedGrades);
  rows.splice(0, rows.length, ...originalRows);
  console.log(`sim5+risk-veto tolerance=${tolerance}\tcoverage=${pct(selectedRows.length / originalRows.length)}\tsevere=${pct(m.severe)}\tcat=${pct(m.catastrophic)}\tcross=${m.hardIntoEasy + m.easyIntoHard}\texact=${pct(m.exact)}\tcounts=${m.counts.join('/')}`);
}
{
  const originalRows = [...rows];
  const selectedRows: Row[] = [];
  const selectedRates: number[] = [];
  const selectedGrades: number[] = [];
  for (const row of originalRows) {
    const baseGrade = currentGrade(row.sims[4]);
    const riskGrade = currentGrade(0.6 * row.sims[0] + 0.4 * row.sims[13]);
    const consistent = (baseGrade <= 2 && riskGrade <= 2)
      || (baseGrade >= 5 && riskGrade >= 5)
      || (baseGrade >= 3 && baseGrade <= 4);
    if (!consistent) continue;
    selectedRows.push(row);
    selectedRates.push(row.sims[4]);
    selectedGrades.push(baseGrade);
  }
  rows.splice(0, rows.length, ...selectedRows);
  const m = evaluate(selectedRates, selectedGrades);
  rows.splice(0, rows.length, ...originalRows);
  console.log(`sim5+risk-extreme-gate\tcoverage=${pct(selectedRows.length / originalRows.length)}\tsevere=${pct(m.severe)}\tcat=${pct(m.catastrophic)}\tcross=${m.hardIntoEasy + m.easyIntoHard}\texact=${pct(m.exact)}\tcounts=${m.counts.join('/')}`);
}
console.log(`formula: online ~= ${intercept.toFixed(4)} ${rawCoefficients.map((b, i) => `${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(4)}*sim${best.features[i] + 1}`).join(' ')}`);
console.log(`counts: ${best.metrics.counts.join(',')}`);
console.log(`medians: ${best.metrics.medians.map(v => Number.isNaN(v) ? '-' : pct(v)).join(',')}`);
console.log('top candidates:');
for (const c of candidates.slice(0, 15)) {
  console.log(`${c.features.map(i => `${i + 1}%`).join('+')}\tsevere=${pct(c.metrics.severe)}\tcat=${pct(c.metrics.catastrophic)}\tgradeMAE=${c.metrics.gradeMae.toFixed(3)}\twinMAE=${pct(c.metrics.winRateMae)}`);
}
console.log('top ordinal candidates:');
for (const c of ordinalCandidates.slice(0, 10)) {
  console.log(`${c.features.map(i => `${i + 1}%`).join('+')}\tsevere=${pct(c.metrics.severe)}\tcat=${pct(c.metrics.catastrophic)}\tgradeMAE=${c.metrics.gradeMae.toFixed(3)}\twinMAE=${pct(c.metrics.winRateMae)}\tcounts=${c.metrics.counts.join('/')}`);
}
console.log('top direct blends:');
for (const c of blends.slice(0, 10)) {
  console.log(`${c.rates.map((r, i) => `${(c.weights[i] * 100).toFixed(0)}%*sim${r + 1}`).join('+')}\tcross=${c.metrics.hardIntoEasy + c.metrics.easyIntoHard}\tsevere=${pct(c.metrics.severe)}\tcat=${pct(c.metrics.catastrophic)}\tgradeMAE=${c.metrics.gradeMae.toFixed(3)}\tcounts=${c.metrics.counts.join('/')}`);
}
interface ConsensusCandidate {
  rates: number[];
  maxSpread: number;
  coverage: number;
  severe: number;
  catastrophic: number;
  coarseCross: number;
  exact: number;
  counts: number[];
  medians: number[];
}
const consensus: ConsensusCandidate[] = [];
for (let a = 0; a < 15; a++) {
  for (let b = a + 1; b < 15; b++) {
    for (let c = b + 1; c < 15; c++) {
      for (const maxSpread of [0, 1, 2]) {
        const selected: { predicted: number; row: Row }[] = [];
        for (const row of rows) {
          const grades = [a, b, c].map(rate => currentGrade(row.sims[rate])).sort((x, y) => x - y);
          if (grades[2] - grades[0] <= maxSpread) selected.push({ predicted: grades[1], row });
        }
        let severe = 0, catastrophic = 0, coarseCross = 0, exact = 0;
        const actualByPred = Array.from({ length: 8 }, () => [] as number[]);
        for (const item of selected) {
          const actual = onlineGrade(item.row.online);
          const diff = Math.abs(item.predicted - actual);
          if (diff === 0) exact++;
          if (diff >= 2) severe++;
          if (diff >= 3) catastrophic++;
          if (item.predicted <= 2 && item.row.online < 0.20) coarseCross++;
          if (item.predicted >= 5 && item.row.online >= 0.60) coarseCross++;
          actualByPred[item.predicted].push(item.row.online);
        }
        consensus.push({
          rates: [a, b, c], maxSpread,
          coverage: selected.length / rows.length,
          severe: selected.length ? severe / selected.length : 1,
          catastrophic: selected.length ? catastrophic / selected.length : 1,
          coarseCross,
          exact: selected.length ? exact / selected.length : 0,
          counts: actualByPred.map(v => v.length),
          medians: actualByPred.map(median),
        });
      }
    }
  }
}
const viableConsensus = consensus
  .filter(c => c.coarseCross <= 10 && c.severe <= 0.35 && c.coverage >= 0.10)
  .sort((a, b) => b.coverage - a.coverage || a.severe - b.severe);
console.log('top consensus candidates (coarse cross <=10, severe <=35%):');
for (const c of viableConsensus.slice(0, 10)) {
  console.log(`${c.rates.map(r => `${r + 1}%`).join('+')} spread<=${c.maxSpread}\tcoverage=${pct(c.coverage)}\tsevere=${pct(c.severe)}\tcat=${pct(c.catastrophic)}\tcross=${c.coarseCross}\texact=${pct(c.exact)}\tcounts=${c.counts.join('/')}\tmedians=${c.medians.map(v => Number.isNaN(v) ? '-' : pct(v)).join('/')}`);
}
console.log('confusion actual(rows) x predicted(cols):');
console.log(bestOrdinal.metrics.confusion.map((r, i) => `${i}: ${r.join(',')}`).join('\n'));
