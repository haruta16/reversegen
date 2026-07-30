# ReverseGen · 牌局生成器

从 Unity TileMatch 项目中剥离的**独立牌局生成工具**。提供 CostLadder、LayerClosure、TileExplorer、ZenMatch 四个平级生成器，统一输出「牌局花色分配 + ReplayCode 序列化种子」。

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

这四项是优化层——它们的存在让算法结果更好，但算法不依赖它们也能运行：

| 机制 | 作用 |
|------|------|
| **池化** | 连续同 cost 步骤在同一快照下互选，避免 collectedIds 膨胀导致"同伴互杀" |
| **抢救** | 候选耗光时从黑名单尾部找回最近被封的 triple |
| **花色选择** | 选违规最少的花色，平局时优先选已分配较少的花色保持均衡 |
| **排序稳定性** | 同等 cost 候选的相对顺序（C# 不稳定 / JS 稳定，跨平台已知差异） |

---

## 项目结构

```
reversegen/
├── src/                      # 核心库
│   ├── reverse-gen.ts        # ★ CostLadder 生成算法
│   ├── layer-closure-gen.ts  # ★ LayerClosure 生成算法
│   ├── tile-explorer/        # ★ Tile Explorer 策略、.NET RNG、view_layers
│   ├── zen-match/            # ★ Zen Match 策略 4/5
│   ├── replay-serializer.ts  # ReplayCode 编解码
│   ├── cost-generator.ts     # Cost 数组随机生成器
│   ├── dependency-graph.ts   # BFS 传递依赖闭包
│   ├── triple-builder.ts     # 三牌组合枚举
│   ├── greedy-sim.ts         # 贪心模拟验证
│   ├── terrain-loader.ts     # 地形加载
│   ├── solver/               # 游戏引擎 + DFS/贪心/随机求解器
│   └── ...
├── tools/                    # 分析工具
│   ├── dag/                  # DAG 分析（色组/增强/Triple）
│   └── planning/             # 消除规划
├── cli/generate.ts           # CLI 工具
├── gui/
│   ├── server.ts             # HTTP 服务器
│   ├── index.html            # 牌局生成器页面
│   └── analysis.html         # DAG 分析页面（4 种图）
├── test/                     # 29 个测试
└── docs/                     # 分析报告
```

---

## 测试

```bash
npm test                 # 全部测试
npm run test:algo        # 算法测试（10 个）
npm run test:serializer  # 序列化测试（19 个）
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

C# `List.Sort` 是不稳定排序，JS `Array.sort` 是稳定排序。同等 cost 的 triple 在排序后相对顺序不同，导致跨平台时可能选中不同的 triple。算法逻辑完全一致，差异仅来自排序实现细节。

---

## 更多信息

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计原理、依赖图、数据流、测试策略
- [gui/server.ts](./gui/server.ts) — 服务器 API 端点
- [test/](./test/) — 测试用例
