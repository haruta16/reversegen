# 跨侧 Golden（Cross-Side Golden）— 操作手册

## 是什么

"跨侧 golden"是把**对齐从代码审计升级为可回归验证**的手段：

> 同一地形 + 同一 ReplayCode + 同一机制配置 + 同一动作序列，
> 在 **Unity 客户端**与 **reversegen** 双端执行，逐帧导出状态摘要并逐帧比对。
> 第一处不一致即定位到具体帧与字段 —— 这就是"1:1 复刻"的黄金证据。

单侧单测的 golden（`test/unit/mechanics-*.test.ts`）只能证明自洽，
跨侧 golden 才能证明对齐。

## 追踪格式（v1，`src/verification/cross-side-trace.ts`）

```jsonc
{
  "protocol": "reversegen-cross-trace",
  "version": 1,
  "meta": { "levelResId": 100, "replayCode": "...", "mechanics": "31:3,39:2",
            "giftboxOpenEffects": [1,2,4,5,6,9,10,11], "mechanicSeed": 7 },
  "actions": [1, 4, 7],          // 逐帧执行的收牌动作（tileId）
  "frames": [                    // 帧 0 = 初始状态；每动作后一帧
    {
      "action": null,            // 或 { "type": "collect", "tileId": 7 }
      "actionCount": 3,          // Unity Steps.Count / reversegen actionCount
      "desk":   [ { "id": 1, "elementValue": 301, "extras": "4(3.0.0)" } ],   // 按 id 升序
      "dock":   [ { "id": 2, "elementValue": 301, "extras": "" } ],           // 实际顺序
      "discardCount": 3,
      "dockSlotBonus": 0,        // 礼盒加槽（MaxSlotCount - 7）
      "bubble": { "enabled": true, "rounds": 1, "activeRoundCounted": false, "active": [2] },
      "structures": [ { "id": 9, "extraEnum": 51, "removed": false } ],       // 51-53
      "mechanicSteps": [ { "type": "magic-bottle-clear", "tileIds": [1,2,3] } ]
    }
  ]
}
```

约定：
- `extras` 编码 = `enum(countdown.isDone.isConsumed)` 用 `+` 串联（与 `buildStateKey` 同口径）；
- `mechanicSteps` 只含 Unity 会 `AppendStep` 的步骤类型（魔药清除 / 魔法棒 / 泡泡吸取 / 洗牌）；
  泡泡指派不是 Unity 步骤，其效果经 `bubble.active` 体现；
- 冷却（0.5s）是帧时间量，不参与比对（reversegen 以 tick 近似）。

## Unity 侧导出器（放入 `_InnerCode` 的编辑器工具目录）

