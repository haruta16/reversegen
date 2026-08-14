import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTerrainFromJson, getAllTiles } from '../../src/terrain-loader.js';
import {
  mechanicInfo,
  MECHANICS,
  MAGIC_BOTTLE_TARGET_WHITELIST,
  isKnownMechanic,
  parseMechanicCounts,
  serializeMechanicCounts,
  countTerrainExtras,
  validateMechanicCounts,
  splitMechanicConfig,
  formatBoardSpec,
  parseBoardSpec,
} from '../../src/index.js';

test('registry 与 Unity ssExtraEnum 数值对齐', () => {
  // 关键机制数值（对应 ssExtraEnum.cs）
  assert.equal(MECHANICS[-1]?.name, 'None');
  assert.equal(MECHANICS[0]?.name, 'Empty');
  assert.equal(MECHANICS[1]?.name, 'Ice');
  assert.equal(MECHANICS[2]?.name, 'Unknown');
  assert.equal(MECHANICS[3]?.name, 'Linked');
  assert.equal(MECHANICS[8]?.name, 'EasterExtra');
  assert.equal(MECHANICS[31]?.name, 'MagicBottleExtra');
  assert.equal(MECHANICS[39]?.name, 'BubbleExtra');
  assert.equal(MECHANICS[51]?.name, 'LargeTerrainExtra');
  assert.equal(MECHANICS[52]?.name, 'LargeTerrainOrderExtra');
  assert.equal(MECHANICS[53]?.name, 'LargeTerrainTicketExtra');
  assert.equal(MECHANICS[202]?.name, 'Unknown_Interval');
  assert.equal(MECHANICS[203]?.name, 'Unknown_BottomFirst');
  assert.equal(MECHANICS[207]?.name, 'FlipExtra_Layer');
});

test('魔药语义常量与 Unity 对齐', () => {
  const bottle = mechanicInfo(31)!;
  assert.equal(bottle.fixedElementValue, 1301);
  assert.equal(bottle.countMeaning, 'tile-count');
  assert.equal(bottle.kind, 'tile');
  assert.equal(bottle.constants?.TARGET_GROUP_COUNT, 6);
  assert.equal(bottle.constants?.TILES_PER_GROUP, 3);
  // 白名单：Ice(1)/Linked(3) 在 Unity 侧被注释排除
  assert.ok(MAGIC_BOTTLE_TARGET_WHITELIST.includes(-1));
  assert.ok(MAGIC_BOTTLE_TARGET_WHITELIST.includes(0));
  assert.ok(MAGIC_BOTTLE_TARGET_WHITELIST.includes(207));
  assert.ok(!MAGIC_BOTTLE_TARGET_WHITELIST.includes(1));
  assert.ok(!MAGIC_BOTTLE_TARGET_WHITELIST.includes(3));
  assert.ok(!MAGIC_BOTTLE_TARGET_WHITELIST.includes(39));
});

test('泡泡语义常量与 Unity 对齐', () => {
  const bubble = mechanicInfo(39)!;
  assert.equal(bubble.kind, 'both');
  // 泡泡的 extraConfig 计数是行为参数（每轮收集数，0=随机 2-3），不是 tile 数
  assert.equal(bubble.countMeaning, 'behavior-config');
  assert.equal(bubble.constants?.MAX_COLLECT_ROUNDS, 3);
  assert.equal(bubble.constants?.DEFAULT_COLLECT_COUNT, 3);
  assert.equal(bubble.constants?.MAX_COLLECT_COUNT, 4);
  assert.equal(bubble.constants?.MIN_COLLECT_COUNT, 1);
});

test('机制文本解析：数值键 / 枚举名 / 中文名', () => {
  const a = parseMechanicCounts('31:3,39:2');
  assert.equal(a.get(31), 3);
  assert.equal(a.get(39), 2);
  const b = parseMechanicCounts('MagicBottleExtra:3,泡泡挂件:0');
  assert.equal(b.get(31), 3);
  assert.equal(b.get(39), 0);
  assert.throws(() => parseMechanicCounts('999:1'), /未知机制/);
  assert.throws(() => parseMechanicCounts('31:-1'), /整数/);
  assert.throws(() => parseMechanicCounts('31'), /缺少数量/);
  // 序列化可逆
  assert.equal(serializeMechanicCounts(parseMechanicCounts('39:2,31:3')), '31:3,39:2');
  assert.equal(isKnownMechanic(31), true);
  assert.equal(isKnownMechanic(0), false);
  assert.equal(isKnownMechanic(-1), false);
  assert.equal(isKnownMechanic(999), false);
});

