# ReverseGen · 牌局生成器

从 Unity TileMatch 项目中剥离的**独立牌局生成工具**。提供 CostLadder、LayerClosure、
Deadlock+LayerClosure、TileExplorer、ZenMatch 五个平级生成器，统一输出
「牌局花色分配 + ReplayCode 序列化种子」。

与 Unity 零依赖。CLI / Web GUI / TypeScript API 三种使用方式。

---

## 安装

```bash
cd reversegen
npm install
```

依赖仅三个：`typescript`、`tsx`、`@types/node`，无运行时依赖。

---

## 快速开始

### CLI

```bash
# 测试地形（不需要关卡文件）
npx tsx cli/generate.ts --test-terrain --layers 2 --tiles 12

# 真实关卡
npx tsx cli/generate.ts \
  --terrain /path/to/100075.json \
  --cost 4,4,4,3,3,2 --colors 30

# Tile Explorer 策略（view_layers 自动从 Dependencies 计算）
npx tsx cli/generate.ts \
  --terrain /path/to/100075.json --algorithm tile-explorer \
  --te-strategy solvability_coefficient_v2 --difficulty 2 --colors 5 \
  --sequence-seed 123 --placement-seed 456

# Zen Match 静态策略 4/5
npx tsx cli/generate.ts \
  --terrain /path/to/1200001.json --algorithm zen-match \
  --colors 5 --seed 12345 --zen-strategy 5

# Deadlock + LayerClosure：12t3l 最小必死 dagT 前置 + 剩余牌 LayerClosure
npx tsx cli/generate.ts \
  --terrain /path/to/100075.json --algorithm deadlock-layer-closure \
  --close-rates 0.3,0.5,0.8 --colors 10 \
  --deadlock-tiles 12 --deadlock-layers 3 \
  --deadlock-depth-pref deepest --deadlock-density-pref densest

# 仅输出 ReplayCode（可管道）
npx tsx cli/generate.ts -t level.json -c 3,3,2 -k 6 -q | pbcopy

# 查看帮助
npx tsx cli/generate.ts --help
```

### Web GUI

```bash
npm run gui
# 本机访问 → http://localhost:3000
# 启动日志会按物理网卡和虚拟网卡分组列出地址

# 仅允许本机访问
npx tsx gui/server.ts --host 127.0.0.1 --open
```

界面操作流程：点击“选择地形文件”并选取 JSON → 设置 Cost（或点 🎲 随机生成）→ 点“生成牌局”→ 右侧查看结果。批量产关支持一次选择多个 JSON 文件。

Zen Match 的复制参数采用与 LayerClosure 相同的可读分段形式：
`Zen:花色数:策略:seed:关卡ID`，例如 `Zen:5:4:0:100075`。旧版
`RGP1` 参数仍可解析，但页面不再为 Zen Match 生成这种不透明参数串。

服务默认监听 `0.0.0.0`。同一局域网内的设备应选择与自身网络对应的物理网卡地址（例如 `[WLAN]` 或 `[以太网]`）；WSL、VMware、VPN 等地址会单独标为虚拟网卡，通常无需使用。地形由访问页面的设备在浏览器中选择并上传，因此远程设备不需要知道服务端的关卡目录；首次运行时若 Windows 防火墙询问，请允许专用网络访问。

### Tile Match 管理平台接入

ReverseGen 首页保持独立服务，由管理平台通过 iframe 打开。Docker 构建、子路径部署、
外部生成接口、环境变量和验收步骤统一见
[生成页部署包说明](apps/reversegen-generator/README.md)。

除非任务明确提到生成页部署、打包、容器或 iframe 接入，否则不更新
`apps/reversegen-generator/`。

### TypeScript API

```typescript
import { generateBoard, loadTerrainFromFile } from 'reversegen';

const terrain = loadTerrainFromFile('/path/to/100075.json');
const result = generateBoard({
  terrain,
  costArray: [4, 4, 4, 3, 3, 2, 3, 2],
  colorCount: 30,
});

result.replayCode;   // "PYjJEQMx..." 序列化种子
result.costLog;      // [4,4,4,3,1,2,...] 实际 cost 链
result.stepLog;      // StepRecord[] 每步详情(含选中 triple、封杀数、抢救来源)
result.matchRate;    // 67.85  匹配率
result.assignments;  // Map<tileId, elementValue>
```

