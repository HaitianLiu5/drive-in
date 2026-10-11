# Yolo 路线图

状态：草案，2026-10-11。0.1 和 0.2 已完成。决策和理由见 [yolo-decisions.md](yolo-decisions.md)（插件架构见决策 19–24），协议见 [yolo-v1.md](yolo-v1.md)，插件开发见 [yolo-plugins.md](yolo-plugins.md)。

这份路线图只评估复杂度，不估时间。复杂度分低、中、高三档，并写明难点在哪：接口设计、要兼容的外部行为、环境的多样性，或者必须用真机验证。

每个版本发布后都能单独使用：就算下一个版本一直做不完，系统也是完整可用的。

## 1. Yolo 1.0 是什么

Yolo 1.0 是一套自托管的私人媒体服务。它像 Plex 一样，从片源、片库一直覆盖到各端播放；不同的是，它由 agent 驱动，还能在特斯拉浏览器里用 canvas 播放。

| 方面 | 1.0 的状态 |
|---|---|
| 安装 | 需要一个 Cloudflare 账号，以及一台能跑 Docker 的 NAS 或电脑，或者一台 Mac。一条命令部署控制面，再装好媒体节点，然后用节点生成的 6 位码注册 passkey |
| 片源 | NAS 或本地文件夹（节点直接跑在 NAS 上，或者把 SMB/NFS 挂载到节点所在的机器）、WebDAV、Plex（可选）、网页视频链接（yt-dlp）。每一种都是一个插件 |
| 片库 | 电影和剧集带海报和简介；所有客户端共享一份进度和观看记录；一条 Spotify 式的播放队列；播放列表；历史记录 |
| 客户端 | 特斯拉：Drive-In。任意浏览器：Yolo Web。iPhone、iPad、Apple TV、Mac：Infuse 用来手动播放，Swiftfin 可以被 agent 遥控。Android 上的 Jellyfin 客户端理论上可用，但不做保证 |
| agent | ChatGPT、Claude 和 Codex 通过 MCP 搜索、播放、控制、管理队列和设置。不管设备走的是哪种协议，在 agent 看来都一样 |
| 插件 | 插件接口对社区开放，有文档和示例插件。官方插件见第 5 节 |
| 使用模式 | 一个主人、多台设备，同一时间只有一台在播（决策 6） |

### 1.0 不做的事