test('地形 extras 解析与汇总（来源 1：tile 里写着的）', () => {
  const terrain = loadTerrainFromJson(JSON.stringify({
    layers: [{ tiles: [
      { ID: 1, Layer: 0, Dependencies: [], IsConst: true, ConstElementValue: 1301, extraEnum: 31, extraParam: '' },
      { ID: 2, Layer: 0, Dependencies: [], IsConst: false, extraEnum: 0, extraParam: '' },
      { ID: 3, Layer: 0, Dependencies: [], IsConst: false, extraEnum: 39, extraParam: '3' },
      { ID: 4, Layer: 1, Dependencies: [1], IsConst: false }, // 缺省 = Empty
    ] }],
  }));
  const tiles = getAllTiles(terrain);
  assert.equal(tiles[0].extraEnum, 31);
  assert.equal(tiles[0].extraParam, '');
  assert.equal(tiles[1].extraEnum, 0);
  assert.equal(tiles[3].extraEnum, 0, '缺省挂件应归一化为 Empty(0)');
  const counts = countTerrainExtras(tiles);
  assert.equal(counts.get(31), 1);
  assert.equal(counts.get(39), 1);
  assert.equal(counts.has(0), false);
  assert.equal(counts.has(-1), false);
});

test('机制配置校验（对齐 Unity：extraConfig 是分配请求，只校验未知枚举）', () => {
  // 未知枚举（parse 层已拦文本，这里覆盖直接构造 Map 的路径）→ 错误
  const bad = validateMechanicCounts(new Map([[999, 1]]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.kind, 'unknown-enum');
  // 数量语义交由分配器解释：负数量/与地形不一致不再报错（202/207 自动数量，其余自然选不到）
  assert.deepEqual(validateMechanicCounts(parseMechanicCounts('31:3,39:2')), []);
  assert.deepEqual(validateMechanicCounts(new Map([[31, -1]])), []);
  assert.deepEqual(validateMechanicCounts(new Map([[31, 5]])), []);
  assert.deepEqual(validateMechanicCounts(new Map([[39, 0]])), []);
});

test('机制配置拆分（对齐 Unity LoadLevel：泡泡/大型地形拆出）', () => {
  const split = splitMechanicConfig(parseMechanicCounts('31:3,39:2,52:1'));
  assert.deepEqual([...split.assignable.entries()], [[31, 3]]);
  assert.deepEqual([...split.bubble.entries()], [[39, 2]]);
  assert.deepEqual([...split.boardSpecial.entries()], [[52, 1]]);
  // 空配置：全空
  const empty = splitMechanicConfig(new Map());
  assert.equal(empty.assignable.size + empty.bubble.size + empty.boardSpecial.size, 0);
});

test('一关组合表示：ReplayCode@机制（格式不变，机制并列）', () => {
  const spec = { replayCode: 'RcrBDYAwDENRO7HThvkYhP0v0CIkfHz', mechanics: parseMechanicCounts('31:3,39:2') };
  const text = formatBoardSpec(spec);
  assert.equal(text, 'RcrBDYAwDENRO7HThvkYhP0v0CIkfHz@31:3,39:2');
  const back = parseBoardSpec(text);
  assert.equal(back.replayCode, spec.replayCode);
  assert.equal(back.mechanics.get(31), 3);
  assert.equal(back.mechanics.get(39), 2);
  // 无机制时就是 ReplayCode 本身
  const plain = parseBoardSpec('RcrBDYAwDENRO7HThvkYhP0v0CIkfHz');
  assert.equal(plain.replayCode, 'RcrBDYAwDENRO7HThvkYhP0v0CIkfHz');
  assert.equal(plain.mechanics.size, 0);
});
