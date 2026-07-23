# Rust components

`rust/` 保存 ReverseGen 的独立 Rust 运行组件。目前只有：

```text
rust/strategy-sim/
├── Cargo.toml
├── Cargo.lock
├── PROTOCOL.md
└── src/
```

`strategy-sim` 是 TypeScript 策略管线调用的进程型模拟器，不是单独的 Web 服务。
JSON 协议见 `strategy-sim/PROTOCOL.md`。

本地构建：

```bash
npm run strategy:rust:build
```

默认运行路径为：

```text
rust/strategy-sim/target/release/reversegen-strategy-sim
```

Rust 模拟器只用于批量策略生成和批量模拟。ReverseGen 生成首页的 Docker 镜像不编译、
不复制这个组件。不要提交 `target/`，也不要把 Cargo 工具链带入生成首页镜像。
