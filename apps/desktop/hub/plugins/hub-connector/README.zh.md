# @dsh-hub/hub-connector

[English](README.md) | 中文

桌面端的 Hub 连接器：提供账号服务、设备身份与上报、清单应用器，以及 Claude Code 与 Codex 两个 pilot 消费的 `hubAgentModes` 服务。

安装器把它作为 profile 核心插件随包装入，因此它从不由 Hub 下发，也从不被 Hub 卸载。

## 启动顺序

`apply` 等组合稳定下来，然后调用 `HubConnector.start()`：

1. **安装器随包的插件**（见下文）—— 在任何账号存在之前。
2. agent-mode 缓存，然后是已保存的设备授权。没有授权时本次运行到此为止：设备等待登录，各个循环在 `hub-connector/signed-in` 事件上启动。
3. 有授权时：账号相关循环、托管模型集合、一次上报、一次清单拉取 —— 即登录同步轮。它在后台依赖遍历完成之后结束，连接器把结束时间记进自己的状态文件。之后上报按 Hub 要求的间隔重复；只要 Hub 的回答点名了更新的 revision，就再拉一次清单。

## Hub 模型路由

Hub 的模型配置从不进入 `cordis.hub.patch.yml`。它是一个托管的 provider 集合：下发的 `llm-pi-ai` 与 `agent-default-model` 片段被抽出来，持久化成 `state.json` 里的 `managedModels`，再通过适配器的 `llmPiAiManaged` 服务注册。overlay 的优先级高于 profile patch，所以放在那里的模型行会让每一次个人 provider 修改看起来都被覆盖；把路由注册进适配器之后，Hub 模型和用户自己的路由并存，只有用户那一段由 Models 页面写入。

只有当适配器接受时，一个集合才会被采用：替换内容先做校验，并和用户的路由及其它贡献者比对，然后才动任何东西。被拒绝的下发保留上一个集合与用户的配置继续服务，以部分应用的方式上报 `config_write_failed`，并把原因放到账号卡片上。登出会撤回这些路由，但保留已持久化的集合，所以下次登录时它会在 Hub 可达之前先恢复；个人路由从不被触碰。下发的路由与模型 id 保持原样，因为旧会话还要引用它们。

清单里的 `needsRestart` 是「某个改动确实发生了」的激活条件：只有本轮成功的安装、升级、开关或移除，或者插件管理器报 `restart-required` 时，应用器才提出重启。重放一份插件都已就位的清单不会提出任何东西。

在升级过的安装上，桌面 Host 在组合 profile 之前会跑 `migrateHubOverlayModels`：两行模型从 overlay 里移出，内容暂存到 `desktop-hub/legacy-models.json`，连接器导入一次后删掉该文件。其余每一行、文件头以及保留的代理块逐字节不变；重复执行不改变任何东西，迁移读不了的文件会被上报并原样留下。

## 重启提示

应用清单会重写 `cordis.hub.patch.yml`，Host 在组合 profile 时把它当最后一层 patch 读取。因此，改变 overlay 的下发、安装声明了 `needsRestart` 的插件、或者留下未完成的移除，都要到下次启动才生效，而连接器无法重启应用。它改为记录这个需要：`state.json` 增加 `restart`（原因、时间戳，以及写下它的 Host 进程）与 `syncedAt`（产生它的那一轮的结束时间）。

桌面外壳读取该文件，在这一轮稳定后提示重启并执行它 —— 包括重启所需的任务检查与请求排空。更早的 Host 进程写下的记录会在下次启动时丢弃，因为那次启动就是它要求的重启；登出也会丢弃它，因为它点名的 overlay 已经没了。账号卡片可以通过 `POST /hub-connector/api/restart` 直接请求重启，该接口在同一个记录上打 `requestedAt`。

生成模型路由和搜索行本身从不提出这条提示：模型集合是实时注册的，搜索行则在下次启动时进入组合，不需要询问用户。

## 手机访问

让用户的手机连到这台电脑的开关属于这台机器，所以它放在这个包里：它连接时用的设备令牌就是连接器已经持有的账号授权。

- **不问不开。** `<profile>/desktop-hub/channel.json` 只保存开关和它是为哪个账号打开的，别的什么都不存。文件缺失、读不了或者版本更旧都按关闭处理，没有绑定的开关也按关闭处理。关闭会关掉 socket；它不会先连上再拒绝。
- **绑定单个账号。** 记录里有 Hub 节点 id、Hub 用户名和 Hub origin。点名了不同设备、用户名或 origin 的授权会替换绑定并让开关保持关闭；登出会清掉绑定并关闭开关，因此下一个账号无法继承上一个账号的同意。
- **一条出站 socket。** `src/channel/lifecycle.ts` 最多持有一条连接，并用带抖动的指数退避重试（1s → 30s）。开关关闭或账号未绑定时它不打开任何东西，并且丢弃被取代的那次尝试发出的 close 事件。在这一层帧保持不透明：`attachFrames` 是手机协议接入的接缝。
- **本地无地址、本地无凭据。** 传输层用设备令牌到达 Hub origin；这里没有任何东西去连 Host，令牌也从不进入渲染进程、日志行或状态路由。profile 里没有 `ws` 的 Host 会报 `failed/transport-unavailable`，连接器的其余部分照常服务。
- **状态接口。** `GET /hub-connector/api/channel` 报告开关、阶段（`off`、`waiting-sign-in`、`connecting`、`online`、`retry`、`failed`）、绑定账号、节点 id、连接时间、尝试次数与下次重试。带 `{enabled}` 的 `POST` 改变开关；`GET /hub-connector/api/state` 在 `channel` 下携带同一个对象，这样账号卡片一次就能读完。

