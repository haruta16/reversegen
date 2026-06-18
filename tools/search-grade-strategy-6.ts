/** Search low-coverage, high-confidence six-tier grading rules. */
import { readFileSync } from 'node:fs';

interface Row { terrain: string; online: number; s1: number; s5: number; s15: number; decay: number }
interface Rule { grade: number; text: string; match: (row: Row) => boolean }
interface Stats {
  count: number; exact: number; adjacent: number; cross: number; far: number;
  median: number; p25: number; p75: number;
}

const lines = readFileSync(process.argv[2] ?? 'output/sim_mistake_sweep.csv', 'utf8').trim().split(/\r?\n/);
const rows: Row[] = lines.slice(1).map(line => {
  const p = line.split(',');
  const s1 = Number(p[4]) / 100, s5 = Number(p[8]) / 100, s15 = Number(p[18]) / 100;
  return { terrain: p[2], online: Number(p[3]) / 100, s1, s5, s15, decay: s1 - s15 };
});

const bands: [number, number][] = [[.9, 1.001], [.6, .9], [.4, .6], [.2, .4], [.1, .2], [0, .1]];
function grade(v: number): number {
  return bands.findIndex(([lo, hi]) => v >= lo && v < hi);
}
function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
function stats(rule: Rule, data: Row[]): Stats {
  const selected = data.filter(rule.match);
  let exact = 0, adjacent = 0, cross = 0, far = 0;
  for (const row of selected) {
    const d = Math.abs(grade(row.online) - rule.grade);
    if (d === 0) exact++;
    if (d <= 1) adjacent++;
    if (d >= 2) cross++;
    if (d >= 3) far++;
  }
  const values = selected.map(r => r.online);
  return { count: selected.length, exact, adjacent, cross, far,
    median: quantile(values, .5), p25: quantile(values, .25), p75: quantile(values, .75) };
}

const grid = Array.from({ length: 21 }, (_, i) => i * .05);
function rulesFor(target: number): Rule[] {
  const rules: Rule[] = [];
  if (target === 0) {
    for (const a of grid.slice(12)) for (const b of grid) rules.push({ grade: target,
      text: `sim5>=${a.toFixed(2)} & sim15>=${b.toFixed(2)}`,
      match: r => r.s5 >= a && r.s15 >= b });
  } else if (target === 1) {
    for (const lo of grid) for (const hi of grid.filter(v => v > lo && v - lo <= .35)) for (const floor of grid) rules.push({ grade: target,
      text: `${lo.toFixed(2)}<=sim5<${hi.toFixed(2)} & sim15>=${floor.toFixed(2)}`,
      match: r => r.s5 >= lo && r.s5 < hi && r.s15 >= floor });
  } else if (target === 2 || target === 3) {
    for (const lo of grid) for (const hi of grid.filter(v => v > lo && v - lo <= .30)) for (const cap of grid) rules.push({ grade: target,
      text: `${lo.toFixed(2)}<=sim5<${hi.toFixed(2)} & decay<=${cap.toFixed(2)}`,
      match: r => r.s5 >= lo && r.s5 < hi && r.decay <= cap });
  } else if (target === 4) {
    for (const lo of grid) for (const hi of grid.filter(v => v > lo && v - lo <= .20)) for (const cap of grid) rules.push({ grade: target,
      text: `${lo.toFixed(2)}<=sim5<${hi.toFixed(2)} & sim1<=${cap.toFixed(2)}`,
      match: r => r.s5 >= lo && r.s5 < hi && r.s1 <= cap });
  } else {
    for (const a of grid) for (const b of grid) rules.push({ grade: target,
      text: `sim5<=${a.toFixed(2)} & sim1<=${b.toFixed(2)}`,
      match: r => r.s5 <= a && r.s1 <= b });
  }
  return rules;
}

// Harder certified labels tolerate progressively less crossing.
const maxCross = [.20, .15, .12, .08, .05, .02];
const minTrainCount = [3, 30, 30, 30, 20, 15];
function chooseRule(target: number, train: Row[]): { rule: Rule; trainStats: Stats } | null {
  let best: { rule: Rule; trainStats: Stats } | null = null;
  const [bandLo, bandHi] = bands[target];
  for (const rule of rulesFor(target)) {
    const s = stats(rule, train);
    if (s.count < minTrainCount[target]) continue;
    if (s.cross / s.count > maxCross[target]) continue;
    if (!(s.median >= bandLo && s.median < bandHi)) continue;
    if (!best || s.count > best.trainStats.count ||
      (s.count === best.trainStats.count && s.exact / s.count > best.trainStats.exact / best.trainStats.count)) {
      best = { rule, trainStats: s };
    }
  }
  return best;
}

const terrains = [...new Set(rows.map(r => r.terrain))].sort();
const foldByTerrain = new Map(terrains.map((t, i) => [t, i % 5]));
const aggregate = Array.from({ length: 6 }, () => ({ count: 0, exact: 0, adjacent: 0, cross: 0, far: 0, rules: [] as string[] }));
for (let fold = 0; fold < 5; fold++) {
  const train = rows.filter(r => foldByTerrain.get(r.terrain) !== fold);
  const test = rows.filter(r => foldByTerrain.get(r.terrain) === fold);
  for (let target = 0; target < 6; target++) {
    const chosen = chooseRule(target, train);
    if (!chosen) continue;
    const s = stats(chosen.rule, test);
    const a = aggregate[target];
    a.count += s.count; a.exact += s.exact; a.adjacent += s.adjacent; a.cross += s.cross; a.far += s.far;
    a.rules.push(chosen.rule.text);
  }
}

