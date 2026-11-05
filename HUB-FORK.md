# HUB-FORK.md

[English summary](#english-summary) | 中文

本仓库是 **DeepSeek Harness 桌面端（Electron）的第三方 fork**，以 **DSH Hub** 名义发布。

- 上游：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，本 fork 基于上游发布标签 `dsh-v0.2.1-rc.5`（2026-10-29）。
- 与深度求索公司（DeepSeek）**无关**：不是官方项目，未获其认可、赞助或背书；产品名不使用「DeepSeek Harness」全称，也不使用其官方标识。
- 用途：这套 fork 让桌面端成为 DSH Hub 生态里的一个客户端——登录 Hub、接收 Hub 下发的模型/插件/配置、把本机会话通过 Hub 通道转给手机端；不用 Hub 时也可以完全离线当本地 agent 用。

## 许可

| 范围 | 许可 | 版权人 |
| --- | --- | --- |
| 上游代码（本仓库全部历史） | MIT，见 [LICENSE](LICENSE) | `Copyright (c) 2026 DeepSeek` |
| 本 fork 的改动与新增文件 | MIT（同上条款） | `DSH Hub contributors` |

也就是说：本仓库整体按 MIT 发布，上游版权声明原样保留；我们新增/修改的部分同样以 MIT 授权，版权人写作 `DSH Hub contributors`。第三方材料各自保留其许可：

- 随包插件（见 [`apps/desktop/hub/bundled-plugins.json`](apps/desktop/hub/bundled-plugins.json)），共五个归档：
  - `dsh-better-sidebar` 0.28.0 —— 唯一的第三方插件，MIT，上游
    <https://github.com/omdsh-dev/DSH-better-sidebar>；归档内的 `package/LICENSE` 是
    `Copyright (c) 2026 dsh-external` 的 MIT 全文。
  - `@xdedmi/dsh-session-id` 1.0.0、`@local/dsh-memory` 0.1.3、`@local/dsh-claude-pilot` 0.6.0、
    `@local/dsh-codex-pilot` 0.4.1 —— 本项目自有的插件，以 **Apache-2.0** 授权（版权人
    `DSH Hub contributors`），四个归档各自带 `package/LICENSE`；`dsh-codex-pilot` 另有
    `package/NOTICE`（含 OpenAI Codex 的第三方声明）。这些归档由公开单仓 `dsh-hub` 的 `plugins/`
    重新打包，`bundled-plugins.json` 里的 `sha256` 与单仓源码一一对应。
- 字体 Montserrat：SIL Open Font License 1.1，随 `packages/client/ui-theme/src/styles/Montserrat-OFL.txt` 分发；品牌字样在 `apps/desktop/hub/brand/source.svg` 中以轮廓路径内嵌。
- 依赖清单与生成规则见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（该文件由脚本生成，勿手改）。

## 我们改了什么

以下按目录列出，全部改动都可以用 `git diff <upstream-commit>` 复现。上游原有的其它文件保持不动。

### `apps/desktop/hub/`（新增，Hub 构建专属）

| 路径 | 作用 |
| --- | --- |
| `branding.mjs` | 品牌与出网策略的唯一来源：产品名、公司名、appId、userData 目录名、`dsh://` 协议名、图标路径、关闭的上游端点。 |
| `brand/source.svg`、`brand/BRANDING.md`、`brand/preview.mjs`、`brand-alt/` | Windows 全部品牌图形的矢量源（应用图标、托盘、安装器 banner、卸载侧栏、欢迎页字样）与说明；`render-brand.mjs` 用 sharp 渲染成提交在仓库里的位图。 |
| `render-brand.mjs`、`brand-artboard.mjs`、`branding.d.mts` | 从矢量源切 artboard、替换主题 token、栅格化并写回 ICO/PNG/SVG。 |
| `icon-windows.png`、`icon-windows.ico`、`tray-windows.ico` | 渲染产物：应用图标与托盘图标。 |
| `audit-brand.mjs`、`brand-audit-allow.json` | 品牌审计：源码模式扫界面词典、产物模式扫打包后的 client bundle，任何用户可见字符串都不得出现上游产品名；允许的提法逐条登记在 allow 列表里。 |
| `bundled-models.json` | 桌面端默认模型快照（**示例**，route id 为占位）。 |
| `bundled-plugins.json`、`bundled-plugins/*.tgz` | 安装包随包的第三方插件声明与归档（含 SHA-256 与启用级别）。 |
| `pwsh-runtime.json`、`seed-runtime-cache.mjs` | 随包 PowerShell 7 的版本/摘要/镜像，以及主运行时下载缓存的镜像预取。 |
| `build-installer-windows.ps1`、`nsis-cross-package.mjs` | 在 Linux/WSL 上交叉构建 NSIS 安装包所需的三个 Windows 输入：MSVC 编译的安装界面、Windows 版 7-Zip、卸载器字节。 |
| `make-portable-zip.py` | 把 `win-unpacked` 打成免安装 zip（含中文使用说明）。 |
| `hub-plugin-client.mjs`、`hub-plugin-archive.ts` | 插件归档读取与 profile 侧插件客户端。 |
| `plugins/hub-brand/` | 把侧栏品牌位替换成 DSH Hub 的 cordis 插件（Host 半边 + 浏览器半边）。 |
| `plugins/hub-connector/` | Hub 连接器：登录、清单下发、模型路由、插件安装、通道（WebSocket 中继 / node-remote）、重启提示、搜索池。`vendor/` 里是公开单仓 `dsh-hub` 的 `@dsh-hub/dsh-node-remote@0.2.2` 归档。 |

### `apps/desktop/`（修改）

- **Hub 运行时**：`src/hub-environment.ts`（Windows 运行时环境：内置 CPython/PowerShell、代理投影）、`src/hub-plugins.ts`（随包插件安装）、`src/hub-overlay.ts`、`src/hub-restart.ts`、`src/branding.ts`、`src/welcome-api.ts`。
- **Windows 系统代理**：`src/windows-proxy.ts`、`src/windows-proxy-registry.ts`（把 WinINET 配置投影成 Host 与子进程的环境变量，只读不写注册表）。
- **外壳**：`src/main.ts`、`src/settings.ts`、`src/locale.ts`（含 `Powered by xdedmi` 署名）、`src/welcome-window.ts`、`src/client/WelcomePage.tsx`、`src/project-manager.ts`、`src/host-process.ts`、`src/capture.ts`、`src/tar-archive.ts`。
- **打包**：`scripts/electron-builder-config.mjs`、`scripts/package-target.ts`、`scripts/prepare-dsh.ts`、`scripts/prepare-runtime.ts`、`scripts/prepare-hub-runtime.ts`、`scripts/desktop-package-environment.mjs`、`scripts/desktop-release-environment.mjs`、`scripts/installer.nsh`、`installer/{pages,strings,theme}.nsh`、`installer/assets/*`（换成自有图形）、`renderer/assets/welcome-brand.svg`、`renderer/welcome.css`、`tsdown.config.ts`、`electron-builder.config.d.mts`。
- **文档**：`README.md`/`README.zh.md` 增加「Hub 构建」小节与离线模式说明；`packaging/README*` 增加打包性能说明的入口。
- **测试**：`tests/` 下新增 `hub-*.spec.ts`、`hub-connector/**`、`brand-assets.spec.ts`、`audit-brand.spec.ts`、`nsis-cross-package.spec.ts`、`powered-by.spec.ts`、`windows-proxy*.spec.ts`、`tar-archive.spec.ts` 等，并更新受品牌化影响的既有断言与 expected 快照。

### `apps/desktop-host/`

`src/hub-overlay.ts`（迁移旧版本写进 profile 的 `cordis.hub.patch.yml` 行）与对应测试。

### `packages/`

- `packages/client/ui-settings-account/`：账号卡片改成 Hub 账户/Hub 通道、离线进入工作区、Hub 重启行、`hub-channel.ts`、`hub-restart.ts`；首启插画改成自绘的工作区示意图（上游的官方产品截图与插画不再随包）。
- `packages/llm/llm-pi-ai/`：`src/managed.ts` 新增 `llmPiAiManaged` 受管模型路由服务，加载器按它组装 provider 行。
- `packages/llm/llm/src/types.ts`、`packages/bundle/base`、`packages/bundle/web-app`：受管路由与品牌行的组合补丁。
- `packages/client/*` 若干包：产品名、locale 文案与对应测试的品牌化调整。
- `packages/shell/pwsh-local/`：随包 PowerShell 的定位。

### 根目录与文档

- `hub-build.sh`：一条命令的 Windows 打包入口（`--installer` / `--portable` / `--check`）。
- `docs/upgrade-guide/v0.2.1-rc.5/hub-managed-model-routes/`：模型路由从 overlay 迁到受管集合的升级说明。
- 本文件 `HUB-FORK.md`，以及 `README.md` / `README.zh.md` 顶部的非官方声明。

## 构建 Windows 安装包 / 免安装包

### 前置

- Node.js `^22.19.0 || >=24.0.0`（本仓库的 `engines`），pnpm `11.28.5`（`packageManager` 固定，用 corepack 激活）。
- Linux/WSL 上交叉构建需要：`python3`（打包免安装 zip）、`bash`、`sha256sum`、`tar`。
- `--installer` 还需要一台 Windows：Windows PowerShell（WSL 里的 `powershell.exe`）＋ Visual Studio C++ 桌面工作负载与 Windows SDK（编译安装界面）、`wslpath`。其它环节不需要 Windows 机器，也不需要 Wine。

### 命令

```bash
./hub-build.sh                    # 只产出 win-unpacked 目录（未签名）
./hub-build.sh --portable         # 再打一个免安装 zip
./hub-build.sh --installer        # 产出 NSIS 安装包（从 WSL 调用 Windows 编译安装界面）
./hub-build.sh --check            # 只校验配置与工具链，不产出产物
```

产物在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` 下：
`win-unpacked/`、`DSH-Hub-<version>-win-x64-portable-unsigned.zip`、`DSH Hub Setup <version>.exe`；
脚本最后打印路径与 SHA-256。

第一次运行会：用 corepack 激活 pnpm、`pnpm install --frozen-lockfile`、准备主运行时、跑仓库构建（`build:official`）、electron-builder 打包，最后执行品牌审计与载荷断言（禁止随包分发 Claude Code / Codex 的可执行文件、校验随包插件摘要、校验连接器内嵌的 Hub origin）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HUB_ORIGIN` | 占位 `https://hub.example.com` | 烘进连接器 `build-info.json`、更新 feed、强制更新策略与 Hub 中转站地址的 HTTPS origin。**发布前必须改成你自己的 Hub**；设置成空字符串（`DSH_HUB_ORIGIN=`）则产出完全本地、不连任何 Hub 的构建。 |
| `DSH_HUB_CN_MIRRORS` | 未设置 | 设成 `1` 时把 npm registry、Electron/electron-builder 二进制、Node/Python/wheel/PowerShell 下载都走国内镜像（npmmirror、清华 TUNA）；每条下载仍按锁定摘要校验。 |
| `DSH_WINDOWS_POWERSHELL` | `powershell.exe` → WSL 标准路径 | `--installer` 用来调用 Windows 侧编译的 PowerShell 路径。 |
| `DSH_DESKTOP_APP_ID` | `tech.dshhub.desktop` | 反向域名应用 ID；首次运行 `hub-build.sh` 会把它写进（被 git 忽略的）`apps/desktop/.env.windows`。**二次分发请改成你自己的**。 |

### 交叉构建会下载什么

首次构建（含交叉构建）需要联网获取，均可通过环境变量换源：

1. npm 依赖（`pnpm install --frozen-lockfile`）。
2. Electron `44.7.0` 的 win32-x64 预编译包与 electron-builder 的二进制工具集（NSIS、winCodeSign、Windows 版 7-Zip），默认从 GitHub release 取；`DSH_HUB_CN_MIRRORS=1` 时改走 npmmirror。
3. 主运行时归档（`scripts/primary-runtime/lock.json` 锁定）：Windows 版 Node、独立 CPython、若干 wheel。
4. 随包 PowerShell 7.6.7（`apps/desktop/hub/pwsh-runtime.json`，含官方 origin 与镜像候选，按 SHA-256 校验）。

缓存写在仓库旁的 `.hub-build-cache/`（`XDG_*`、electron-builder 缓存与 pnpm store 都在里面），不写用户 home。`--installer` 的 Windows 侧编译产物写在 `apps/desktop/.desktop-build/targets/win-x64/installer-ui/`。

### 自定义品牌

- 产品名、公司名、版权行、appId、协议名：改 `apps/desktop/hub/branding.mjs` 一处即可。
- 图形：改 `apps/desktop/hub/brand/source.svg`，然后 `pnpm --filter @deepseek-ai/dsh-desktop run render:brand`；`brand/BRANDING.md` 记录了每个 artboard 对应的产物。
- 安装包/关于页不放「DeepSeek Harness」全称；`hub-build.sh` 结束时的品牌审计会把漏掉的用户可见字符串列出来（`hub/brand-audit-allow.json` 登记允许的提法）。

## 对接自己的 Hub

1. **设置 origin**：`DSH_HUB_ORIGIN=https://your-hub.example ./hub-build.sh --installer --portable`。构建会把这个 origin 写进连接器的 `build-info.json`，并派生出：
   - Hub 中转站的 provider `baseURL`：`<origin>/v1`；
   - 自动更新 feed：`<origin>/desktop/feeds/win-x64/`（`electron-updater` 的 generic provider 布局，按目标平台分目录）；
   - 强制更新策略的 origin 与允许页面来源：`<origin>`；
   - 连接器与 Hub 之间的清单、通道、插件下载、搜索池接口都在这个 origin 下。
2. **替换模型快照**：`apps/desktop/hub/bundled-models.json` 是示例（route id 是 `…@relay` 这类占位）。用你自己 Hub 导出的 `llm-pi-ai` 片段替换它——形状见 `apps/desktop/hub/plugins/hub-connector/README.md` 的「Bundled model snapshot」一节；连接器在收到清单下发的模型前先用它渲染设置页。
3. **随包插件（可选）**：把要随包分发的 npm 归档放进 `apps/desktop/hub/bundled-plugins/`，在 `bundled-plugins.json` 里声明 `package`、`version`、`file`、`sha256`、`level`（`core` 常开、`default`/`optional` 由用户决定）。本仓库默认带五个归档（见上表）；不要放含可执行文件的归档——`hub-build.sh` 的载荷断言会拒绝 `exe/dll/node/so/dylib`。
4. **不连 Hub 的构建**：`DSH_HUB_ORIGIN= ./hub-build.sh` 产出不发布任何 Hub 端点的构建，用户首次启动看欢迎页时可选「离线使用」直接进入本地工作区。
5. **已安装的客户端改地址**：账号页的「Hub 地址」一行可以查看当前生效的地址、改到别的 Hub，或恢复安装包内置的地址，不必重新构建。有效地址的优先级是：用户在账号页填写的地址 > 启动时的 `DSH_HUB_ORIGIN` > `build-info.json` 里烘进的值。换地址时若已登录，客户端会先退出当前账号（并向旧 Hub 吊销设备令牌）再写新地址，旧 Hub 的令牌不会发给新地址；旧 Hub 不可达时吊销最多等 5 秒，切换照常完成。这条路只改连接器使用的 Hub 地址：自动更新源、强制更新策略和随包模型快照仍是构建时的值，正式分发给用户仍建议用上面的方式重新构建。

## 与上游同步

本 fork 的改动集中在上面的目录里，尽量通过 import 上游已有的扩展点接入，而不是改上游逻辑：品牌取值走 `hub/branding.mjs`，界面文案走 locale 字典，插件走 cordis 插件位，模型走 `llm-pi-ai` 的受管服务。同步上游时按 `git diff <upstream-commit>` 看差异，冲突主要集中在 `apps/desktop/src/main.ts`、`scripts/` 下的打包脚本与 `packages/client/ui-settings-account`。

## English summary

This repository is an unofficial desktop fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.5 that ships as **DSH Hub**. It is not affiliated with, endorsed by, or sponsored by DeepSeek. The upstream code stays MIT (`Copyright (c) 2026 DeepSeek`); the fork's changes are MIT too, copyright `DSH Hub contributors`. The fork adds a Hub client (sign-in, manifest delivery, managed model routes, bundled plugins, mobile channel), a one-command Windows build (`./hub-build.sh`), and a brand layer (`apps/desktop/hub/`). Build with `DSH_HUB_ORIGIN=https://your-hub.example ./hub-build.sh --installer --portable`; an unset origin bakes the placeholder `https://hub.example.com` and an empty one builds a fully local app. See the Chinese sections above for the file-by-file list, the cross-build inputs, and how the update feed and model snapshot follow the origin. An installed client can also be pointed at another Hub from its account page (Settings → Account → Hub address) without rebuilding, and the order of precedence is the address the user typed, then `DSH_HUB_ORIGIN`, then `build-info.json`; that path changes only the connector's origin — the update feed, the mandatory-update policy, and the bundled model snapshot stay build-time values, so distributing to users still calls for a rebuild.