Tile Explorer 生成器使用独立移植的旧版 `.NET System.Random`，不会调用外部 Python：

```typescript
import { generateBoardTileExplorer } from 'reversegen';

const result = generateBoardTileExplorer({
  terrain,
  strategy: 'solvability_coefficient_v2',
  difficulty: 2,
  colorCount: 5,
  sequenceSeed: 123,
  placementSeed: 456,
});

result.assignments;  // 与其他生成器相同的 tileId → 花色
result.replayCode;   // 可直接进入模拟、打关和分档流程
result.viewLayers;   // 从地形 Dependencies 自动计算
```

Zen Match 生成器直接使用已经转换为 Shell 格式的 tile ID、Layer 和
Dependencies，不再解析 Zen 原始 terrain。Shell ID 相对 Zen node ID 的整体
`+1` 不改变节点顺序，生成器内部不需要维护双 ID：

```typescript
import { generateBoardZenMatch } from 'reversegen';

const result = generateBoardZenMatch({
  terrain,
  uniqueCount: 5,
  seed: 12345,
  strategy: 5,
});

result.assignments;      // Shell tileId → 花色
result.topMatchTileIds;  // 顶部保底三消的 Shell tile ID
result.replayCode;
```

ZenMatch 保留固定牌、三张牌型队列、一步顶部候选扩展、策略 4
全局随机铺牌和策略 5 分层铺牌的语义。它面向静态依赖地形，不支持
transfer/falling；ReplayCode 会把 Zen 的抽象花色标签归一化为 `1..K`。

### Deadlock + LayerClosure API

在牌局中植入一个数学上保证必死的子牌局（最小必死 dagT 的可达包含，
按变体表染色），剩余牌照常走 LayerClosure 且**不使用死锁花色**：

```typescript
import { generateBoardDeadlockLayerClosure } from 'reversegen';

const result = generateBoardDeadlockLayerClosure({
  terrain,
  closeRates: [0.3, 0.5, 0.8],
  colorCount: 10,
  dock: 7,
  deadlock: {
    tileCount: 12,              // t = 3n（默认 12）
    layerLimit: 3,              // dagT 层数限制 l（默认 3，≥3）
    depthPreference: 'deepest',   // 多包含时选更深（deepest/shallowest/neutral）
    densityPreference: 'densest', // 多包含时选更密（densest/sparsest/neutral）
    selectionSeed: 0,           // 同分破平种子（确定性）
    enumerationSeed: 0,         // 枚举顺序种子：从全部包含中随机采样（确定性）
    searchLimit: 256,           // 随机采样的包含数量上限（存在包含且 ≥1 必有返回）
  },
});

result.deadlock;          // DeadlockReport：变体 id、模板角色→地形牌映射、逐色闭包
result.deadlock.closures; // Map<模板色, 闭包大小> —— 全部 ≥ 8 ⇒ 必死
result.assignments;       // 全量 tileId → 花色（死锁色 1..n，剩余 n+1..K）
result.metrics;           // LayerClosure 指标（闭合率/债务口径排除死锁牌）
result.replayCode;
```

数学契约：每色「三消闭包」（3 张同色 + 直接依赖子图传递依赖）≥ 8 ⟺ 纯玩法
第 7 张死锁牌入槽必死，与外部牌穿插无关；剩余牌不使用死锁花色则不破坏死锁。
泡泡/魔药/礼盒等机制允许破局——这正是该生成器的设计用途。找不到最小 dagT
的可达包含时直接报错（不静默回退）。地形包含量大时，搜索按 `enumerationSeed`
洗牌顺序取前 `searchLimit` 个包含（默认 256），深浅/疏密偏好在该采样集上择优；
采样不改变「是否有结果」。

### 难度分档策略1

`config/grade-strategy-1.json` 提供低覆盖、高可信的六档认证规则。输入
SafeRandom + mistake 在 1% / 5% / 15% 失误率下的模拟胜率；规则重叠时更难档优先。

