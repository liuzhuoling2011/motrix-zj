# yt-dlp 集成设计文档

## 概述

在 Motrix Next 中集成 yt-dlp，支持从 YouTube、Bilibili 等视频网站解析和下载视频媒体。yt-dlp 负责解析视频页面和提取元数据，aria2 负责实际下载；当遇到 HLS/DASH 分片流时，自动降级由 yt-dlp 自身完成下载。

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 集成方式 | yt-dlp 解析 + aria2 下载 | 复用现有下载引擎，统一进度管理 |
| HLS/DASH 处理 | 自动降级到 yt-dlp 下载 | 对用户透明，覆盖所有格式 |
| 二进制分发 | 内置 sidecar 打包 | 开箱即用 |
| URL 识别 | 自动识别 | 用户粘贴链接后自动检测是否为视频 |
| 格式选择 | 简洁预设 + 可展开完整列表 | 兼顾易用性和灵活性 |
| 播放列表 | 支持批量下载 | 用户可勾选条目，统一格式后批量添加 |
| 任务展示 | 统一列表，视频任务附加元数据标签 | 与现有 UI 风格一致 |
| 架构方案 | 轻量级模块集成 | 遵循现有模式，改动最小，风险最低 |

## 后端架构（Rust）

### 新增模块 `src-tauri/src/ytdlp/`

```
ytdlp/
├── mod.rs          // 模块入口
├── client.rs       // yt-dlp CLI 调用封装
├── types.rs        // 数据结构（视频信息、格式、播放列表等）
├── parser.rs       // 解析 yt-dlp JSON 输出
└── downloader.rs   // HLS/DASH 降级下载的进程管理与进度解析
```

### 核心流程

#### 1. URL 解析（短时调用）

```
yt-dlp --dump-json --flat-playlist --no-download <URL>
```

调用 yt-dlp 获取视频元数据（标题、格式列表、缩略图、时长等），返回结构化 JSON。播放列表场景用 `--flat-playlist` 先获取列表概览，用户选择后再逐个解析完整信息。

#### 2. 直链下载（走 aria2）

解析出直链 URL 后，调用现有 `aria2_add_uri()` 添加任务，附带 Referer/User-Agent 等 header（部分站点需要防盗链）。在 HistoryRecord 中通过 `task_type = "video"` 标记，`meta` 字段存储视频元数据。

#### 3. HLS/DASH 降级下载（yt-dlp 自身下载）

```
yt-dlp -f <format_id> --newline --progress -o <output> <URL>
```

作为长时进程运行，通过 `--newline --progress` 输出可解析的进度信息。后端持有进程句柄，支持取消。下载完成后写入 HistoryRecord。

### Tauri Commands

```rust
// 解析 URL，返回视频信息（或"非视频"）
ytdlp_parse_url(url: String) -> Result<ParseResult, AppError>

// 解析播放列表中单个视频的完整信息
ytdlp_parse_playlist(url: String) -> Result<Vec<PlaylistItem>, AppError>

// 通过 aria2 下载（直链场景）
ytdlp_download_via_aria2(url: String, format_id: String, dir: String) -> Result<String, AppError>

// yt-dlp 直接下载（HLS/DASH 降级场景）
ytdlp_download_direct(url: String, format_id: String, dir: String) -> Result<String, AppError>

// 取消 yt-dlp 直接下载
ytdlp_cancel_download(task_id: String) -> Result<(), AppError>
```

### 状态管理

新增 `YtdlpState`（Tauri Managed State），管理当前活跃的 yt-dlp 降级下载进程：

- `HashMap<String, CommandChild>` — 活跃下载进程，key 为自生成 task_id
- 支持多个降级下载任务并行
- 通过 `app.emit("ytdlp-progress", progress)` 向前端推送进度更新

## 数据模型

### Rust 类型（`ytdlp/types.rs`）

```rust
struct VideoInfo {
    id: String,
    title: String,
    url: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    extractor: String,
    formats: Vec<VideoFormat>,
    is_live: Option<bool>,
    playlist_index: Option<u32>,
}

struct VideoFormat {
    format_id: String,
    ext: String,
    resolution: Option<String>,
    height: Option<u32>,
    fps: Option<f64>,
    vcodec: Option<String>,
    acodec: Option<String>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
    tbr: Option<f64>,
    url: Option<String>,
    protocol: String,       // "https"、"m3u8"、"dash" 等
}

enum ParseResult {
    Video(VideoInfo),
    Playlist(PlaylistInfo),
    NotMedia,
}

struct PlaylistInfo {
    id: String,
    title: String,
    uploader: Option<String>,
    entries: Vec<PlaylistItem>,
}

struct PlaylistItem {
    id: String,
    title: String,
    url: String,
    duration: Option<f64>,
    thumbnail: Option<String>,
}

struct YtdlpProgress {
    task_id: String,
    status: YtdlpTaskStatus,   // Downloading / Merging / Complete / Error
    percent: f64,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed: Option<String>,
    eta: Option<String>,
}
```

### 前端类型（TypeScript）

