# @dsh-hub/hub-brand

[English](README.md) | 中文

DSH Hub 在 Web 客户端侧栏品牌槽位里的占位实现。

上游把 `sidebar.brand.mark` 与 `sidebar.brand.name` 两个槽位交给官方 DeepSeek Harness 的占位组件
（`@deepseek-ai/dsh-client-ui-brand-official`）。Hub 桌面要显示自己的产品名，所以这个 bundle 层把
那一行 `disable`，在同样两个槽位里注册 DSH Hub 的标记与名称——槽位本身就是上游侧栏的扩展点。

- **Host 半边**（`src/index.ts`）：空的 `apply`；这一行存在是为了让包进入 profile 组合，客户端的
  bundle 才能进入开机模块图。
- **浏览器半边**（`client/index.js`）：按模块表工厂约定注册槽位占位组件。`prepare:hub-runtime`
  把它包裹成 `lib/client.js`，并填两个占位符：`@@PRODUCT_NAME@@` 取自
  `apps/desktop/hub/branding.mjs`，`@@MARK_URL@@` 取自
  `apps/desktop/hub/brand/source.svg` 的 `icon-small` 画板（base64 SVG data URL），
  所以侧栏标记与窗口图标是同一张图。

标记与窗口图标、托盘保持一致；名称是侧栏那一行（18 px/600）里的文本，随主题色走，不需要第二份图。
「新会话」首屏的标题前也是这块标记：上游在那里回退到动画鲸鱼，Hub 构建同样不能出现官方标识，
所以这个槽位也在本插件里注册，但它是别的包声明的槽位，必须单独 `ctx.slots.inject` 等声明。