```typescript
import { readFileSync } from 'node:fs';
import { gradeStrategy1 } from 'reversegen';
import type { GradeStrategy1Config, SimSnapshot } from 'reversegen';

const config = JSON.parse(
  readFileSync('config/grade-strategy-1.json', 'utf8'),
) as GradeStrategy1Config;

declare const snapshot: SimSnapshot;
const verdict = gradeStrategy1(snapshot, config);
// { grade: 0..5, label: '...', passed: true }
// 未命中认证规则时：{ grade: -1, label: '未认证', passed: false }
```

六档目标线上胜率依次为：90–100%、60–90%、40–60%、20–40%、10–20%、0–10%。
在 Web GUI 的“难度分档”面板中，将“分档策略”切换为“分档策略1 · 六档认证”即可使用。

### 三种输出模式

| 参数 | 场景 | 输出内容 |
|------|------|---------|
| 默认 | 人眼调试 | 地形摘要 → 统计 → 步骤详情表 → 花色分布 → ReplayCode |
| `-q` | 管道/批量 | 仅一行 ReplayCode |
| `--json` | AI 分析/程序消费 | 完整 JSON（含 stepLog 数组、assignments Map） |

---

## 核心概念

### Cost 数组（难度曲线）
每一步的目标 cost。cost = 消除这三张牌需要"释放"的依赖数量。cost 越大 = 这一步越难。数组长度必须 = 自由牌数 ÷ 3。可用 Cost 生成器随机生成。

### Triple（三牌组合）
从自由牌中任选 3 张组成的消除组合。C(n,3) 枚举所有可能。

### ReplayCode（序列化种子）
v4 格式二进制 → Raw Deflate(RFC 1951) → Base64。可直接用于 Unity `TileMatchBattle.LoadLevel_V2()` 还原完整牌局。

---

## 算法架构

算法由两层组成。以下分类说明各机制的定位，而非"哪些应该去改"——默认配置已经是经过验证的合理选择。

### 核心机制

这四项是算法的骨架，移除任何一项算法就不再成立：

| 机制 | 作用 |
|------|------|
| **Cost 计算** | cost = depSet 中尚未释放的牌数，每步实时重算。唯一的决策依据 |
| **贪心选择** | 每步选 cost 最小的 triple（有 cost 目标时选 cost≥target 的第一个） |
| **黑名单** | cost ≤ 选中 triple 的候选全部封杀，阻止贪心退化为每步选最便宜 |
| **r-chain 约束** | r_i = r_{i-1} + c_i - 3, r_0 = r_N = 0，Cost 数组的合法性基础 |

### 辅助机制

这几项是优化层——它们的存在让算法结果更好，但算法不依赖它们也能运行：

| 机制 | 作用 |
|------|------|
| **池化（历史机制，已移除）** | 早期版本含"连续同 cost 步骤在同一快照下互选"的多选分支，但池构造始终为 count=1 使其不可达；为避免文档与实现不一致，该分支已删除，当前为每步独立快照贪心 |
| **抢救** | 候选耗光时从黑名单尾部找回最近被封的 triple |
| **花色选择** | 选违规最少的花色，平局时优先选已分配较少的花色保持均衡 |
| **排序稳定性** | 同等 cost 候选的相对顺序（C# 不稳定 / JS 稳定，跨平台已知差异） |

### 已知局限

CostLadder 建立在"贪心路径 = 最优解路径"的前提上。DFS 求解器验证表明
该前提并不成立：贪心判定"无解"的关卡，真实最优路径往往可解。因此
CostLadder 精确控制的是**贪心模拟**的 cost 链，而非真实玩家体验——
可解性与难度验证应使用 `src/solver/` 的 DFS 与玩家模拟，详见
[docs/project-journey.md](./docs/project-journey.md) 第四节。

---

## 项目结构

