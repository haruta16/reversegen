# ReverseGen · 牌局生成器

从 Unity TileMatch 项目中剥离的**独立牌局生成工具**。输入「地形 + Cost 数组 + 花色数」，输出「完整牌局花色分配 + 序列化种子 (ReplayCode)」。

与 Unity 零依赖，CLI / Web GUI / TypeScript API 三种使用方式。

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
npx tsx cli/generate.ts --test-terrain --layers 2 --tiles 12 --colors 4

# 真实关卡
npx tsx cli/generate.ts \
  --terrain /path/to/TileMatchShell/Tools/Config/Json/Levels/100075.json \
  --cost 4,4,4,3,3,2,3,2,4,4,5,2,3,4,3,2,3,4,3,3,2,1,5,2,4,2,2,1 \
  --colors 30

# 仅输出 ReplayCode（可管道）
npx tsx cli/generate.ts -t level.json -c 3,3,2 -k 6 -q | pbcopy

# 查看帮助
npx tsx cli/generate.ts --help
```

### Web GUI

```bash
npm run gui
# → 浏览器打开 http://localhost:3000
# 页面自动扫描关卡列表，点击 ID 即可加载
```

### TypeScript API

```typescript
import { generateBoard, loadTerrainFromFile } from 'reversegen';

const terrain = loadTerrainFromFile('/path/to/100075.json');
const result = generateBoard({
  terrain,
  costArray: [4, 4, 4, 3, 3, 2, 3, 2, 4, 4, 5, 2, 3, 4, 3, 2, 3, 4, 3, 3, 2, 1, 5, 2, 4, 2, 2, 1],
  colorCount: 30,
});

console.log(result.replayCode);   // "PYjJEQMx..." 序列化种子
console.log(result.costLog);      // [4,4,4,3,1,2,...] 实际cost链
console.log(result.matchRate);    // 67.85  匹配率(%)
console.log(result.assignments);  // Map<tileId, elementValue>
```

---

## 核心概念

### Cost 数组（难度曲线）
每一步的目标 cost。cost = 消除这三张牌需要"释放"的依赖数量。cost 越大 = 这一步越难。数组长度必须 = 自由牌数 ÷ 3。

### Triple（三牌组合）
从自由牌中任选 3 张组成的消除组合。C(n,3) 枚举所有可能。

### ReplayCode（序列化种子）
v4 格式二进制：`version + tileCount + elementCount + levelHash + instanceArray + dockEntries + CRC16`，经 Raw Deflate 压缩后 Base64 编码。可直接用于 Unity `TileMatchBattle.LoadLevel_V2()` 还原完整牌局。

---

## 算法简介

ReverseGen CostLadder 逆向模拟游戏过程：

1. **依赖图**：BFS 计算每张牌的传递依赖闭包
2. **Triple 枚举**：C(n,3) 枚举所有合法三牌组合
3. **贪心选择**：每步选动态 cost 最小的 triple
4. **黑名单**：cost ≤ 选中 triple 的候选全部封杀，防止贪心矛盾
5. **池化**：cost ≤ 3 的连续同值步骤合并，同一快照下互选
6. **抢救**：候选耗光时从黑名单尾部找回最近被封的 triple
7. **安全选色**：选创建最少违规的花色

---

## 项目结构

```
reversegen/
├── src/
│   ├── types.ts              # 全部类型定义
│   ├── reverse-gen.ts        # ★ CostLadder 算法主体
│   ├── replay-serializer.ts  # ★ v4 ReplayCode 编解码
│   ├── dependency-graph.ts   # BFS 传递闭包
│   ├── triple-builder.ts     # C(n,3) 枚举 + cost 计算
│   ├── greedy-sim.ts         # 纯贪心模拟验证
│   ├── terrain-loader.ts     # JSON 地形加载 + 测试地形生成
│   ├── crc16.ts              # CRC16/MODBUS
│   ├── logger.ts             # 日志
│   └── index.ts              # 公共 API + generateBoard()
├── cli/generate.ts           # CLI 工具
├── gui/
│   ├── server.ts             # HTTP 服务器
│   └── index.html            # Web 前端
├── test/                     # 29 个单元测试
├── ARCHITECTURE.md           # 详细架构说明
└── README.md                 # 本文件
```

---

## 测试

```bash
npm test                 # 全部 29 个测试
npm run test:algo        # 算法测试（10 个）
npm run test:serializer  # 序列化测试（19 个）
```

---

## 地形格式

兼容 Unity level JSON 格式：

```json
{
  "levelResId": 100075,
  "LevelHash": "550ede7fd250e2d4",
  "layers": [
    {
      "tiles": [
        { "ID": 1, "Layer": 0, "Dependencies": [], "IsConst": false },
        { "ID": 15, "Layer": 1, "Dependencies": [1, 2, 5], "IsConst": false }
      ]
    }
  ]
}
```

---

## 与 Unity 的已知差异

C# 的 `List.Sort` 是不稳定排序，JavaScript 的 `Array.sort` 是稳定排序。同等 cost 的 triple 在排序后相对顺序不同，导致跨平台时可能选中不同的 triple。算法逻辑完全一致，差异仅来自排序实现细节。

---

## 更多信息

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构设计原理、依赖图、数据流、测试策略
- [gu/server.ts](./gui/server.ts) — 服务器 API 端点
- [test/](./test/) — 测试用例
