# 内部浏览器与下载流程六项问题修复 — 设计

日期：2026-04-26
状态：用户已批准（"4 ok 6 ok"）

## 背景

Motrix-Next 的内部浏览器面板（`InternalBrowserPanel.vue` + `web_browser.rs`）以 iframe 形式嵌入主窗口右侧，配合 yt-dlp 视频下载流程使用。当前存在六个交互/兼容性问题。

## 问题与修复

### 1. 切换任务列表/设置 tab 时未隐藏内部浏览器
**根因**：路由切换不联动浏览器面板可见状态。
**修复**：`MainLayout.vue` 监听 `route.path`；当路径变化（即用户主动导航）且 `webPanelOpen=true`，调用 `toggle_web_panel({open:false})`。点击 globe 图标本身不切路由，不会被误关。

### 2. 浏览器顶部无法拖动主窗口
**根因**：Windows 上面板 `padding-top: 36px` 仅占位，没有 `data-tauri-drag-region`。
**修复**：在 `InternalBrowserPanel.vue` 顶部渲染显式的 `<div class="drag-strip" data-tauri-drag-region>`（仅 Windows，36px 高）；同时给 `.browser-toolbar` 容器加 `data-tauri-drag-region`（按钮自身没有该属性，照常点击）。

### 3. 解析媒体按钮 loading 状态 + 提交时仍在解析的处理
**根因**：`AddTask.handleSubmit` 在 `isFromWebPanel` 分支里如果 `isParsing` 为真就**跳过**等待，立即调用 `submitVideoBranch`，结果 `isVideo/isPlaylist` 都是 false，提示「视频解析失败」。
**修复**：
- 新增 `waitForParseDone()`：通过 `watch(isParsing, ...)` 等到解析结束。
- `handleSubmit` 进入 web 面板分支时：
  - `isParsing` → 等待。
  - 否则若没结果 → 调用 `handleParseMedia()`。
  - 完成后再调 `submitVideoBranch`。
- 「解析媒体」按钮已有 `:loading="isParsing"`；为了让提交按钮在等待期间也清晰可见，把提交按钮文案在 `isFromWebPanel && isParsing` 时改为「正在解析…」。

### 4. 提交后内部浏览器重置回首页
**根因**：`MainLayout.vue` 中
```html
<div v-if="webPanelOpen && !isPanelSuspended" ...>
  <InternalBrowserPanel ... />
</div>
```
弹出 AddTask 时 `isPanelSuspended=true` → 组件卸载 → `currentUrl/historyStack` 全丢。重新挂载时回到 SiteGrid 首页。
**修复**：去掉 v-if 中的 `!isPanelSuspended`。`effectivePanelWidth` 在挂起时已经返回 0；placeholder 宽度为 0，自然不可见。iframe 是普通 DOM，不会像原生 webview 那样压住 modal，所以挂起逻辑此处多余。
> 注：Rust 侧 `suspend_web_panel` 调用保留（一些场景未来若改回原生 webview 仍需要），但 DOM 不再随之卸载。

### 5. yt-dlp 任务日志中文乱码
**根因**：虽然 `downloader.rs` 已设 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`，但 PyInstaller 打包的 `motrixnext-ytdlp.exe` 在 `[download] Destination:`、`[Merger] Merging formats into "..."` 等行的文件名仍可能以 GBK 字节流出（已存在一个针对此情况的兜底测试 `completion_history_name_falls_back_when_destination_is_mojibake`）。`String::from_utf8_lossy` 把非 UTF-8 字节替换为 `\u{FFFD}`，UI 看到 `���`。
**修复**：
- Cargo.toml 新增 `encoding_rs = "0.8"`。
- 新建 `src-tauri/src/ytdlp/encoding.rs`，导出 `decode_subprocess_line(bytes) -> String`：先 `String::from_utf8`；包含替换符则用 `encoding_rs::GBK.decode` 重试，无错则返回，否则回到 lossy。
- `downloader.rs` 的 `CommandEvent::Stdout(line)` / `CommandEvent::Stderr(line)` 改为调用该解码器。
- 单元测试：纯 ASCII / 纯 UTF-8 中文 / GBK 中文 / 混合 invalid bytes 四个用例。

### 6. B 站视频 URL 无法在内部浏览器播放
**根因**：`bilibili.com` 全站 `X-Frame-Options: DENY` + 严格 CSP，iframe 加载白屏。
**修复（务实方案）**：
- 新建 `src/web/embedTransform.ts`，导出 `transformEmbedUrl(rawUrl: string)`：
  - `https://www.bilibili.com/video/BVxxx[/...]` → `https://player.bilibili.com/player.html?bvid=BVxxx&high_quality=1&autoplay=0`（B 站官方 player，允许 iframe）。
  - 其他 URL 原样返回。
- `InternalBrowserPanel.vue` 的 `navigate()`：
  - `currentUrl` 仍存原始 URL（地址栏显示、下载按钮使用）。
  - `frameSrc` 用 `transformEmbedUrl(normalizedUrl)`。
- 适用面：仅 B 站视频详情页可播放；首页/列表不在范围内（用户只要求视频 URL）。
- 单元测试：BV 视频 URL / 带尾随 query 的 BV URL / 非 B 站 URL 各一个。

## 影响范围

| 改动文件 | 说明 |
|---|---|
| `src/layouts/MainLayout.vue` | 路由 watcher（#1）；移除 `!isPanelSuspended`（#4） |
| `src/components/layout/InternalBrowserPanel.vue` | drag-strip + drag-region（#2）；`transformEmbedUrl`（#6） |
| `src/components/task/AddTask.vue` | `waitForParseDone` + 提交分支（#3） |
| `src/web/embedTransform.ts` (新) | URL 改写（#6） |
| `src-tauri/Cargo.toml` | 新增 `encoding_rs`（#5） |
| `src-tauri/src/ytdlp/encoding.rs` (新) | UTF-8/GBK 兜底解码（#5） |
| `src-tauri/src/ytdlp/mod.rs` | 导出 encoding 模块（#5） |
| `src-tauri/src/ytdlp/downloader.rs` | 用新解码器（#5） |

## 不在本次范围

- B 站首页/列表的嵌入浏览（需架构改造，比如真正用子 webview 替代 iframe）。
- YouTube 等其他站点的 X-Frame 阻断（如未来需要可在 `embedTransform.ts` 同样处理 `youtube.com/watch?v=` → `youtube.com/embed/`）。
- yt-dlp.exe 的 PyInstaller 内部 fileystem-encoding 行为分析（兜底解码已足够）。
