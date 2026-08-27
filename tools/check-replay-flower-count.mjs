/**
 * check-replay-flower-count.mjs
 *
 * 检查全部 ReplayCode 是否存在「花色(元素)的 tile 数不是 3 的倍数」的情况。
 *
 * ReplayCode v4 格式: base64( raw-deflate( 二进制 ) )
 *   二进制: version(1B) | N(1B) | elementCount(1B) | levelHash(8B LE)
 *          | instanceArray(N×1B: 2bit状态 | 6bit花色索引)
 *          | dockCount(1B) | dockEntries(cnt×2B) | CRC16(2B LE)
 *
 * 对每个 code: 统计每种花色(6bit 索引)在全部状态(场上/已消除/手牌/保留)中的 tile 数,
 *   任一花色计数 % 3 != 0 即视为违规。
 *
 * 用法: node tools/check-replay-flower-count.mjs [--json-out <path>]
 *   数据根目录缺省 = ../../TileMatchShell/Tools/Config/Json (相对本脚本)
 */
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT =
  process.env.REPLAY_JSON_ROOT ??
  path.resolve(__dirname, '../../TileMatchShell/Tools/Config/Json');

const DIRS = ['Replay_All', 'Replay_C', 'Replay_F', 'Replays', 'Replays_B', 'Replays_D'];
const STATE_NAMES = ['OnField', 'Eliminated', 'InDock', 'Reserved'];

/** 解码 ReplayCode → { n, elementCount, levelHash, instanceArray, dockEntries } */
function decodeReplayCode(code) {
  const bin = inflateRawSync(Buffer.from(code.trim(), 'base64'));
  if (bin.length < 15) return { error: `binary too short (${bin.length}B)` };
  let o = 0;
  const version = bin[o++];
  const n = bin[o++];
  const elementCount = bin[o++];
  const levelHash = bin.slice(o, o + 8); o += 8;
  const instanceArray = bin.slice(o, o + n); o += n;
  const dockCount = bin[o++];
  const dockEntries = [];
  for (let i = 0; i < dockCount; i++) {
    dockEntries.push({ tileId: bin[o++], element: bin[o++] });
  }
  return { version, n, elementCount, levelHash, instanceArray, dockEntries };
}

function analyze(code) {
  const dec = decodeReplayCode(code);
  if (dec.error) return { error: dec.error };
  const { n, elementCount, instanceArray, dockEntries } = dec;

  // 每花色 → 各状态计数
  const perElem = new Map();   // elem -> [state0..state3]
  const stateTotals = [0, 0, 0, 0];
  for (const b of instanceArray) {
    const state = (b >> 6) & 0x3;
    const elem = b & 0x3f;
    if (!perElem.has(elem)) perElem.set(elem, [0, 0, 0, 0]);
    perElem.get(elem)[state]++;
    stateTotals[state]++;
  }

  // 每花色总计数（全部状态）→ 违规检测
  const elemTotals = [];
  let violations = [];
  for (const [elem, states] of perElem) {
    const total = states.reduce((a, b) => a + b, 0);
    elemTotals.push({ elem, total, states: [...states] });
    if (total % 3 !== 0) violations.push({ elem, total });
  }
  elemTotals.sort((a, b) => a.elem - b.elem);

  return {
    n, elementCount,
    stateTotals,
    elemTotals,
    violations,
    dockEntries,
  };
}

const files = [];
for (const d of DIRS) {
  const abs = path.join(DATA_ROOT, d);
  if (!fs.existsSync(abs)) { console.warn(`[skip] missing dir: ${abs}`); continue; }
  for (const f of fs.readdirSync(abs)) {
    if (f.endsWith('.json')) files.push({ dir: d, file: f, abs: path.join(abs, f) });
  }
}

let totalCodes = 0, totalFiles = 0, badCodes = 0, badFiles = 0, decodeFail = 0;
const badList = [];
const fileSummary = [];
const decodedStats = { minN: Infinity, maxN: -1, minEC: Infinity, maxEC: -1 };