const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : '-';
console.log(`rows=${rows.length}, terrains=${terrains.length}`);
console.log('cross-validated certification:');
for (let target = 0; target < 6; target++) {
  const a = aggregate[target];
  console.log(`grade${target}\tn=${a.count}\texact=${pct(a.exact, a.count)}\twithin1=${pct(a.adjacent, a.count)}\tcross=${pct(a.cross, a.count)}\tfar=${pct(a.far, a.count)}\trules=${[...new Set(a.rules)].join(' | ')}`);
}
console.log('final full-data rules:');
const finalRules: (Rule | null)[] = [];
for (let target = 0; target < 6; target++) {
  const chosen = chooseRule(target, rows);
  finalRules[target] = chosen?.rule ?? null;
  if (!chosen) { console.log(`grade${target}\tNO FEASIBLE RULE`); continue; }
  const s = chosen.trainStats;
  console.log(`grade${target}\t${chosen.rule.text}\tn=${s.count}\texact=${pct(s.exact,s.count)}\twithin1=${pct(s.adjacent,s.count)}\tcross=${pct(s.cross,s.count)}\tfar=${pct(s.far,s.count)}\tP25/P50/P75=${pct(s.p25,1)}/${pct(s.median,1)}/${pct(s.p75,1)}`);
}

// Resolve overlaps conservatively: the harder matching grade wins.
const assigned = Array.from({ length: 6 }, () => [] as Row[]);
let unassigned = 0;
for (const row of rows) {
  let found = false;
  for (let target = 5; target >= 0; target--) {
    const rule = finalRules[target];
    if (rule?.match(row)) { assigned[target].push(row); found = true; break; }
  }
  if (!found) unassigned++;
}
console.log(`mutually-exclusive harder-first assignment: coverage=${pct(rows.length - unassigned, rows.length)}, unassigned=${unassigned}`);
for (let target = 0; target < 6; target++) {
  const rule: Rule = { grade: target, text: 'resolved', match: row => assigned[target].includes(row) };
  const s = stats(rule, rows);
  console.log(`grade${target}\tn=${s.count}\texact=${pct(s.exact,s.count)}\twithin1=${pct(s.adjacent,s.count)}\tcross=${pct(s.cross,s.count)}\tfar=${pct(s.far,s.count)}\tP25/P50/P75=${pct(s.p25,1)}/${pct(s.median,1)}/${pct(s.p75,1)}`);
}

// Refit sequentially on the remaining pool, so every final rule's quality is
// measured after harder grades have already claimed their safest candidates.
let remaining = [...rows];
const sequential: { target: number; rule: Rule; selected: Row[]; s: Stats }[] = [];
for (let target = 5; target >= 0; target--) {
  const chosen = chooseRule(target, remaining);
  if (!chosen) continue;
  const selected = remaining.filter(chosen.rule.match);
  const selectedSet = new Set(selected);
  sequential.push({ target, rule: chosen.rule, selected, s: stats(chosen.rule, remaining) });
  remaining = remaining.filter(row => !selectedSet.has(row));
}
console.log(`sequential conservative rules: coverage=${pct(rows.length - remaining.length, rows.length)}, unassigned=${remaining.length}`);
for (const item of [...sequential].sort((a,b) => a.target - b.target)) {
  const s = item.s;
  console.log(`grade${item.target}\t${item.rule.text}\tn=${s.count}\texact=${pct(s.exact,s.count)}\twithin1=${pct(s.adjacent,s.count)}\tcross=${pct(s.cross,s.count)}\tfar=${pct(s.far,s.count)}\tP25/P50/P75=${pct(s.p25,1)}/${pct(s.median,1)}/${pct(s.p75,1)}`);
}

const stableRules: Rule[] = [
  { grade: 1, text: '0.65<=sim5<1.00 & sim15>=0.45', match: r => r.s5 >= .65 && r.s5 < 1 && r.s15 >= .45 },
  { grade: 2, text: '0.45<=sim5<0.70 & decay<=0.60', match: r => r.s5 >= .45 && r.s5 < .70 && r.decay <= .60 },
  { grade: 3, text: '0.10<=sim5<0.35 & decay<=0.50', match: r => r.s5 >= .10 && r.s5 < .35 && r.decay <= .50 },
  { grade: 4, text: 'sim5<0.15 & sim1<=0.50', match: r => r.s5 < .15 && r.s1 <= .50 },
  { grade: 5, text: 'sim5<=0.05 & sim1<=0.10', match: r => r.s5 <= .05 && r.s1 <= .10 },
];
const stableAssigned = Array.from({ length: 6 }, () => [] as Row[]);
let stableUnassigned = 0;
for (const row of rows) {
  const matched = [...stableRules].sort((a,b) => b.grade - a.grade).find(rule => rule.match(row));
  if (matched) stableAssigned[matched.grade].push(row); else stableUnassigned++;
}
console.log(`stable rounded proposal: coverage=${pct(rows.length-stableUnassigned,rows.length)}, unassigned=${stableUnassigned}`);
for (const rule of stableRules) {
  const selectedSet = new Set(stableAssigned[rule.grade]);
  const resolved: Rule = { ...rule, match: row => selectedSet.has(row) };
  const s = stats(resolved, rows);
  console.log(`grade${rule.grade}\t${rule.text}\tn=${s.count}\texact=${pct(s.exact,s.count)}\twithin1=${pct(s.adjacent,s.count)}\tcross=${pct(s.cross,s.count)}\tfar=${pct(s.far,s.count)}\tP25/P50/P75=${pct(s.p25,1)}/${pct(s.median,1)}/${pct(s.p75,1)}`);
}
