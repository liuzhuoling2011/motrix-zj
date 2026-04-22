# 内置 WebView 登录与 Cookie 自动注入设计文档

## 概述

在 Motrix ZJ 左侧 AsideBar 新建任务按钮下方增加 Web 图标入口，点击打开一个独立的 Tauri WebView 窗口。用户在该窗口中登录视频站点（YouTube / Bilibili / 爱奇艺 等），浏览到目标视频后点击"下载视频"按钮：后端从 WebView 提取当前 cookie jar，按 domain 切片序列化为 Netscape `cookies.txt` 持久化到本地，并触发主窗口的 AddTask 模态框并预填 URL。后续通过 yt-dlp 下载时，后端自动按 URL domain 匹配已保存的 cookies.txt 并透明注入 `--cookies` 参数。

目标：彻底绕开 Windows Chrome v127+ App-Bound Encryption 导致 `--cookies-from-browser chrome` 失效的问题，用内置浏览器实现"一次登录、处处可用"。

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| WebView 嵌入方式 | 独立 Tauri WebviewWindow | MVP 最快；后续可升级为主窗内 child webview |
| 首页形态 | 自制站点导航网格 | 对国内用户一键直达主流站点 |
| Cookie 提取时机 | 用户点击"下载视频"按钮 | 隐藏"保存 cookie"的技术动作，用户心智只有"下载视频" |
| Cookie 存储格式 | Netscape `cookies.txt`，按 domain 一个文件 | yt-dlp 原生可读，无需额外序列化层 |
| Cookie 使用策略 | 新建任务时按 URL host 自动匹配 | 用户无感；手动粘贴 cookie 优先级更高 |
| 新建任务入口 | 复用主窗 AddTask 模态框 | 保留所有高级选项，零 UX 冗余 |
| WebView 窗口生命周期 | "下载视频"后不关闭 | 用户继续浏览下一个视频，免重复登录 |

## 前端架构

### AsideBar 入口

`src/components/layout/AsideBar.vue` 在新建任务按钮（`AddCircleOutline`）下方新增一个按钮：

- 图标：`GlobeOutline`（`@vicons/ionicons5`）
- 提示文案：`打开浏览器登录 / Open Browser Login`（i18n key `aside.open-web`）
- 点击：`invoke('open_web_browser')` → 后端创建 WebviewWindow

### WebView 窗口

独立 Tauri `WebviewWindow`，label 固定为 `web-browser`（唯一实例），约 1200×800 居中。

窗口内容由一个 Vue 视图渲染（新增路由 `/web-browser` 或独立的 `index.web.html`）。结构：

```
┌──────────────────────────────────────────────────────────┐
│ [←][→][↻][🏠] [URL_____________________] [下载视频]       │  Toolbar
├──────────────────────────────────────────────────────────┤
│                                                          │
│       ┌──Nav──┐ ┌──Nav──┐ ┌──Nav──┐                      │
│       │ B站   │ │ 优酷  │ │ 爱奇艺 │                      │  Home (导航页)
│       └───────┘ └───────┘ └───────┘                      │
│       ┌──Nav──┐ ┌──Nav──┐ ┌──Nav──┐                      │
│       │ 腾讯  │ │ 芒果  │ │ YT    │                      │
│       └───────┘ └───────┘ └───────┘                      │
│                                                          │
│  或：真实 webview 渲染所选站点                              │
└──────────────────────────────────────────────────────────┘
```

#### 新增组件
- `src/views/WebBrowserView.vue`：窗口根视图，整合 Toolbar + Body
- `src/components/web/WebToolbar.vue`：顶部工具栏，事件暴露给父视图
- `src/components/web/SiteGrid.vue`：导航页的站点卡片网格

#### 站点清单
固定 6 个卡片（按顺序）：

| 名称 | URL | 图标来源 |
|------|-----|---------|
| Bilibili | https://www.bilibili.com | `/assets/sites/bilibili.svg` |
| 优酷 | https://www.youku.com | `/assets/sites/youku.svg` |
| 爱奇艺 | https://www.iqiyi.com | `/assets/sites/iqiyi.svg` |
| 腾讯视频 | https://v.qq.com | `/assets/sites/tencent.svg` |
| 芒果 TV | https://www.mgtv.com | `/assets/sites/mgtv.svg` |
| YouTube | https://www.youtube.com | `/assets/sites/youtube.svg` |