```typescript
interface VideoInfo {
    id: string
    title: string
    url: string
    thumbnail?: string
    duration?: number
    uploader?: string
    extractor: string
    formats: VideoFormat[]
    isLive?: boolean
}

interface FormatPreset {
    label: string       // "最高画质"、"1080p"、"仅音频"
    formatId: string
    estimatedSize?: number
}
```

### HistoryRecord 扩展

现有 `task_type` 字段新增 `"video"` 值。`meta` JSON 字段存储视频元数据：

```json
{
    "video_title": "...",
    "extractor": "youtube",
    "thumbnail": "https://...",
    "resolution": "1080p",
    "duration": 360,
    "download_mode": "aria2" // 或 "ytdlp_direct"
}
```

无需数据库 migration，复用现有 `meta` 字段。

## 前端交互设计

### 自动识别流程

在「新建任务」对话框中，用户粘贴 URL 后：

1. 前端调用 `ytdlp_parse_url`，显示加载状态"正在解析..."
2. 返回 `NotMedia` → 走现有 aria2 流程，无变化
3. 返回 `Video` → 展示视频信息面板
4. 返回 `Playlist` → 展示播放列表选择面板

### 视频信息面板

**上部：视频摘要**
- 缩略图（小尺寸）、标题、来源站点、时长

**中部：格式选择**
- 默认展示简洁预设（3-5 个按钮/卡片）：
  - 「最高画质」— 自动选最佳视频+音频
  - 「1080p」
  - 「720p」
  - 「仅音频 (MP3)」
- 「显示全部格式 ▼」展开按钮 → 展开完整格式表格（分辨率 | 扩展名 | 编码 | 文件大小 | 协议）

**下部：复用现有选项**
- 下载目录、重命名等

### 播放列表选择面板

- 播放列表标题 + 上传者
- 全选/取消全选，已选计数
- 视频条目列表（勾选框 + 标题 + 时长）
- 统一格式预设选择
- 下载目录 + 开始下载按钮
- 超大播放列表（1000+ 条）分页展示，每页 50 条

### 任务列表展示

视频任务在统一列表中额外展示：
- 任务名称优先显示 `video_title`
- 来源站点小标签（如 `YouTube`、`Bilibili`）
- 分辨率标签（如 `1080p`）
- yt-dlp 降级下载任务通过事件监听更新进度

### 新增前端文件

```
src/
├── api/ytdlp.ts              // Tauri invoke 封装
├── composables/
│   └── useVideoFlow.ts       // 视频解析+格式选择逻辑
├── components/
│   ├── VideoInfoPanel.vue    // 视频信息+格式选择面板
│   └── PlaylistPanel.vue     // 播放列表选择面板
└── shared/types.ts           // 新增 VideoInfo 等类型（追加）
```

### Pinia Store

在现有 `taskStore` 中扩展：
- `fetchList()` 合并 yt-dlp 降级任务的进度
- 任务项增加 `downloadMode` 判断，决定是否渲染额外视频元数据

不新增独立 store，保持任务管理逻辑集中。

## Sidecar 打包与进程管理

### 二进制打包

```
public/binaries/
├── motrixnext-ytdlp-x86_64-apple-darwin
├── motrixnext-ytdlp-aarch64-apple-darwin
├── motrixnext-ytdlp-x86_64-unknown-linux-gnu
├── motrixnext-ytdlp-aarch64-unknown-linux-gnu
├── motrixnext-ytdlp-x86_64-pc-windows-msvc.exe
└── motrixnext-ytdlp-aarch64-pc-windows-msvc.exe
```

`tauri.conf.json` 的 `externalBin` 新增 `"binaries/motrixnext-ytdlp"`。

### 进程管理策略

| 场景 | 进程生命周期 |
|------|------------|
| URL 解析 | 短时进程，2-10 秒 |
| 播放列表解析 | 短时进程，5-30 秒 |
| HLS/DASH 降级下载 | 长时进程，持续到下载完成 |

- 解析调用：`shell().sidecar()` 启动，捕获 stdout，进程自然退出。超时 30 秒后 kill。
- 降级下载：`YtdlpState` 维护 `HashMap<String, CommandChild>`，支持多任务并行。
- stdout 逐行解析进度，通过事件系统推送前端。
- 取消：kill 进程 + 清理临时文件。
- 异常退出：标记任务为 error，通知前端。
- 解析请求串行执行，避免同时启动多个解析进程。

## 错误处理

`AppError` 新增变体：

```rust
YtdlpParse(String),    // 解析失败
YtdlpDownload(String), // 降级下载失败
YtdlpTimeout,          // 解析超时
```

用户可见的错误处理：

| 场景 | 行为 |
|------|------|
| URL 无法解析 | 静默回退到普通 aria2 下载流程 |
| 解析超时 | 提示"解析超时，请检查网络或直接下载" |
| 降级下载失败 | 任务列表标记为错误状态，展示错误信息 |
| yt-dlp 二进制缺失 | 视频解析功能不可用，普通下载不受影响 |
| 需要登录的视频 | 暂不支持，解析失败时提示用户 |
| 地域限制视频 | 展示 yt-dlp 返回的错误信息 |
| 直播流 | `is_live = true` 时提示"暂不支持直播下载" |
