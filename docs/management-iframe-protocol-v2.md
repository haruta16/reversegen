# ReverseGen 管理平台 iframe 协议 v2

本协议让管理平台把一份**精确的地形 JSON 快照**交给 ReverseGen。v2 不会再根据
`levelId` 到 ReverseGen 主机的本地目录猜测资源来源；`reversegen:load-level` 仅作为
旧管理端的兼容路径保留。

## 安全与关联规则

- `protocolVersion` 固定为 `2`。
- 每条 v2 消息都必须有 `requestId`；回应沿用请求的 `requestId`，主动事件生成新值。
- ReverseGen 只接受 `event.source === window.parent` 且 `event.origin` 等于 iframe
  `document.referrer` origin 的消息。
- ReverseGen 回传时使用该精确 origin，不使用 `*`。
- `levelIdentity` 至少包含 `source`、`revision` 和 `hash`；`levelId` 可选，但提供时必须为正整数。
- `hash` 是地形 JSON 内的 Tile Match `LevelHash`。`contentHash` 则是收到的精确 JSON
  字符串的 SHA-256，用于确认传输内容未被替换，两者不可混用。

## 握手

ReverseGen iframe 初始化后发送：

```json
{
  "type": "reversegen:ready",
  "protocolVersion": 2,
  "requestId": "ready-...",
  "appVersion": "1.0.0",
  "capabilities": {
    "exactTerrainJson": true,
    "levelIdentity": true,
    "terrainLoadedAck": true,
    "dirtyState": true,
    "candidate": true,
    "standaloneLevelSelection": true,
    "legacyLoadLevel": true
  }
}
```

管理端应先确认 `protocolVersion` 和所需 capability，再发送地形。

## 直接入口选择地形

管理端没有预先指定 Level 时，ReverseGen 仍可直接打开。策划在 ReverseGen 顶部输入并成功
载入 Level 后，ReverseGen 主动发送本地实际读到的业务 Hash：

```json
{
  "type": "reversegen:level-selected",
  "protocolVersion": 2,
  "requestId": "level-selected-...",
  "levelId": 100075,
  "levelHash": "0123456789abcdef"
}
```

管理端必须用 `levelId + levelHash` 在明确的 `official/current` 来源中匹配精确快照，再发送
`reversegen:load-terrain` 完成确认。仅 ID 相同、Hash 不同不得建立体验会话。从关卡页进入后，
策划仍可在 ReverseGen 内改输另一个 Level；管理端应重复该流程，并同步更新外层路由与版本资料。

## 载入精确地形

管理端发送：

```json
{
  "type": "reversegen:load-terrain",
  "protocolVersion": 2,
  "requestId": "load-100075-1",
  "terrain": {
    "levelResId": 100075,
    "LevelHash": "0123456789abcdef",
    "layers": []
  },
  "levelIdentity": {
    "levelId": 100075,
    "source": "official",
    "revision": "git-commit-or-resource-revision",
    "hash": "0123456789abcdef"
  }
}
```

`terrain` 可以是 JSON 对象或原始 JSON 字符串。ReverseGen 会载入收到的内容、读取其中
实际的 `levelResId` / `LevelHash`，并校验身份。回应：

```json
{
  "type": "reversegen:terrain-loaded",
  "protocolVersion": 2,
  "requestId": "load-100075-1",
  "ok": true,
  "levelIdentity": {
    "levelId": 100075,
    "source": "official",
    "revision": "git-commit-or-resource-revision",
    "hash": "0123456789abcdef"
  },
  "actualHash": "0123456789abcdef",
  "contentHash": "sha256-hex-of-exact-json",
  "validation": {
    "ok": true,
    "checks": {
      "exactTerrainJson": true,
      "levelIdMatches": true,
      "levelHashPresent": true,
      "levelHashMatches": true
    },
    "warnings": [],
    "errors": []
  }
}
```

缺少 `LevelHash`、Level ID 不同或 Hash 不同时 `ok=false`，并阻止该快照继续生成候选。

## 脏状态

生成参数、算法或未套用的候选发生变化时发送：

```json
{
  "type": "reversegen:dirty-state",
  "protocolVersion": 2,
  "requestId": "dirty-...",
  "dirty": true,
  "reason": "parameters-changed"
}
```

初始化、成功载入地形和管理端确认实际体验包保存成功后会发送 `dirty=false`。管理端可据此
统一处理离页保护。

## 生成候选

页面成功生成候选后发送：

```json
{
  "type": "reversegen:candidate",
  "protocolVersion": 2,
  "requestId": "candidate-...",
  "candidate": {
    "replayCode": "v4 ...",
    "generator": { "name": "closure", "version": "1.0.0" },
    "parameterSummary": {
      "algorithm": "closure",
      "levelId": 100075,
      "serialized": "...",
      "hash": "sha256-hex"
    },
    "metrics": {},
    "levelIdentity": {
      "levelId": 100075,
      "source": "official",
      "revision": "git-commit-or-resource-revision",
      "hash": "0123456789abcdef"
    }
  }
}
```

候选事件只是把生成结果交给管理端，不代表已经保存为客户端实际体验；保存成功前 dirty
状态保持为 `true`。

## 外部生成 API

`POST /api/v1/generate-replay` 继续接受：

```json
{
  "parameterString": "...",
  "terrain": { "levelResId": 100075, "LevelHash": "0123456789abcdef", "layers": [] }
}
```

成功回应在原有 `replayCode / algorithm / levelResId / elementCount / levelHash` 之外增加：

- `generatorVersion`：当前 ReverseGen 应用版本。
- `parameterHash`：trim 后参数串的 SHA-256。
- `validation`：参数解析、地形校验、ReplayCode 解码和 LevelHash 一致性摘要。

## v1 兼容

旧管理端仍可发送：

```json
{ "type": "reversegen:load-level", "levelId": 100075 }
```

ReverseGen 会走旧的本地目录解析逻辑，并回应 `reversegen:load-level-result`。回应会附带
`protocolVersion=2`、自动生成的 `requestId`、`legacy=true` 和可用时的 `actualHash`。
新接入不得再依赖这条路径。