#### URL 导航实现
WebView 窗口本身就是 Tauri 的 webview，导航通过 `window.location.href = url` 或 Tauri `Webview::navigate()` 命令。**但**：WebView 窗口顶部工具栏必须"永远显示"，不能被站点页面污染。实现方式：

- 方案 A：单 webview，工具栏用 `position: fixed` 覆盖顶部，body 的 webview 实际上就是当前文档（整个 WebView 窗口就是一个 HTML 页面，点击卡片后 `navigate()` 会替换整个页面——这会丢工具栏）→ **不可行**
- 方案 B：WebView 窗口根 HTML 内用 `<iframe>` 嵌入站点——**不可行**，YouTube / B 站等均禁止 iframe
- 方案 C：**Tauri 2 multi-webview** —— WebView 窗口包含两个 `Webview`：
  - `web-browser-toolbar`（label）：固定高度 48px，渲染工具栏 Vue 应用
  - `web-browser-content`（label）：占满剩余空间，承载实际站点
  - 两者独立 cookie jar，互不干扰

**选择方案 C**。这实质上是 MVP 里必须用到的 multi-webview 模式；和"升级到主窗右侧嵌入"未来迭代复用同一套 API。

#### Toolbar 与 Content Webview 的双向同步

工具栏渲染在独立 webview，与内容 webview 不共享 JavaScript context。URL 地址栏、前进/后退按钮状态需要跟内容 webview 的真实状态同步。机制：

- **工具栏 → 内容**：点击后退/前进/刷新/回首页/输入新 URL 时，工具栏 webview invoke 后端命令：
  ```rust
  #[tauri::command]
  pub fn web_browser_navigate(app: AppHandle, action: NavAction) -> Result<(), String>;
  // NavAction: Back / Forward / Reload / Home / Load(url: String)
  ```
  后端取 `web-browser-content` webview 调用相应 API（`go_back` / `go_forward` / `reload` / `navigate(url)`）。
- **内容 → 工具栏**：Tauri 的 `on_navigation` / `on_page_load` 回调在后端监听内容 webview 的 URL 变化，`app.emit_to("web-browser-toolbar", "url-changed", { url, can_go_back, can_go_forward })`。工具栏 webview 监听后更新地址栏和按钮状态。
- **"下载视频"按钮的当前 URL**：工具栏收到 `url-changed` 后缓存最新 URL，点击时把该 URL 作为参数传给 `save_cookies_and_trigger_download`。

### 主窗 AddTask 接收端

`src/layouts/MainLayout.vue` 新增 Tauri event 监听：

```ts
listen<{ url: string }>('add-task-from-web', async ({ payload }) => {
  await appWindow.show()
  await appWindow.setFocus()
  addTaskDialogRef.value?.open({ url: payload.url })
})
```

AddTask 组件已有 URL 预填能力（现有的 magnet/uri 流程），此处复用。

## 后端架构（Rust）

### 新增模块 `src-tauri/src/commands/web_browser.rs`

```rust
/// 打开 WebView 窗口（或聚焦已存在的实例）
#[tauri::command]
pub async fn open_web_browser(app: tauri::AppHandle) -> Result<(), String>;

/// 读取 WebView 当前 cookie jar,按 domain 切片落盘,emit add-task-from-web
#[tauri::command]
pub async fn save_cookies_and_trigger_download(
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String>;
```

### 新增模块 `src-tauri/src/cookies/`

```
cookies/
├── mod.rs          // 模块入口
├── store.rs        // CookieStore: 读写 $APP_DATA/cookies/<domain>.txt
├── netscape.rs     // Netscape cookies.txt 序列化 / 解析
└── match.rs        // URL → 已保存 cookies 的 domain 匹配算法
```

#### CookieStore

