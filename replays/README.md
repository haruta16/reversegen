# Replay 候选工作流

`selection.csv` 是候选牌局的唯一数据源。通过 ReverseGen GUI 生成或导入牌局、完成分档后，点击“保存到 CSV”即可追加记录；也可以直接用表格软件编辑 CSV。

## 字段约定

- `grade` 允许留空或填写 `0` 到 `5`。留空记录会在构建时跳过。
- `ReplayKey` 由界面写成 `1-2-3-{ElementCount}-`。
- 未确认的数值字段默认写 `0`，标签字段默认留空。
- 同一 `levelResId` 的 `LevelTags` 必须一致。
- `levelResId + ReplayCode` 必须唯一。

## 校验和构建

```bash
npm run replay:check
npm run replay:build
```

构建会按 `levelResId` 在 `generated/` 下生成多个 JSON。每次构建都会以 CSV 为准重建该目录中的 JSON，但不会修改目录中的其他文件，也不会写入外部 TileMatchShell 项目。
