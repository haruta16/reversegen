# ReverseGen Generator App

ReverseGen 首页的独立部署包，提供关卡参数加载、牌局生成、结果展示及首页已有的
Replay 校验能力。主平台通过 iframe 使用本服务，不复制 ReverseGen 源码，也不直接
访问 ReverseGen 的文件系统。

> 维护约束：除非任务明确提到本应用的部署、打包、容器或 iframe 接入，否则不要更新
> 本目录。该约束也记录在同目录的 `AGENTS.md`。

## 目录边界

```text
apps/reversegen-generator/
├── AGENTS.md
└── README.md
```

接入说明和维护约束归本目录所有。为了满足外部界面验收指南，Docker 构建入口保留在
Git 仓库根目录：

```text
Dockerfile                 纯 Node/TypeScript 生成页镜像
.dockerignore              Docker build context 过滤规则
gui/index.html             首页
gui/server.ts              HTTP 服务及页面接口
src/                       TypeScript 生成与模拟核心
config/                    运行配置
strategies/                生成策略
```

`rust/strategy-sim/` 只供批量策略生成和批量模拟使用，不参与首页镜像构建。

## 构建

在 Git 仓库根目录执行：

```bash
docker build -t reversegen-generator:local .
```

镜像只安装并运行 Node/TypeScript 服务，不安装 Rust/Cargo，也不复制 Rust 模拟器。

## 启动

```bash
docker run --rm \
  --name reversegen-generator \
  -p 5180:80 \
  -v /absolute/path/to/Levels:/data/levels:ro \
  -e APP_BASE_PATH=/ \
  -e FRAME_ANCESTORS="'self' http://localhost:*" \
  reversegen-generator:local
```

`LEVELS_DIR=/data/levels` 是容器内默认路径。首页仍允许用户：

- 修改默认关卡目录；
- 从默认目录按关卡 ID 加载；
- 在浏览器中单独选择一个关卡 JSON；
- 解析 Replay 时优先复用当前已加载且匹配的关卡。

## 子路径与 iframe

反向代理需要把应用挂到子路径时：

```bash
docker run --rm \
  --name reversegen-generator \
  -p 5180:80 \
  -e APP_BASE_PATH=/apps/reversegen/ \
  -e FRAME_ANCESTORS="'self' https://management.example.internal" \
  reversegen-generator:local
```

管理平台页面：

```html
<iframe
  src="https://reversegen.example.internal/apps/reversegen/"
  title="ReverseGen"
></iframe>
```

反向代理必须原样转发 `/apps/reversegen/` 下的页面、静态资源和 API。健康检查始终可以
直接请求根路径 `/health`，也可以请求应用子路径下的 `health`。

## 运行时配置

| 环境变量 | Docker 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `80` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `APP_SURFACE` | `generator` | 仅暴露生成首页；不要在此镜像中改为完整工具站 |
| `APP_BASE_PATH` | `/` | 反向代理挂载路径 |
| `FRAME_ANCESTORS` | 空 | CSP `frame-ancestors`，生产环境填写主平台来源 |
| `LEVELS_DIR` | `/data/levels` | 服务端默认关卡目录 |
| `PLATFORM_API_URL` | 空 | 预留的平台 API 根地址，当前首页不使用 |

不要把平台地址、凭据或关卡宿主机路径写死进镜像。

## 外部生成接口

```text
POST /api/v1/generate-replay
Content-Type: application/json
```

请求：

```json
{
  "parameterString": "50,71,80,85,90,95,98,100:8:7:50:0:0:50:100075",
  "terrain": {
    "levelResId": 100075,
    "layers": []
  }
}
```

`terrain` 需要放入完整关卡 JSON 对象。调用方不方便先解析文件时，也可以改传
`terrainJson`，值为完整文件文本：

```json
{
  "parameterString": "...",
  "terrainJson": "{\"levelResId\":100075,\"layers\":[...]}"
}
```

接口兼容首页复制按钮当前生成的三种参数串：

- CostLadder：4 段位置格式；
- LayerClosure：8 段位置格式；
- TileExplorer：`RGP1.` 开头的 Base64URL JSON。

接口始终使用请求中传入的关卡内容，不读取参数串里的文件路径。参数串关卡 ID 与关卡
JSON 的 `levelResId` 同时存在但不一致时，请求失败，避免对错误关卡生成牌局。

成功响应：

```json
{
  "ok": true,
  "replayCode": "...",
  "algorithm": "closure",
  "levelResId": 100075,
  "elementCount": 8,
  "levelHash": "..."
}
```

失败返回 HTTP 400：

```json
{
  "ok": false,
  "error": "参数或关卡不匹配的具体原因"
}
```

准备好 `request.json` 后可以直接验证：

```bash
curl http://localhost:5180/api/v1/generate-replay \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
```

## 验收

健康检查：

```bash
curl http://localhost:5180/health
```

预期至少包含：

```json
{
  "status": "ok",
  "app": "reversegen",
  "surface": "generator",
  "basePath": "/"
}
```

随后在浏览器完成一次主链路：

1. 打开首页。
2. 从默认目录或单独文件加载一个关卡。
3. 选择生成算法并调整参数。
4. 生成牌局。
5. 确认结果概览、闭合率图和 ReplayCode 正常出现。
6. 调用 `/api/v1/generate-replay`，确认返回可解码的 ReplayCode。

子路径部署还要额外确认静态资源和 `/api/*` 请求没有落到域名根路径。

## 平台集成边界

当前不需要主平台提供业务 API，不读取平台数据库，也不写入平台数据。主平台只需要：

- 部署或访问本服务；
- 配置 iframe 菜单入口；
- 为 ReverseGen 域名或子路径配置反向代理；
- 将平台来源加入 `FRAME_ANCESTORS`。

以后确实需要平台关卡列表、登录身份或结果回存时，再单独设计
`/api/integration/v1/...`，不要在现有生成接口中隐式耦合平台实现。