```rust
pub struct CookieStore {
    base_dir: PathBuf,  // $APP_DATA/cookies/
}

impl CookieStore {
    /// 按 domain 分组写入多个文件。返回实际写入的 domain 列表。
    pub fn save_from_webview(
        &self,
        cookies: Vec<tauri::webview::Cookie>,
    ) -> Result<Vec<String>, io::Error>;

    /// 按 URL host 查找最匹配的 cookies.txt 路径。
    /// 匹配顺序: www.X.com.txt → X.com.txt。命中返回绝对路径，未命中 None。
    pub fn resolve_for_url(&self, url: &str) -> Option<PathBuf>;
}
```

#### Domain 切片算法

登录 YouTube 产生的 webview cookies 可能跨 `.youtube.com` / `.google.com` / `accounts.google.com` 等多个 scope。按每个 cookie 的 `domain` 字段分组，每组落一个 `.txt`：

```
$APP_DATA/cookies/
├── .youtube.com.txt
├── .google.com.txt
└── accounts.google.com.txt
```

文件名规则：直接使用 cookie 的 `domain` 值（含前导点 `.`）。

### yt-dlp 端自动注入

`src-tauri/src/ytdlp/client.rs` 的 `YtdlpHeaders::resolve_args` 现有分支：

```rust
if cookies_from_browser.is_some() { ... }
else if cookie.is_some() { ... }
```

新增一个**最低优先级**分支：

```rust
else if let Some(path) = cookie_store.resolve_for_url(target_url) {
    args.push("--cookies".to_string());
    args.push(path.to_string_lossy().into_owned());
}
```

优先级（高→低）：
1. `cookies_from_browser`（用户显式选了浏览器）
2. `cookie`（用户手动粘贴的 cookie 字符串）
3. 自动匹配的 `$APP_DATA/cookies/<domain>.txt`

### WebView Cookies 提取 API

Tauri 2 在 multi-webview 下每个 `Webview` 持有独立的 cookie jar，`Webview::cookies()` 返回该 webview 可见的 `Vec<Cookie>`（name / value / domain / path / expires / secure / httponly 等）。三平台（macOS / Windows / Linux）均支持。提取对象固定为**内容 webview**（label `web-browser-content`），工具栏 webview 的 cookies 与用户无关忽略。命令实现：

```rust
let content = app
    .get_webview("web-browser-content")
    .ok_or("content webview not available")?;
let cookies = content.cookies().map_err(|e| e.to_string())?;
let store = CookieStore::new(&app_data_dir(&app)?);
let saved_domains = store.save_from_webview(cookies).map_err(...)?;
log::info!("saved cookies for {} domains", saved_domains.len());

app.emit("add-task-from-web", json!({ "url": url }))?;
Ok(())
```

## 数据流

```
┌────────────┐   1. click Web icon    ┌───────────────┐
│  AsideBar  │──────────────────────→│ open_web_browser
└────────────┘                        │      (Rust)    │
                                      └───────┬────────┘
                                              │ create WebviewWindow
                                              ↓
                               ┌─────────────────────────────┐
                               │  WebView Window (label=web-browser)
                               │  ┌──Toolbar webview──┐     │
                               │  │ URL / 下载视频 btn │     │
                               │  └───────────────────┘     │
                               │  ┌──Content webview──┐     │
                               │  │ (SiteGrid or site)│     │
                               │  └───────────────────┘     │
                               └─────────────────────────────┘
                                              │
                                    user navigates / logs in
                                              │
                           click "下载视频" (current URL X)
                                              ↓
                 ┌────────────────────────────────────────────┐
                 │ save_cookies_and_trigger_download(url=X)    │
                 │ 1. WebviewWindow::cookies()                 │
                 │ 2. CookieStore::save_from_webview(...)      │
                 │ 3. emit "add-task-from-web" { url: X }      │
                 └────────────────────────────────────────────┘
                                              │
                           MainLayout listener fires
                                              ↓
                 appWindow.show() + AddTask.open({ url: X })

                (WebView window stays open for next video)

─────────── 后续下载时 ───────────

user confirms AddTask → ytdlp_parse_url / ytdlp_download_*
         ↓
YtdlpHeaders::resolve_args(url=X):
    no cookie / cookies_from_browser
    → CookieStore::resolve_for_url(X)
    → match $APP_DATA/cookies/.youtube.com.txt
    → append `--cookies <path>`
```

## 错误处理