for (const { dir, file, abs } of files) {
  totalFiles++;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    fileSummary.push({ dir, file, status: 'JSON_PARSE_ERROR', msg: e.message });
    badFiles++;
    continue;
  }
  const list = json.replayInfoList;
  if (!Array.isArray(list)) {
    fileSummary.push({ dir, file, status: 'NO_LIST', msg: 'replayInfoList missing' });
    badFiles++;
    continue;
  }
  const fileBad = [];
  for (let i = 0; i < list.length; i++) {
    const code = list[i]?.ReplayCode;
    if (typeof code !== 'string' || !code) { decodeFail++; continue; }
    totalCodes++;
    const a = analyze(code);
    if (a.error) {
      decodeFail++;
      fileBad.push({ idx: i, code, err: a.error });
      continue;
    }
    if (a.n < decodedStats.minN) decodedStats.minN = a.n;
    if (a.n > decodedStats.maxN) decodedStats.maxN = a.n;
    if (a.elementCount < decodedStats.minEC) decodedStats.minEC = a.elementCount;
    if (a.elementCount > decodedStats.maxEC) decodedStats.maxEC = a.elementCount;
    if (a.violations.length > 0) {
      badCodes++;
      fileBad.push({
        idx: i,
        code,
        ReplayKey: list[i]?.ReplayKey,
        grade: list[i]?.grade,
        n: a.n,
        elementCount: a.elementCount,
        stateTotals: a.stateTotals,
        violations: a.violations,
        elemTotals: a.elemTotals,
      });
    }
  }
  if (fileBad.length > 0) {
    badFiles++;
    badList.push(...fileBad.map((b) => ({ dir, file, ...b })));
  }
  fileSummary.push({ dir, file, status: 'OK', codes: list.length, bad: fileBad.length });
}

console.log(`\n==== 检查结果 ====`);
console.log(`数据根目录: ${DATA_ROOT}`);
console.log(`JSON 文件数: ${totalFiles}`);
console.log(`ReplayCode 总数: ${totalCodes}  解码失败: ${decodeFail}`);
console.log(`违规 code 数: ${badCodes}  含违规的文件数: ${badFiles}`);
if (decodedStats.minN !== Infinity) {
  console.log(`牌数范围: ${decodedStats.minN}~${decodedStats.maxN}  花色数范围: ${decodedStats.minEC}~${decodedStats.maxEC}`);
}

const byElemBad = new Map();
for (const b of badList) {
  for (const v of b.violations) {
    const k = `${b.file}::elem${v.elem}`;
    byElemBad.set(k, (byElemBad.get(k) ?? 0) + 1);
  }
}

if (badList.length === 0) {
  console.log(`\n✅ 未发现任何「花色 tile 数非 3 倍数」的 ReplayCode。`);
} else {
  console.log(`\n❌ 发现 ${badCodes} 个违规 ReplayCode，明细如下:`);
  for (const b of badList) {
    const violStr = b.violations.map((v) => `花色${v.elem}=${v.total}(%3=${v.total % 3})`).join(', ');
    console.log(`  [${b.dir}/${b.file}] #${b.idx} grade=${b.grade} n=${b.n} ec=${b.elementCount} states=[${b.stateTotals.join(',')}] 违规: ${violStr}`);
    console.log(`      ReplayCode=${b.code}`);
    console.log(`      ReplayKey=${b.ReplayKey}`);
  }
  console.log(`\n按(文件,花色)聚合违规次数:`);
  for (const [k, v] of [...byElemBad.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}x  ${k}`);
  }
}

// 附带: 每个文件的违规 code 数量清单
console.log(`\n==== 各文件违规 code 数 ====`);
for (const s of fileSummary) {
  console.log(`  ${s.dir}/${s.file}: ${s.status} codes=${s.codes ?? '-'} bad=${s.bad ?? '-'}${s.msg ? ` (${s.msg})` : ''}`);
}

const outPath = process.argv.includes('--json-out') ? process.argv[process.argv.indexOf('--json-out') + 1] : null;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    dataRoot: DATA_ROOT,
    totalCodes, decodeFail, badCodes, badFiles,
    badList,
    fileSummary,
  }, null, 2));
  console.log(`\n完整明细已写入: ${outPath}`);
}