- 多用户、家庭成员档案、分享给朋友。
- 音乐、播客、有声书、Spotify。
- 原生 iOS、tvOS、Android App。只有第 6 节第 1 条假设不成立时，才做原生 tvOS App。
- 不依赖 Cloudflare 的自托管（[待定](yolo-decisions.md#待定)第 1 条）。
- 离线下载、直播电视和录像、IPTV。
- 在节点里实现 SMB/NFS 客户端；官方做 Plex 协议插件；遥控 Infuse。
- 插件的权限系统。1.0 和 pi 一样，靠用户信任插件、安装前审查代码。

## 2. 架构

```
              ChatGPT / Claude / Codex
                       │ MCP + OAuth
                       ▼
 ┌────────────── 控制面（Cloudflare Worker）──────────────┐
 │ 核心：MCP、/v1、OAuth、Hub DO（设备/队列/播放状态）、D1   │
 │ 插件（部署时打包）：协议插件（Jellyfin…）、设备插件的控制面一半 │
 └──────────┬──────────────────────────────┬──────────────┘
            │ Workers VPC（nodeFetch）      │ WebSocket / HTTP
            ▼                              ▼
 媒体节点（Mac，或 NAS 上的 Docker）    客户端
 ├ 核心：转码、HLS、字幕、/m/* 签名流    ├ Drive-In（特斯拉 canvas）
 └ 插件（启动时加载）：                  ├ Yolo Web（浏览器）
   片源（文件夹、WebDAV、Plex、yt-dlp）  ├ Swiftfin（agent 可遥控）
   元数据（TMDB）、设备的局域网一半       └ Infuse（手动操作）
            └──── 媒体流：经 Worker，在家时可走局域网直连 ────┘
```

核心只负责下面这些，其余都是插件：

- 片库目录、条目、音轨和字幕的模型。
- 设备和会话：Hub，包括单一队列和播放状态。
- 播放列表、历史和进度。
- 身份和授权：OAuth、passkey、配对。
- 媒体流签名，以及 ffmpeg 转码、HLS 封装这类基础能力。
- MCP。它是「由 agent 驱动」这个定位的核心，不能关掉；插件可以往里面加工具。

## 3. 插件模型

做法参考 pi 的扩展机制（`badlogic/pi-mono` 里的 `packages/coding-agent/docs/extensions.md` 和 `packages.md`）。0.2 实现了其中的片源插件和 MCP 工具，接口和写法见 [yolo-plugins.md](yolo-plugins.md)。

| 插件类型 | 作用 | 例子 |
|---|---|---|
| 片源 | 把内容接进 Yolo：扫描或列出条目，认领网址，解析成可播放的流 | 文件夹、WebDAV、Plex、yt-dlp |
| 元数据 | 给条目补海报、简介、演职员 | TMDB；社区可以做豆瓣、AniDB |
| 协议 | 把 Yolo 暴露给第三方客户端 | 兼容 Jellyfin 的 API；社区可以做 Emby、DLNA |
| 设备 | 把一种播放器变成 Hub 里可以控制的设备 | Yolo 实时通道（Drive-In、Web）；以后可以做 Apple TV（pyatv）、Chromecast、Kodi |

- **插件就是一个工厂函数**：导出 `export default function (yolo)`，在函数里用 `yolo.registerSource`、`registerProtocol`、`registerDevice`、`registerTool` 注册能力，用 `yolo.on(...)` 订阅事件。事件分两种：一种只是通知，另一种可以改写数据或拦截操作。多个处理器按注册顺序执行，返回 `undefined` 就交给下一个。核心收到一个网址时，就用这种方式依次问片源插件谁来认领。
- **一个插件有两个入口**：控制面和节点是两个运行环境，所以清单写在 `package.json` 的 `yolo` 字段里，分成 `control` 和 `node` 两个入口。插件可以只有其中一个。
- **安装方式**：插件是普通的 npm 包，可以从 npm、git 或本地目录安装，版本固定。`yolo install` 会更新配置，重新部署控制面（Worker 不能在运行时加载代码），再重启节点。宿主提供的包（`@useyolo/plugin-api` 等）必须声明成 `peerDependencies`。
- **生命周期**：工厂函数里不能启动进程、socket 或定时器。这些要在节点的 `start` 事件里启动，在 `shutdown` 事件里清理，而且清理要能重复执行。
- **内置功能也是插件**：官方插件在配置里可以关掉。比如不用 Plex 的人关掉 Plex 插件，不想要 yt-dlp 的人关掉 yt-dlp 插件。
- **能用配置解决的就不写插件**：比如加一个 WebDAV 地址，只是给 WebDAV 插件加一条配置。
- **1.0 之前插件接口一律标成实验性**，可以不兼容地修改。1.0 起才承诺稳定。

## 4. 版本路线

| 版本 | 主题 | 做完后能做什么 | 复杂度 | 难点 |
|---|---|---|---|---|
| 0.1（已完成） | 控制面 + MCP | ChatGPT、Claude、Codex 能通过 Yolo 控制车上的 Drive-In。片源是 Plex 和网页 URL，播放借用旧 server | — | — |
| 0.2（已完成） | 插件框架 | 插件接口、节点加载器、控制面在部署时打包插件。Plex 和 yt-dlp 拆成两个官方片源插件，核心里不再出现 `url` 片源类型和 yt-dlp。功能和 0.1 一样，只是换成了插件结构 | 高 | 两个运行环境要用同一套接口；部署时打包；把散落在 core、control、node 三层的 Plex 和 yt-dlp 代码拆干净 |
| 0.3 | Drive-In 完全迁到 Yolo | 媒体管线从 `server/` 搬进节点核心（`/m/*`），片源插件只负责提供输入。Drive-In 作为第一个「Yolo 实时通道」设备，改用 v1 协议，车机扫码配对。进度由 Yolo 记录，并导入旧数据，修好「播放不接着进度」的问题。最后删掉 `server/` 和 CLI（决策 12） | 高 | 要迁的代码量大，特斯拉上的各种特殊行为不能退化；四种流类型都要在车上手动验证；要迁移旧数据 |
| 0.4 | Yolo Web | 浏览器客户端：用同一个播放引擎，换一份能力描述；任何设备都可以当遥控器。设置页管理片源、插件、设备、agent 授权和 passkey | 中 | 主要是做新界面；播放引擎和实时通道都复用 |
| 0.5 | 自己的片库和 NAS | 文件夹片源插件：扫描、解析文件名、ffprobe 读音轨字幕。WebDAV 片源插件。TMDB 元数据插件。片库目录同步到 D1，节点离线时也能浏览和搜索。节点提供 Docker 镜像，转码支持硬件加速。没有 Plex 的用户也能完整使用 | 高 | NAS 环境各不相同；文件命名的边界情况很多；低端 NAS 上的转码性能 |
| 0.6 | Jellyfin 协议插件 | Infuse 和 Swiftfin 直接连 Yolo，进度同步回 Yolo。电视在 Quick Connect 里显示的配对码，可以由 agent 或 Web 端批准。Jellyfin 会话接入 Hub 的设备模型，agent 能遥控 Swiftfin | 中高 | 大约 40–60 个端点，以及 Infuse 的各种特殊行为；没有现成项目实现过会话推送；必须用真机验证 |
| 0.7 → 1.0 | 可以分发给别人用 | 一条命令部署控制面。节点提供 Docker 镜像（Synology、QNAP、Unraid、TrueNAS）和 macOS 安装包，在 Mac 上以 LaunchDaemon 运行（局域网插件需要，见 Apple TN3179）。首次设置向导；`yolo install` 插件命令；插件接口文档和示例插件。改名，并把服务拆到新仓库（决策 12、14）。`useyolo.app` 宣传站和文档上线。备份恢复、用量护栏、安全审查 | 中 | 工作面很宽但不深：要在多个平台上打包和测试 |

**0.2 做到了哪里**（2026-10-11）：

- 已实现：`@useyolo/plugin-api`；节点的插件加载器和片源注册表（按顺序认领网址、生命周期、出错的插件不影响节点）；控制面在构建时打包插件的 `control` 入口，插件可以加 MCP 工具；`@useyolo/source-plex` 和 `@useyolo/source-ytdlp` 两个官方插件；`yolo.config.json` 配置，没有配置时加载官方插件；D1 迁移 `0003` 把旧数据改成插件的 Source。
- 例外：旧 Drive-In server 的桥接 `service/node/src/legacy.js` 还认识两个官方插件，0.3 和 `server/` 一起删掉。
- 推迟：元数据、协议、设备三类插件的接口，留到第一个用到它们的版本（0.5、0.6）再设计；`yolo install` 留到 0.7 之后。

**开始 0.6 之前先做实验**：在 Mac mini 上跑一个真的 Jellyfin，确认三件事：Swiftfin 在 tvOS 上能执行哪些遥控命令；Infuse 的会话在 `GET /Sessions` 里报告的 `SupportsMediaControl` 是什么；Infuse 能直放哪些格式。实验结果决定 0.6 怎么做，以及要不要做原生 tvOS App（见第 6 节第 1 条）。

## 5. 1.0 的官方插件

| 类型 | 插件 | 运行位置 |
|---|---|---|
| 片源 | 文件夹（本地和 NAS） | 节点 |
| 片源 | WebDAV | 节点 |
| 片源 | Plex | 节点 |
| 片源 | yt-dlp | 节点 |
| 元数据 | TMDB | 节点 |
| 协议 | 兼容 Jellyfin 的 API | 控制面（API、会话推送）+ 节点（媒体流） |
| 设备 | Yolo 实时通道（Drive-In、Yolo Web） | 控制面 |

## 6. 容易出问题的假设

| # | 假设 | 不成立时怎么办 | 谁在什么时候验证 |
|---|---|---|---|
| 1 | Swiftfin 在 tvOS 上能可靠执行遥控命令 | 0.6 之后加一个原生 tvOS App。它讲同一套 Jellyfin 会话协议，服务端和 MCP 不用改。这会引入 Swift，需要用户另外批准 | 开始 0.6 之前，用用户的 Apple TV 实测 |
| 2 | Cloudflare 的条款允许通过 Worker 转发视频（2026-09 版条款对此没有写清楚） | 媒体流改走局域网直连，加一个不经 Cloudflare 代理的媒体源。从 0.3 起，媒体流地址就设计成可以替换的 | 1.0 公开前，由用户决定 |
| 3 | 自托管软件可以内置 TMDB 的 API key | 每个用户自己申请一个 key，安装时多一步 | 开始 0.5 之前核实 |
| 4 | 只有两个片源插件时设计出来的接口，能撑住之后的插件 | 1.0 之前接口一律标成实验性；0.5 和 0.6 会再加四个插件来检验它 | 0.2 到 1.0 之间持续检验 |
