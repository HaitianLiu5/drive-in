# Yolo 决策记录

状态：v1 正在实现，进度见 [yolo-v1.md 第 12 节](yolo-v1.md#12-实现状态2026-10-09)。最后更新：2026-10-09。

这份文档记录 Drive-In 演进成 Yolo 的背景、已定的决策和理由、放弃的方案，以及还没定的事。协议细节以 [yolo-v1.md](yolo-v1.md) 为准，这里不重复。

## 背景

现在的 Drive-In 是家里的一个 Node 进程（Express + `ws`）：

- 负责解析 URL（yt-dlp）、转码（ffmpeg）、代理 Plex，然后把画面渲染到特斯拉浏览器的 `<canvas>` 上。
- 通过 cloudflared tunnel 对外暴露。HTTP、WebSocket、代理路由都没有认证。
- 大部分逻辑都在 `server/index.js` 里，约 4200 行，状态全放在模块级变量中。

Agent 目前通过 `@drive-in/cli`（`cli/`）加 `skills/drive-in/SKILL.md` 来控制播放。这条路只能在本地 shell 里走，ChatGPT 和 claude.ai 用不了。

目标分两步：

1. 让 Claude Code 和 ChatGPT 都能通过 MCP 控制，体验类似 Robinhood 的 agentic trading：给一个远程 MCP 地址，走一遍 OAuth 就能用。然后去掉 CLI。
2. 把底层服务独立出来，做成 **Yolo**：一个私人的、由 agent 驱动的 all-in-one 娱乐服务，以后还会支持音乐和歌词、播客、有声书、Spotify。Drive-In 只保留特斯拉 canvas 播放器，成为 Yolo 的一个客户端，其他客户端还有普通浏览器、手机等。

## 已定

| # | 决策 | 理由 | 放弃的方案 |
|---|---|---|---|
| 1 | Agent 入口用**远程 MCP**（Streamable HTTP + OAuth），去掉 CLI | ChatGPT 和 claude.ai 都要求公网 HTTPS 地址；本地 stdio MCP 只能给 Claude Code 和 Desktop 用 | 保留 CLI；本地 stdio MCP 包 |
| 2 | **方案 B**：控制面放 Cloudflare Workers（D1、Durable Objects、KV），媒体节点留在家里（Node） | 和 Cloudflare 基建打通；官方 OAuth/MCP 生态现成；Worker 是唯一入口，家里机器不直接暴露；节点离线时页面和 MCP 照常可用；以后可以扩成多用户 | 方案 A：一个进程全在家里，Cloudflare 只提供 Tunnel |
| 3 | 两边都用 **Hono** | 基于 Web 标准的 Request/Response，同一套路由在 Workers 和 Node 上都能跑 | Express（只能跑在 Node 上）；vinext（见下文） |
| 4 | 先拆成**服务 + 客户端**，再落地 | 下一步要改名、拆分。协议现在就按多终端设计，以后改名只是换名字 | 先只为 Drive-In 做 MCP，以后再拆一遍 |
| 5 | 单用户，但**所有表都带 `user_id`** | 现在加一列几乎没有成本，以后补就是一次数据迁移 | 只按单用户设计 |
| 6 | **Spotify 式**队列：一个用户一条队列，同一时间只有一台设备在播 | 用户原话："一个用户只有一双眼"，不会多台设备同时播 | Plex 式：每台设备一条队列 |
| 7 | 设备**按能力协商**播放方式；特斯拉 canvas 是其中一份能力描述 | 普通浏览器、手机需要的格式和字幕方式都不一样 | 写死成特斯拉的行为 |
| 8 | 统一 OAuth；特斯拉用**设备码**登录；媒体流用**签名 URL**，不用 cookie | 车机上不方便输密码；原生播放器、跨源请求、以后的局域网直连都不带 cookie | Cloudflare Access 加 cookie |
| 9 | 媒体流经 Worker **同源透传** | 页面带 COOP/COEP 时，跨源请求不带 cookie，同源最省事；只有一道认证；player 代码不用改 | 单独开 `media.` 子域名直连 Tunnel |
| 10 | 流量**优先走 Cloudflare** | 用户输入一个网址就能用，这是门槛最低的方式；目前没有产生费用问题 | 局域网直连（以后作为优化） |
| 11 | 名字叫 **Yolo**；官网 `useyolo.app`；npm 用 `@useyolo/*`；MCP 服务名和插件名都叫 `yolo` | 见下方"命名" | 见下方"命名" |
| 12 | 在本仓库里**一次性重写**，按模块拆分；改名时再把服务拆到新仓库 | 用户选的。新架构通过 `npm run check`，并且四种流类型都手动验证过之后，才删除旧 server | 渐进替换（strangler 模式） |
| 13 | 历史只保留**最近 500 条** | 足够找回最近看过的内容，又不会无限增长 | 不设上限 |
| 14 | 仓库分成 `service/core`、`service/control`、`service/node`、`sdk/js`、`clients/tesla`、`plugin/` | 服务和客户端分开放；改名时 `service/`、`sdk/` 直接搬进新仓库，`clients/tesla` 留下来继续叫 Drive-In | 按运行时分目录 |
| 15 | 新设备用**扫码配对**：车机显示二维码（RFC 8628 的 `verification_uri_complete`）和备用短码，手机扫码后打开已填好码的确认页 | 车机上不用打字；车机没有摄像头，所以只能车上显示、手机扫。为防设备码钓鱼：确认页醒目显示设备名称、类型和发起时间；码 10 分钟过期、只能用一次；必须手动点"允许" | 只显示短码、手动输入 |
| 16 | 用户本人只用 **passkey** 登录，用一次性初始化码注册和找回 | Face ID 一下即可，抗钓鱼，没有可以泄露的密码；不需要 Zero Trust 后台配置。门槛要高，是因为节点在局域网里，能替别人抓取任意 URL | 管理密码；Cloudflare Access |
| 17 | 控制面通过 **Workers VPC** 访问节点，调用统一收进 `nodeFetch()`；开工前先实验，透传真实 HLS 会话一小时（代码和步骤见 [experiments/workers-vpc-spike](../experiments/workers-vpc-spike/README.md)）。2026-10-08 压测通过：60 分钟、每条路径 450 个约 1.5MB 的请求，VPC 路径失败 0 次，慢尾吞吐 p5 16.9 Mbps，首字节时间 p95 125ms，与公网路径的 123ms 持平。压测只覆盖静态文件，用真实播放器看半小时的测试还没做 | 节点完全没有公网地址，也不需要轮换 token。Workers VPC 截至 2026-09 仍是 Beta，所以要留退路：实验不通过、或 Beta 出问题时，只改配置切换到 Tunnel 公网域名 + Access service token | 直接用 Tunnel 公网域名 + Access service token |

### 不选 vinext 的原因

vinext 是用 Vite 重写的 Next.js，首要部署目标是 Workers。它不适合 Drive-In，原因有三：

- 媒体那一半（yt-dlp、ffmpeg、better-sqlite3、20GB 磁盘缓存、局域网 Plex）在 Workers 上跑不了。
- 如果改用 Node standalone 部署，又用不上 Workers 的各种 binding；而且 Next.js 的路由模型不支持 WebSocket upgrade。
- player 是纯 JS 的 canvas 应用，用不上 RSC 和页面路由，改写成 React 没有收益。

### 为什么必须保留 COOP/COEP

播放器靠 `SharedArrayBuffer` + `Atomics` 实现无锁的音频环形缓冲区（`player/src/engine/audio-ring-buffer.js`）：主线程写入 PCM，AudioWorklet 读出来播放，已播放的采样数就是整个播放器的时钟。

Spectre 漏洞之后，浏览器只允许跨源隔离的页面使用 `SharedArrayBuffer`。所以页面必须带两个响应头：`Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`。

- 现在由 `server/index.js:199-203` 和 `player/vite.config.js:12-13` 设置。
- 少了这两个头，`player/src/engine/mediabunny-player.js:151` 会直接抛错，没有兜底方案。
- 新的控制面必须给播放器页面加上这两个头，比如用 Workers Static Assets 的 `_headers` 文件。
- COOP 会切断播放器页面和它打开的弹窗之间的联系，所以不能在播放器页面里用弹窗方式登录。

### 命名

筛选标准：

1. 比 drivein 短。
2. 一看就像科技产品名。
3. 中英文混说时，语音识别率高。

为了满足第 3 条，具体要求是：

- 没有常见的同音词。反例：Claude 被识别成 cloud。
- 至少两个音节，以元音结尾。
- 不依赖 n/l 的区别（很多南方口音 n/l 不分）。
- 不能是用户下指令时会用到的词。

Yolo 满足所有条件：所有语音识别器的词表里都有它，"人生只活一次"的意思也贴合娱乐休闲的定位。它有两个已知的冲突：

- Claude Code 等工具里有 "YOLO mode"（自动批准所有操作）的叫法。工具描述里要写明"Yolo 是媒体服务"。
- 有一个同名的著名图像识别模型，官网很难排上搜索结果。

商标不在考虑范围内，因为这是私人服务。

考虑过、后来放弃的名字：

- Homecue、Cue：cue 和 queue 同音，而"队列"是核心概念。
- Nod：和 not 几乎同音。
- Kudo、Remo、Beamo、Nemo、Dobby：都可用，用户最终选了 Yolo。

2026-10-08 通过 Cloudflare Registrar 的官方接口查询：

- `useyolo.app` 可以注册，$8.20/年，**还没注册**。
- `heyyolo.app`、`yoloplay.app`、`yolotv.app` 也可以注册。
- `yolo.app`、`yolo.ai`、`useyolo.com` 都已被注册。
- npm 上 `@useyolo` 可用，`@yolo` 已被占用。

## 待定

1. **不用 Cloudflare 能不能自托管**：用户先说过"可以用，只是兼容 Cloudflare"，后来选了方案 B 为主。一个思路是让同一套 Worker 代码在本地的 workerd 上运行，但这需要验证。另一个选择是 v1 先不支持。
2. **注册 `useyolo.app`**：等用户明确同意再注册，会从 Cloudflare 账号扣费。
3. **Cloudflare 对视频流量的条款**：CDN 条款要求通过付费服务（Developer Platform、Stream 等）提供视频。按字面理解，经付费 Worker 透传比直接走 Tunnel 更站得住，但没有找到针对 Tunnel 的官方说明。现在用着没问题，不代表条款允许，需要用户自己确认。

## 去掉 CLI 的清单

等 MCP 能用之后再执行：

| 位置 | 改动 |
|---|---|
| `cli/` | 整个目录删掉 |
| 根 `package.json` | 从 `workspaces` 去掉 `cli`，keywords 去掉 `cli`，然后用 `npm install` 重新生成 lockfile |
| `.github/workflows/ci.yml` | 删掉 "Smoke test — CLI help" 这一步 |
| `.github/workflows/release-cli.yml`、`RELEASING.md` | 删掉 |
| `.github/CODEOWNERS` | 删掉 `/cli/` |
| `.github/PULL_REQUEST_TEMPLATE.md` | 删掉 `cli` 勾选项 |
| `README.md`、`.env.example`（`DRIVEIN_SERVER`）、`AGENTS.md` | 删掉和 CLI 有关的内容 |
| `skills/drive-in/SKILL.md` | 改写成 MCP 的用法 |
| npm | 运行 `npm deprecate @drive-in/cli "Use the Yolo MCP server"`，不要 unpublish |

## 云端会话的工具备注

- 云端会话的网络策略拦了 `api.cloudflare.com` 和 `dash.cloudflare.com`，所以 `cf` 和 `wrangler` 在会话里连不上 Cloudflare。要用的话，得在环境的 Network access 里放开这两个域名。
- Cloudflare 连接器（claude.ai 的 connector）不受这个限制，可以直接调 Cloudflare API。查域名就是用它做的。
- `cf` 是 Cloudflare 官方的 CLI，npm 包名就叫 `cf`。容器每次重建后都要重新装。
