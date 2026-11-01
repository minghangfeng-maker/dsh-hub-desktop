---
description: "DSH Hub Windows 打包提速经验：复用现有 npm 包并行打包入口、选择 8 并发、检查产物一致性，并区分基准结果与完整安装包耗时。"
---

# Hub Windows 打包提速经验

## 概述

后续 Windows 打包优先使用现有 `release:pack --concurrency 8` 批量入口。它同时减少逐包启动 pnpm 的开销并允许包任务并行；再多给并发收益很小。编译已支持增量，最先需要优化的是 npm 包打包阶段。

当前完整 Windows 打包仍使用串行默认值。本页记录已验证的做法；仅记录文档、设置 `DSH_GATE_CONCURRENCY` 或设置 macOS 专用变量，都不会自动加速 `hub-build.sh`。

## 目录

- [后续打包如何应用](#后续打包如何应用)
- [增量缓存与完整包](#增量缓存与完整包)

## 后续打包如何应用

1. 打包前检查 [package-target.ts](../scripts/package-target.ts) 的 `packArguments`：它目前只向 macOS 传入并发数。Windows 需要把 8 传给 dsh/vendor 两次 `release:pack`，才会把收益带入完整安装包。接线修改应使用明确的正整数配置，并保留 macOS 原设置；不用绕过 [pack.ts](../../../scripts/release/pack.ts) 的文件检查和发布顺序记录。
2. 保留独立构建目录，一次只运行一个完整构建；包打包阶段内部可用 8 并发。等待源码、相关测试和审查完成，再生成 EXE 与便携 ZIP。
3. 使用同一提交、相同品牌/版本/环境和已完成的编译产物比较串行与并行结果。核对包集合、解包文件内容、权限及链接；若整包摘要相同，可直接确认字节一致。不要只比较包数。
4. 完整构建后记录阶段耗时，并检查最终包内 Hub origin、版本、插件清单和 Windows 首启。整体提速以该次完整构建结果为准。

以下为已验证的独立基准命令，从仓库根目录执行。依赖已经安装，先用同一 Hub 品牌完成 `build:official`；之后不要同时修改源码或重建产物。输出目录专用于基准，脚本会清空该目录，不能换成正式打包输入目录：

```bash
NODE_ENV=development DSH_CLIENT_TITLE='DSH Hub' corepack pnpm run build:official
NODE_ENV=development DSH_CLIENT_TITLE='DSH Hub' corepack pnpm run release:pack --family dsh --out .desktop-build/bench-pack-8 --concurrency 8
```

这组命令只产生 npm 包，不生成安装器。随后直接运行当前未改接线的 `hub-build.sh`，仍会重新串行打包；不要将单独跑过基准当成已启用完整流程加速。

## 增量缓存与完整包

`tsc -b` 与基础 tsconfig 的增量选项已经启用，保留工作区、编译输出和 `.tsbuildinfo` 可以复用。一次打包的编译约占几十秒，提高编译并发不是当前最大收益点。

后续缓存优化优先考虑 `prepare-dsh.ts` 的临时 pnpm store，再考虑运行时解压树。缓存键需要覆盖发布文件、依赖解析结果、工具版本、目标平台以及品牌、Hub origin、版本等构建值；这些输入变化必须失效。不得复用错误地址或旧插件的产物。

开发验证使用源码或 win-unpacked；最终验收后从同一份应用目录生成 EXE/ZIP。Python ZIP 脚本目前逐文件串行压缩，ZIP 耗时另计。不要把嵌套阶段重复相加，也不要把某一阶段的大幅提速描述为完整安装包的同比例提速。

## 测量建议

记录完整构建各阶段（`build:official`、dsh npm 打包、profile 组装、electron-builder）的墙钟耗时，并在同一提交、同一构建输入下比较串行与并行两次运行的结果。阶段耗时之外还要比较产物：全部 tgz 的摘要、解包文件内容、权限与链接都应逐项一致，只比较包数不足以证明等价。测量结论以完整构建的那一次为准；单独的打包基准只说明该阶段的上限。