```csharp
// CrossSideTraceExporter.cs —— 编辑器/GM 调试工具：给定动作序列导出跨侧追踪。
// 用法（GM 或编辑器菜单）：
//   CrossSideTraceExporter.Export(battle, new[] { 1, 4, 7 }, "trace.json");
#if UNITY_EDITOR || DEBUG
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;

namespace DGuo.Client.TileMatch
{
    public static class CrossSideTraceExporter
    {
        public static void Export(TileMatchBattle battle, int[] actions, string path)
        {
            var trace = new Dictionary<string, object>
            {
                ["protocol"] = "reversegen-cross-trace",
                ["version"] = 1,
                ["meta"] = new Dictionary<string, object>(),
                ["actions"] = actions,
                ["frames"] = new List<Dictionary<string, object>>(),
            };
            var frames = (List<Dictionary<string, object>>)trace["frames"];
            frames.Add(Snapshot(battle, null));

            var seenSteps = 0;
            foreach (int tileId in actions)
            {
                battle.Collect(battle.AllTiles[tileId]);
                // 等待本帧动画/异步机制静止：机制步骤全部 AppendStep 完成
                // （编辑器中可 WaitForSeconds 或逐帧驱动直到 OpBusyMgr.All 空闲）
                var newSteps = battle.StepMgr.Steps.Skip(seenSteps)
                    .Where(step => !(step is CollectStep))
                    .Select(step => (type: StepTypeName(step), ids: StepTileIds(step)))
                    .ToList();
                seenSteps = battle.StepMgr.Steps.Count;
                frames.Add(Snapshot(battle,
                    new Dictionary<string, object>
                    {
                        ["type"] = "collect",
                        ["tileId"] = tileId,
                    }, newSteps));
            }
            File.WriteAllText(path, JsonUtility.ToJson(new SerializableTrace(trace)));
        }

        private static Dictionary<string, object> Snapshot(
            TileMatchBattle battle,
            Dictionary<string, object> action,
            List<(string type, int[] ids)> newSteps = null)
        {
            string ExtraState(ExtraBase extra)
            {
                int countdown = extra is GoldenExtra g ? g.Value :
                    extra is AdventCalendarExtra c ? c.Value :
                    extra is EasterExtra e ? e.Value : 0;
                int done = extra is UnknownExtra u && u.isDone ? 1 : extra is FlipExtra f && f.isDone ? 1 : 0;
                int consumed = extra.IsMarkCosumed() ? 1 : 0;
                return $"{(int)extra.ExtraEnum}({countdown}.{done}.{consumed})";
            }

            var bubble = battle.BubbleCollectMgr;
            return new Dictionary<string, object>
            {
                ["action"] = action,
                ["actionCount"] = battle.StepMgr.Steps.Count,
                ["desk"] = battle.Desk.DeskTiles.OrderBy(t => t.ID)
                    .Select(t => (object)new Dictionary<string, object>
                    {
                        ["id"] = t.ID, ["elementValue"] = t.ElementValue,
                        ["extras"] = string.Join("+", t.Extras.Select(ExtraState)),
                    }).ToList(),
                ["dock"] = battle.Dock.dockTiles.Select(t => (object)new Dictionary<string, object>
                {
                    ["id"] = t.ID, ["elementValue"] = t.ElementValue,
                    ["extras"] = string.Join("+", t.Extras.Select(ExtraState)),
                }).ToList(),
                ["discardCount"] = battle.AllTiles.Values.Count(t => t.PileType == PileType.Discard),
                ["dockSlotBonus"] = battle.Dock.MaxSlotCount - 7,
                ["bubble"] = bubble == null ? null : new Dictionary<string, object>
                {
                    ["enabled"] = true,
                    ["rounds"] = bubble.CompletedCollectRounds,
                    ["activeRoundCounted"] = bubble.ActiveRoundCounted,
                    ["active"] = bubble.GetActiveBubbleTileIds().OrderBy(id => id).ToList(),
                },
                ["structures"] = battle.BoardSpecialStructuresForTrace()
                    .Select(s => (object)new Dictionary<string, object>
                    {
                        ["id"] = s.Data.ID, ["extraEnum"] = (int)s.Data.extraEnum,
                        ["removed"] = s.IsRemoved,
                    }).ToList(),
                ["mechanicSteps"] = newSteps?.Select(step =>
                    (object)new Dictionary<string, object>
                    {
                        ["type"] = step.type,
                        ["tileIds"] = step.ids,
                    }).ToList() ?? new List<object>(),
            };
        }

        private static string StepTypeName(BaseStep step) => step.StepType switch
        {
            EStepType.MagicBottleStep => "magic-bottle-clear",
            EStepType.MagicStep => "magic-step",
            EStepType.BubbleCollectStep => "bubble-collect",
            EStepType.ShuffleStep => "giftbox-shuffle",
            _ => step.StepType.ToString(),
        };

        private static int[] StepTileIds(BaseStep step) => step switch
        {
            MagicBottleStep m => m.TargetTiles.Select(t => t.ID).ToArray(),
            MagicStep s => s.CollectedTiles.Select(t => t.ID).ToArray(),
            BubbleCollectStep b => b.CollectedTiles.Select(t => t.ID).ToArray(),
            _ => Array.Empty<int>(),
        };
    }

    [Serializable]
    public class SerializableTrace { public string json; public SerializableTrace(object o) => json = MiniJson(o); }
}
#endif
```

适配点（按 _InnerCode 实际可见性调整）：
1. `battle.BoardSpecialStructuresForTrace()` 需要一行内部访问器：
   `internal List<BoardSpecialStructure> BoardSpecialStructuresForTrace() => _boardSpecialStructures;`
2. `GoldenExtra.Value` / `AdventCalendarExtra.Value` / `EasterExtra.Value` 若为私有，导出器放到
   `DGuo.Client.TileMatch` 命名空间内即可访问，或经 `IsMarkCosumed` 之外补一个公开 getter。
3. `JsonUtility` 不支持字典/嵌套对象——`MiniJson` 用 `System.Text.Json` 或 Newtonsoft 序列化即可。

## reversegen 侧执行

```bash
# 自检（reversegen 自身确定性）
npx tsx tools/verify-cross-side.ts --terrain level.json --replay <code> \
  --mechanics "31:3,39:2" --actions "1,4,7" --self-check

# 对照（与 Unity 导出的追踪逐帧比对；退出码 0 = 逐位一致）
npx tsx tools/verify-cross-side.ts --terrain level.json --replay <code> \
  --mechanics "31:3,39:2" --actions "1,4,7" \
  --unity-trace unity-trace.json
```

分歧输出示例（第一处分歧即终止）：

```
[cross-side] frames[7].dock[0].extras: 期望 "2(0.1.0)"，实际 "2(0.0.0)"
```

## 纳入回归

理想形态是把 `unity-trace.json` 作为 fixture 提交到 `test/fixtures/cross-side/`，
单测中 `compareCrossSideTraces(record(…), fixture)`——Unity 每次机制改动后重导一次即可。
在 Unity 仓库里建导出 fixture 前，先用 `--self-check` 保证 reversegen 侧确定性。