```
reversegen/
├── src/                      # 核心库
│   ├── mechanics/            # ★ 机制规则引擎（与 Unity 逐位对齐）
│   │   ├── registry.ts       #   挂件注册表（25 枚举、白名单、常量、盐值表）
│   │   ├── spec.ts           #   一关表示：ReplayCode + 机制枚举组合
│   │   ├── seed.ts           #   派生种子统一实现（mul397/共享战场/魔药/洗牌）
│   │   ├── assigner.ts       #   机制分配器（对齐 TileExtraAssigner，Xorshift128+）
│   │   ├── engine.ts         #   MechanicEngine：三消行为分发 + 泡泡 tick
│   │   ├── extras.ts         #   衰减/揭示/订单/蒲公英/礼盒/魔法棒/洗牌
│   │   └── step-appliers.ts  #   机制步骤应用策略表
│   ├── solver/               # 游戏引擎 + 求解器
│   │   ├── offline-game.ts   #   OfflineGame 状态机（collect→Dock→三消→刷新）
│   │   ├── solver-player.ts  #   统一玩家引擎（各画像变体复用）
│   │   └── solver-*.ts       #   DFS/贪心/随机/死亡检查点/玩家画像变体
│   ├── strategy/             # 批量生产策略 v2（schema 定义→生成→流水线→模拟→评级）
│   ├── reverse-gen.ts        # CostLadder 生成算法（历史生成器）
│   ├── layer-closure-gen.ts  # LayerClosure 编排入口（实现拆在 layer-closure/）
│   ├── layer-closure/        #   配额/矩阵/贴色/指标模块
│   ├── deadlock-layer-closure-gen.ts # Deadlock+LayerClosure 编排入口（前置死锁 + 复用 layer-closure/）
│   ├── deadlock/             #   必死 DAG 域：变体表/闭包验证/可达包含搜索/偏好选择
│   ├── tile-explorer/        # Tile Explorer 策略、.NET RNG、view_layers
│   ├── zen-match/            # Zen Match 静态策略 4/5
│   ├── replay-serializer.ts  # ReplayCode v4 编解码（Deflate + CRC16）
│   ├── terrain-loader.ts     # 地形加载
│   ├── types.ts              # 类型聚合入口（领域类型拆在 types/）
│   └── batch-generator.ts    # 批量生产主引擎（batch-generator-new.ts 为实验迁移版）
├── tools/                    # 分析工具（dag/ planning/ 批量/统计）
├── cli/generate.ts           # CLI 工具
├── gui/
│   ├── server.ts             # HTTP 服务骨架（路由分发）
│   ├── lib/                  #   按域拆分的 API 模块（生成/分析/模拟/分档/批量/策略）
│   ├── index.html            # 牌局生成器页面
│   └── analysis.html         # DAG 分析页面（4 种图）
├── test/                     # 143 个单元/集成测试（含机制逐位 golden）
└── docs/                     # 对齐契约与分析报告（mechanics-alignment.md 为机制权威契约）
```

---

## 测试

```bash
npm test                 # 全部测试（143 个）
npx tsx --test test/unit/mechanics-engine.test.ts   # 机制引擎（golden 对齐）
npx tsx --test test/unit/assigner.test.ts           # 机制分配器
```

---

## 地形格式

兼容 Unity level JSON：

```json
{
  "levelResId": 100075,
  "layers": [
    { "tiles": [
      { "ID": 1, "Layer": 0, "Dependencies": [], "IsConst": false },
      { "ID": 15, "Layer": 1, "Dependencies": [1, 2, 5], "IsConst": false }
    ]}
  ]
}
```

---

## 与 Unity 的已知差异

机制域的逐位对齐状态、已知边界与决策点以 [docs/mechanics-alignment.md](./docs/mechanics-alignment.md) 为权威契约。摘要：

- **已逐位对齐**：魔药(31)、蒲公英(36)、礼盒(37)、衰减/揭示/订单类挂件、机制分配器、三套确定性随机（System.Random / Xorshift128+ / 战场派生种子）、ReplayCode 解码。
- **记录在案的边界**：Undo/复活不在契约内；C# `List.Sort`（不稳定）与 JS `Array.sort`（稳定）在同 key 精确并列时可能产生不同顺序（极低概率）。

---

## 更多信息

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计原理、依赖图、数据流、测试策略
- [docs/mechanics-alignment.md](./docs/mechanics-alignment.md) — 特殊机制对齐契约（信息来源、确定性随机约定、接入状态、已知风险）
- [gui/server.ts](./gui/server.ts) — 服务器 API 端点
- [test/](./test/) — 测试用例
