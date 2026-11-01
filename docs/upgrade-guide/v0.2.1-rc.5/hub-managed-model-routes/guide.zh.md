---
kind: upgrade-guide
description: "DSH Hub 桌面端把模型路由从 Hub overlay 移到适配器受管集合，让设置页能保存个人渠道。"
---

# Hub 模型路由移出 `cordis.hub.patch.yml`

[English](guide.md) | 中文

## 变更

DSH Hub 桌面端此前把 Hub 的模型路由作为整块 `llm-pi-ai` 行写进 `<profile>/cordis.hub.patch.yml`，Host 把它当作最后一层 `--patch`。这一行压过 profile patch，因此设置 → 模型里保存个人渠道会失败（`Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`），保存的默认模型也可能被同一 overlay 覆盖。

本次改为经适配器的 `llmPiAiManaged` 服务注册下发的路由，并把它保存在 `<profile>/desktop-hub/state.json` 的 `managedModels` 里。Hub 模型仍通过 Hub 中转；个人渠道直连自己的端点、使用本地凭据。`agent-default-model` 也移出 overlay，默认选择从此由 `cordis.patch.yml` 持有。受影响者：使用 Hub 下发模型的桌面端用户，以及依赖 `cordis.hub.patch.yml` 中 `llm-pi-ai` / `agent-default-model` 两行的工具。

## 迁移

1. 安装或解压新版本并启动一次。Host 在组合 profile 之前把两行移出 `cordis.hub.patch.yml`，其它行与 `hubProxy` 保留块原样保留，旧文件存为 `cordis.hub.patch.yml.bak-<时间戳>`。不需要手工修改；再次启动不会重复处理。
2. 在 profile 里确认：`cordis.hub.patch.yml` 不再包含 `- id: llm-pi-ai` 或 `- id: agent-default-model`，`desktop-hub/state.json` 里有带 `origin`、`deviceId` 的 `managedModels`。
3. 打开设置 → 模型：Hub 提供商显示「Hub 提供」标签且没有编辑/删除；个人提供商保留两者，新增的自定义 API 能保存并从自己的端点服务。
4. 如果个人渠道已经占用 Hub 现在下发的 route id，Hub 更新会被拒绝（`applyState: partial`、`applyErrorCode: config_write_failed`），账号卡写明冲突。给个人渠道改名后，下一次清单拉取会重试同一 revision，不必等运维再发版本。
5. 回退：退出应用，把最新的 `cordis.hub.patch.yml.bak-*` 覆盖回 `cordis.hub.patch.yml`，并从 `desktop-hub/state.json` 删除 `managedModels`。旧客户端会重新拥有模型行；个人渠道仍留在 `cordis.patch.yml`，但会被恢复的 overlay 遮住。