## 随包插件

`apps/desktop/hub/bundled-plugins.json` 声明每个安装都携带的第三方插件（`package`、`version`、`file`、`sha256`、`level`）。打包步骤把每个归档拷到该清单旁边，放进 `resources/runtime/hub-plugins/`，外壳再把这个目录作为 `DSH_HUB_BUNDLED_DIR` 交给 Host。

**外壳**在 Host 启动之前安装它们（`apps/desktop/src/hub-plugins.ts` 里的 `activateBundledThirdPartyPlugins`）：第一次启动就必须已经在跑每一个随包插件，而从运行中的 Host 里安装会为每个包重载一次组合，那会让后面的包装上了却没有加载。外壳校验每个归档的摘要、把它解到 profile、记录 `file:` 依赖并启用该 bundle。

连接器随后在每次启动时把声明与 profile 比对：

- 已安装版本相同 → 记录 `source: 'bundled'` 并上报；
- 不存在，或随包版本更高 → 退回通过插件管理器安装（`file:` spec 暂存在 `<profile>/desktop-hub/bundled/`），这样外壳还没见过的 profile 也能收敛；
- 已安装版本更高 → 不动 profile；
- `level: 'core'` 保持启用；`default`/`optional` 的可以由用户停用；
- 点名该包的清单优先于基线：按它的版本安装、应用它的启用标记，它的 `uninstall` 条目会在之后的启动里把该包挡在基线之外（记在 `desktop-hub/state.json` 的 `bundledRemovals` 里）。之后更新的清单再次点名该包时，会从 Hub 装它；
- 点名版本低于已安装随包版本的清单不降级：记录保留已安装的版本并标 `source: 'bundled'`，上报里也这么说。

登录与否无关：归档都在本地，所以一台永远连不上 Hub 的设备照样有它的基线插件。

## 随包模型快照

`apps/desktop/hub/bundled-models.json` 是 Hub 自己给桌面默认预设准备的 `llm-pi-ai` 片段，去掉每台设备各自的成员（`baseURL`、`apiKeyEnv`），加上 `agentDefaultModel`（`schemaVersion: 2`；Hub 为它服务的设备导出这一份）。本仓库里的文件是 route id 用占位的示例；发布前用你自己 Hub 的导出替换它（见 `HUB-FORK.md`）。模型 id 是中转站 route id（`<model>@<channel>`）；文件里不含密钥、令牌或端点。

当清单还没有下发 `llm-pi-ai` 片段时，连接器用设备自己的中转站密钥请求 `GET /v1/models`，并且只渲染这台设备能到达的模型：空 provider 消失，`baseURL` 变成 `<hubOrigin>/v1`，`apiKeyEnv` 仍是 `HUB_MK_HUB` 引用，provider 的其它成员（展示文案、`api`、思考档位、模型参数、`compat`）原样带过。默认选择是 `agentDefaultModel`（当它的 provider 和模型都还在），否则是渲染出的第一个模型及其 provider 的思考档位。下发的 `llm-pi-ai` 片段会替换生成的集合。两者都不写入 overlay；它们都成为上文所述的托管 provider 集合。推荐默认值只在用户什么都没选时才保存，因此个人的选择能挺过每次同步与重启。版本 1 的扁平示例布局仍然按一个 `hub` provider 读取。

## 连接器自己维护的文件

| 路径 | 内容 |
|---|---|
| `<profile>/cordis.hub.patch.yml` | 桌面 Host 最后应用的 overlay：下发的非模型片段、搜索行、代理块 |
| `<profile>/desktop-hub/state.json` | 设置、服务端签发的设备 id、应用记录、托管插件记录、Hub 模型集合（`managedModels`）、待移除项、随包移除项、最近一次上报的请求体、带同步轮次的待重启记录 |
| `<profile>/desktop-hub/legacy-models.json` | 升级后的 Host 从旧 overlay 里移出的模型行；导入一次后删除 |
| `<profile>/desktop-hub/cache/<sha256>/` | 已校验的清单归档（保留最新四份） |
| `<profile>/desktop-hub/bundled/` | 安装器插件归档的暂存副本 |

这些文件里都不写凭据：设备令牌、中转站密钥与 agent-mode 密钥存在凭据库里。