| 场景 | 行为 |
|------|------|
| `open_web_browser` 已有同 label 窗口 | 不重复创建，直接 `set_focus()` |
| WebView 内 JS 请求无 `current_url` | 前端保护，按钮应为 disabled（仅 http/https 启用） |
| `cookies()` 调用失败（平台不支持或内部错误） | `save_cookies_and_trigger_download` 返回 Err；前端 toast 错误；仍 emit event 触发 AddTask（无 cookies 也能手动粘贴） |
| 落盘 IO 失败 | toast 错误；不阻塞 AddTask 流程 |
| 下载时 cookies 已过期（yt-dlp 返回 `ERROR: Unable to extract`） | yt-dlp 报错原样返回前端，`AddTask` 中展示一条 banner："登录可能已过期"+ 一个"打开浏览器登录"快捷按钮 |
| WebView 窗口被用户关闭后重新打开 | 重新创建窗口；磁盘 cookies 仍然可用 |
| 主窗被藏在托盘（lightweight 模式 destroyed） | `appWindow.show()` 会重建主窗；成本可接受 |

## Tauri Capabilities

`src-tauri/capabilities/default.json` 的 `windows` 字段目前只含 `"main"`。需要：

- 新建 `src-tauri/capabilities/web-browser.json`，`windows: ["web-browser"]`，赋予 webview、shell 执行、log 等必要权限
- 主窗 capability 新增 `webview:allow-cookies`（或等价权限）以允许后端 `cookies()` 调用

## MVP 范围（YAGNI）

**做**：
- AsideBar Web 图标入口
- 独立 WebView 窗口（multi-webview：工具栏 + 内容）
- 自制导航页（6 个站点卡片）
- 工具栏：后退 / 前进 / 刷新 / 回首页 / URL 地址栏 / "下载视频"按钮
- Cookie 提取（按 domain 切片写 Netscape txt）
- `CookieStore` 读写
- yt-dlp `--cookies` 自动注入
- 主窗 `add-task-from-web` event 监听 + AddTask 预填 URL
- 登录过期错误 banner + 快捷打开浏览器

**不做**（后续迭代）：
- 主窗右侧 child webview 嵌入（从独立窗升级）
- 多标签页 / 书签 / 历史
- Cookie 管理 UI（查看 / 删除 / 导出已保存登录）
- 多账号（同一站点 A/B 账号切换）
- 自动检测 cookie 过期（无需等到下载时才发现）
- 手动粘贴 cookie 与自动 cookies 的合并
- 自动浏览 YouTube 播放列表 → 批量识别 → 批量下载

## 测试策略

- **cookies/netscape.rs**：单元测试序列化/反序列化往返一致性
- **cookies/store.rs**：单元测试多 domain 写、单 domain 覆盖、匹配顺序
- **cookies/match.rs**：`www.X.com` / `X.com` / `youtu.be → youtube.com 别名`（阶段可选）三种匹配 case
- **yt-dlp 集成**：在 `ytdlp::client` 层的单元测试 mock `CookieStore` 验证 `--cookies` 参数正确注入
- **前端**：`WebToolbar.vue` / `SiteGrid.vue` 基础渲染和点击 emit 单测
- **E2E / 手测**：
  - macOS aarch64 下打开 WebView 登录 YouTube → 点"下载视频" → 主窗 AddTask 弹出 → 下载成功
  - 同样流程测 Bilibili
  - 登录过期场景手测：删除磁盘 cookies 后点下载，观察 banner 是否出现

## 风险与开放问题

1. **Tauri 2 multi-webview API 成熟度**：目前是可用状态但文档偏少，实施阶段可能需要踩坑。备选方案：先做成单 webview + 工具栏覆盖层（用 `injectScript` 方式在每个站点页面注入固定工具栏 DOM），但可靠性差。
2. **Cookie 域名匹配边界**：如 `youtu.be` 短链对应 `.youtube.com` cookies，MVP 暂不处理这种别名映射，用户输入短链可能落空。可在 `CookieStore::resolve_for_url` 预留 alias 表，MVP 不填数据。
3. **WebView 窗口退出后 cookie jar 持久化**：Tauri 默认 WebView 的 cookie jar 是否随窗口销毁而清空、下次打开能否续用？需要实施时实测。若不持久则用户每次打开都要重新登录（可接受但需提示）。
