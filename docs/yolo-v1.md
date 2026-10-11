# Yolo v1 协议草案

状态：v1 正在实现，代码在 `service/`。已实现和没实现的部分见第 12 节。背景、决策理由和待定事项见 [yolo-decisions.md](yolo-decisions.md)。

Yolo 是一个私人的、由 agent 驱动的流媒体服务。服务端分两部分：控制面跑在 Cloudflare，媒体节点跑在家里。客户端包括特斯拉 canvas 播放器（Drive-In）、普通浏览器、手机，以及通过 MCP 接入的 agent。

- 官网：`useyolo.app`，只做宣传网站
- 控制面（用户本人的实例）：`yolo.haitian.site`，见决策 18
- npm：`@useyolo/*`
- MCP 服务名：`yolo`

## 0. 范围

v1 要做的：

- 控制面 + 媒体节点 + Drive-In 客户端 + MCP。
- 单用户。但所有数据表都带 `user_id`。
- 来源由媒体节点上的片源插件提供（[yolo-plugins.md](yolo-plugins.md)）。官方插件是 Plex 和网页 URL（yt-dlp）。

v1 不做，但协议要给它们留位置：

- 多用户和家庭共享。
- 普通 Web 客户端、手机 App。
- 局域网直连媒体节点。
- 多个媒体节点。

关于 Spotify 和有声书：Spotify 的音频有 DRM，也不允许转发，所以没法经过媒体节点播放，只能通过 Spotify Connect 控制，由 Spotify 自己的设备播放。为此，`delivery` 预留了 `external` 类型（见第 6 节）。

## 1. 名词

| 名词 | 含义 |
|---|---|
| user | 一个账号。v1 只有一个 |
| device | 一个终端，例如特斯拉浏览器、手机、电脑浏览器。设备会声明自己的能力 |
| active device | 当前负责播放的设备。一个用户同一时间只有一台 |
| node | 家里的媒体节点，负责片源插件、解析、转码、代理、缓存 |
| source | 内容来源，由片源插件定义，例如 `{plugin:"plex", id:"12345"}`。还没被插件认领的网址是 `{url}` |
| session | 一次播放会话。由节点创建，用 `sessionId` 标识，绑定一组签名的媒体 URL |
| queue | 用户级的播放队列。采用 Spotify 式：一个用户只有一条 |

## 2. 拓扑

```
客户端（Drive-In / Web / 手机 / Agent）
   │  HTTPS + WSS，只用一个域名
   ▼
控制面：Cloudflare Worker（Hono）
   ├ /v1/*            HTTP API
   ├ /v1/realtime     WebSocket → Hub Durable Object（每个用户一个）
   ├ /mcp             MCP（Streamable HTTP）
   ├ /oauth/*         授权服务器
   ├ /m/*             媒体流，原样透传到节点
   └ D1：用户、设备、令牌、队列、播放列表、历史、音轨偏好
   │  Workers VPC binding（经 Cloudflare Tunnel，节点没有公网地址）
   ▼
媒体节点：家里的 Node（Hono）
   ├ /internal/v1/*   只接受控制面调用
   └ /m/*             校验签名后提供 HLS/MP4，输出格式和现在一样
```

"当前在播什么"由 Hub DO 负责，媒体会话（代理、ffmpeg、Plex 转码）由节点负责。两边只通过第 8 节的内部接口通信。

## 3. 认证

控制面就是 OAuth 2.1 授权服务器。所有客户端都拿 access token（Bearer），按客户端类型走不同的流程：

| 客户端 | 流程 |
|---|---|
| Agent（Claude、ChatGPT） | 动态客户端注册（RFC 7591）+ 授权码 + PKCE。元数据放在 `/.well-known/oauth-authorization-server` 和 `/.well-known/oauth-protected-resource`（RFC 9728） |
| 浏览器、手机 | 授权码 + PKCE |
| 特斯拉、电视 | 设备码流程（RFC 8628）。车机屏幕显示二维码（`verification_uri_complete`）和备用短码；手机扫码打开已填好码的 `/device` 确认页。确认页显示设备名称、类型和发起时间；码 10 分钟过期、只能用一次；必须手动点"允许" |
| 媒体节点 | 控制面通过 Workers VPC binding 访问节点，公网上没有节点地址。配对时生成 `nodeSecret`，用于请求签名（纵深防御）和媒体 URL 的签名密钥 |

用户本人登录：只用 passkey（决策 16）。

- 第一次注册 passkey，或者 passkey 全丢了要重置时，在家里机器上运行 `npm run owner-code`。节点打印一个 6 位数字配对码，在 `/login` 输入后创建 passkey。
- 配对码由节点签发和校验，只存在节点内存里，Cloudflare 不存。15 分钟过期，错 5 次作废，只能用一次；重新申请会替换旧码，节点重启就没了。
- 已有 passkey 时用配对码注册就是重置：新 passkey 保存后，删掉其他所有 passkey，撤销所有登录会话。没有网页找回。
- 已登录时添加 passkey 不需要配对码。
- 节点离线时没法用配对码注册，`/login` 会提示先启动节点。

授权页、设备确认页和设置页都要求先登录。

**Scope**

| scope | 允许做什么 |
|---|---|
| `read` | 读取状态、设备、库、队列、播放列表、历史 |
| `control` | 播放、暂停、跳转、切换设备、选择音轨 |
| `manage` | 修改队列、播放列表、历史和设备 |

Agent 默认申请全部 scope，授权页上可以去掉其中几项。

**Token**

- access token 有效期 1 小时，refresh token 可轮换。
- D1 里只存 token 的哈希。
- 用户可以在设置页撤销任何一个客户端。

**WebSocket 认证**：浏览器发起 WebSocket 时没法设置 `Authorization` 头，所以分两步。先调用 `POST /v1/realtime/ticket` 换一张一次性票据（有效期 30 秒），再连接 `wss://…/v1/realtime?ticket=…`。

**媒体 URL 签名**

- 控制面在创建会话时签发一个 token，格式为 `HMAC-SHA256(nodeKey, sessionId|userId|exp)`，节点在本地校验，不需要回调控制面。
- token 放在**路径前缀**里：`/m/{token}/…`。这样 HLS 清单里的相对 URL 会自动带上它，节点改写清单时也统一加上这个前缀。
- token 的有效期跟会话一致，默认 12 小时。会话结束时，节点把它作废。
- 不使用 cookie。原生播放器、跨源请求（COEP）、以后的局域网直连，都能直接用。

## 4. 资源结构

```js
// Source：内容从哪来，归片源插件所有（yolo-plugins.md）。plugin 是片源 id，
// id 由插件决定，其他字段也归插件，控制面原样保存
{ plugin: "plex", id: "12345" }
{ plugin: "ytdlp", id: "https://youtube.com/watch?v=…", url: "https://youtu.be/…?si=…" }
// 还没被插件认领的网址：节点离线时加进队列或播放列表的网址，播放时再认领
{ url: "https://…" }

// Device
{
  id: "dev_…", name: "Model Y", kind: "car" | "browser" | "phone" | "tv",
  online: true, active: false, lastSeenAt: 1730000000000,
  capabilities: Capabilities,   // 见第 6 节
}

// Item：队列项或播放列表项
{ id: "itm_…", source: Source, title, thumbnail, duration, addedAt }

// PlaybackState：Hub 广播的唯一一份播放状态
{
  status: "idle" | "loading" | "playing" | "paused" | "buffering",
  deviceId: "dev_…" | null,
  item: { source, title, thumbnail, duration, isLive } | null,
  position: 123.4, positionAt: 1730000000000,  // 客户端用这两个值外推当前进度
  tracks: { subtitles: ["en", "zh"], audio: "a_2" | null },
  sessionId: "ses_…" | null,
}

// Track：可选的字幕或音轨
{ id: "s_en" | "plex:123", kind: "subtitle" | "audio", language: "en",
  name: "English", auto: false, format: "text" | "image", default: false }
```

`sourceKey` 是来源的稳定键，用于历史、续播进度和音轨偏好，格式统一是 `<plugin>:<id>`，片库条目的 id 也是它。插件对同一个内容必须每次给出同一个 `id`：

- Plex：`plex:<ratingKey>`
- yt-dlp：`ytdlp:<规范化后的 URL>`。同一个视频的不同网址写法共用一个键。0.1 的键是 `url:<规范化后的 URL>`，由 D1 迁移 `0003` 改过来

网址先交给节点认领：节点按插件加载顺序依次问片源插件，第一个认领的插件决定 Source（第 8 节 `claim`）。

## 5. HTTP API（控制面，`/v1`）

所有响应都是 JSON。出错时统一返回：

```json
{ "error": { "code": "device_offline", "message": "…", "retryable": true } }
```

错误码：`invalid_request`、`unauthorized`、`forbidden`、`not_found`、`device_offline`、`node_offline`、`resolve_failed`、`superseded`、`rate_limited`。

| 方法 | 路径 | scope | 说明 |
|---|---|---|---|
| GET | `/v1/me` | read | 用户信息，以及节点是否在线 |
| GET | `/v1/devices` | read | 设备列表 |
| PATCH | `/v1/devices/:id` | manage | 重命名 |
| DELETE | `/v1/devices/:id` | manage | 移除设备，并撤销它的 token |
| GET | `/v1/playback` | read | 当前的 `PlaybackState` |
| POST | `/v1/playback/play` | control | 参数为 `{ source \| itemId, deviceId?, startTime?, tracks? }`。省略 `deviceId` 时发给当前设备 |
| POST | `/v1/playback/pause`、`/resume`、`/stop` | control | 暂停、继续、停止 |
| POST | `/v1/playback/seek` | control | `{ position }` |
| POST | `/v1/playback/next`、`/previous` | control | 下一首、上一首 |
| PUT | `/v1/playback/device` | control | `{ deviceId, play: true }`。切换设备，并带着进度接着播 |
| PUT | `/v1/playback/tracks` | control | `{ subtitles?: [id…], audio?: id }`。传空数组表示关闭字幕 |
| GET | `/v1/tracks?source=…` | read | 某个来源可选的音轨。省略 `source` 时返回当前播放项的 |
| GET | `/v1/queue` | read | 队列 |
| POST | `/v1/queue` | manage | `{ source, position: "next" \| "end" }` |
| POST | `/v1/queue/reorder` | manage | `{ ids: [...] }` |
| DELETE | `/v1/queue/:id`、`/v1/queue` | manage | 删除一项、清空队列 |
| GET/POST | `/v1/playlists` | read / manage | 列出、创建 |
| GET/PATCH/DELETE | `/v1/playlists/:id` | read / manage | 查看、修改、删除 |
| POST | `/v1/playlists/:id/items` | manage | `{ source }` |
| DELETE | `/v1/playlists/:id/items/:itemId` | manage | 删除一项 |
| POST | `/v1/playlists/:id/reorder` | manage | 重新排序 |
| POST | `/v1/playlists/:id/enqueue` | manage | `{ position }`，把整个播放列表加入队列 |
| POST | `/v1/playlists/import` | manage | `{ url, name?, enqueue? }`，从外部播放列表导入 |
| GET | `/v1/history` | read | 历史和播放进度 |
| DELETE | `/v1/history` | manage | `{ sourceKey? }`，省略时清空全部 |
| GET | `/v1/library` | read | 媒体库列表，来自节点上实现了片库的片源插件，id 为 `<片源>:<id>` |
| GET | `/v1/library/:libraryId/items` | read | 浏览，支持分页 |
| GET | `/v1/library/items/:id/children` | read | 剧集等子项 |
| GET | `/v1/library/search?q=` | read | 搜索 |
| GET | `/v1/library/items/:id/artwork?variant=` | read | 封面图，由控制面透传 |

在控制面里，库相关的接口只是把请求转给节点，所以 API 不暴露 "plex" 这个词。以后加有声书库、音乐库，接口不用改。

## 6. 设备能力和播放协商

设备连接时，在 `hello` 消息里声明自己的能力：

```js
{
  renderer: "canvas-webcodecs" | "html5-video" | "native" | "external",
  delivery: ["hls", "mp4"],
  video: ["avc1", "hvc1", "av01", "vp09"],
  audio: ["mp4a", "opus"],
  maxHeight: 720,
  subtitles: "client-vtt" | "native-vtt" | "burn-in",
  audioOnly: false,
}
```

视口（viewport）在设备的 `report` 消息里实时上报。切换清晰度时，必须保留播放位置。

节点的 `prepare` 根据"来源 + 能力 + 视口"返回一个流描述：

```js
{
  sessionId: "ses_…",
  delivery: { type: "hls" | "mp4" | "external", url: "/m/{token}/…" },
  profile: { width, height, videoKbps, audioKbps, split },
  title, duration, isLive, liveDvr, thumbnail,
  startTime,
  tracks: { subtitles: [Track], audio: [Track], selected: { subtitles: [...], audio } },
}
```

**特斯拉的能力描述就是 Drive-In 现在的行为**：

- 播放器只接收 `hls` 和 `mp4` 两种格式。
- 分离的音视频流，拼成 fMP4 HLS 再给播放器。
- Plex 固定转码成 720p。
- 文本字幕在浏览器里渲染，图片字幕由 Plex 烧录进画面。

普通浏览器和手机就是换一份能力描述，由节点决定格式、码率和字幕方式。

## 7. 实时通道（WebSocket `/v1/realtime`）

所有消息共用一个信封格式：`{ v: 1, type, id?, ... }`。带 `id` 的命令需要设备回 `ack`。

**心跳由设备发起**：设备每 25 秒发一次 `{"v":1,"type":"ping"}`，因为 Cloudflare 空闲 100 秒就会断开连接。这个字符串必须一字不差（常量 `HEARTBEAT_PING`，在 `@useyolo/core` 里）。服务端靠 Durable Object 的 WebSocket 自动回复返回 `{"v":1,"type":"pong"}`，不会唤醒 Hub，也不产生 Hub 的运行时长。服务端不设定时器，不主动发心跳。

**限额**：用来防止有 bug 的客户端让 Hub 一直醒着、不停计费。
- 每个用户最多 16 条连接；每分钟最多新建 20 条。超出时返回 429 `rate_limited`。
- 每条连接每 10 秒最多 30 条消息，心跳不算。超出时服务端用 1008 `rate_limited` 关闭连接。
- 客户端断线后必须指数退避重连，收到 1008 或 429 时至少等 30 秒。
- 客户端不能对广播（`state`、`queue`、`playlists`、`devices`）回发 `report` 之类的消息，否则会和 Hub 形成来回循环。

**设备发给服务端**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | 首次连接时没有 `deviceId`，服务端会分配一个 |
| `report` | `status, position, duration, playing, viewport?` | 只有当前设备上报。至少每 5 秒一次，状态变化时立即上报 |
| `ended` | `sessionId` | 播放结束，Hub 从队列取下一项 |
| `error` | `sessionId, code, message` | 播放失败。由 Hub 决定是重建会话还是停止 |
| `ack` | `id` | 确认收到命令 |
| `ping` | 无 | 心跳，固定字符串，见上文 |

**服务端发给设备**

| type | 发给谁 | 说明 |
|---|---|---|
| `welcome` | 刚连上的设备 | 包含 `deviceId`、当前的 `state`、`queue`、`playlists` |
| `load` | 当前设备 | 包含流描述、`startTime`、`autoplay`、`reason`（`play`、`recovery`、`seek`、`quality`、`transfer`、`tracks`）。`tracks` 表示换音轨时需要重建会话，例如 Plex 图片字幕 |
| `pause`、`resume`、`stop`、`seek` | 当前设备 | 控制命令 |
| `tracks` | 当前设备 | 更换字幕或音轨。带上字幕的 VTT URL |
| `deactivate` | 原来的当前设备 | 播放被切到别的设备，本机停止，变成遥控器 |
| `state`、`queue`、`playlists`、`devices` | 所有设备 | 状态变化的广播 |
| `pong` | 发 `ping` 的设备 | 心跳回复，由运行时自动发出 |

**和现有 Drive-In 消息的对应关系**

| 现在 | v1 |
|---|---|
| `play` | `load` |
| `subtitlesAvailable` + `subtitleSelect` | `load.tracks` + `tracks` |
| `status` + `playerState` | `report` |
| `playerAccepted` / `playerRejected`（单播放器互踢） | `welcome` / `deactivate`（多设备，同时只有一台在播） |
| `queueUpdated` / `playlistsUpdated` | `queue` / `playlists` |
| `reload` | 保留，只在开发环境用 |

现在播放器会自己调用 `/api/play` 和 `/api/plex/play` 来做恢复、Plex 跳转和切换清晰度。到了 v1，这些都改成调用 `POST /v1/playback/play`，带上 `reason`，由 Hub 统一调度。

## 8. 控制面到节点的内部接口

节点只监听 `127.0.0.1`，控制面通过 Workers VPC binding（经 Cloudflare Tunnel）访问它，节点没有公网地址。每个请求都带 `nodeSecret` 签名，作为纵深防御。控制面对节点的调用统一走 `nodeFetch()`；如果 Workers VPC 不可用，可以只改配置，切换到"Tunnel 公网域名 + Access service token"。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/v1/health` | 版本号、运行时长、`legacy`（Drive-In 播放器）、`sources`（每个片源的状态）、`plugins`（每个插件的加载状态和错误） |
| POST | `/internal/v1/claim` | `{ url }`，返回 `{ source }`：按顺序问片源插件，第一个认领的胜出；没人认领时返回 `not_found`。控制面每次播放网址前都先调用 |
| POST | `/internal/v1/prepare` | 参数为 `{ sessionId, source, capabilities, viewport, startTime, reason, tracks }`，返回流描述。**同一个 `sessionId` 重复调用会重建会话**，节点重启后的恢复和 Plex 跳转都靠这一点 |
| POST | `/internal/v1/sessions/:id/stop` | 停止会话，作废 token，回收 ffmpeg 和 Plex 转码 |
| POST | `/internal/v1/sessions/:id/tracks` | 更换音轨。Plex 的图片字幕需要重建会话 |
| POST | `/internal/v1/sessions/:id/progress` | 控制面转发播放进度。节点负责回写 Plex 进度，以及检测 Plex 会话是否失效 |
| POST | `/internal/v1/sessions/:id/control` | `{ action: pause \| resume \| stop \| seek, position? }`。只用于节点渲染器（见下文），实时设备的控制命令由 Hub 直接发 |
| GET | `/internal/v1/tracks?source=` | 列出某个来源可选的音轨，`source` 是 Source 的 JSON |
| POST | `/internal/v1/metadata` | `{ source }` 或 `{ url }`（先认领），返回 `{ source, title, thumbnail, duration, isLive }`。`search` 解析 URL、加入队列时补全标题都用它 |
| GET | `/internal/v1/renderers` | 节点自己驱动的播放器（节点渲染器）列表，包括在线状态和当前进度 |
| GET | `/internal/v1/library/…` | 和第 5 节的库接口一一对应。片库和条目的 id 是 `<片源>:<id>`，节点按前缀找到片源插件；搜索和片库列表合并所有片源的结果，失败的片源列在 `unavailable` 里 |
| POST | `/internal/v1/playlists/expand` | `{ url }`，按顺序交给片源插件展开，返回 `{ title, url, items: [{ source, title, thumbnail, duration }] }` |
| POST | `/internal/v1/owner-code/verify` | `{ code }`，检查用户本人的配对码（第 3 节），不消耗。错了也算一次尝试 |
| POST | `/internal/v1/owner-code/consume` | `{ code }`，检查并用掉配对码。控制面在 passkey 校验通过之后、保存之前调用 |
| GET | `/m/{token}/…` | 媒体流，用现有的代理、DASH 转 HLS、Plex HLS、字幕实现 |

节点离线时：`prepare` 返回 `node_offline`。页面、MCP、队列管理照常可用，播放器显示"媒体节点离线"。节点离线时加进队列的网址保持未认领的 `{ url }`，播放时再认领。

**0.2 的变化**：路径还是 `/internal/v1`，但 Source 的格式变了（第 4 节），所以控制面和节点必须一起升级：旧控制面发给新节点的 `{kind}` 会被拒绝，新控制面发给旧节点的 `{plugin}` 也一样。具体是：新增 `POST /claim`；`/metadata` 接受 `{ url }`，返回里多了 `source`；`/health` 用 `sources` 和 `plugins` 代替原来固定的 `library` 和 `ytdlp` 字段；`/playlists/expand` 返回插件的 Source；`/prepare`、`/tracks`、`/sessions/:id/tracks` 只接受插件的 Source，插件没加载时返回 `not_found`。

**节点渲染器**：节点可以自己驱动一个播放器，控制面把它当成设备，id 为 `node:<id>`，命令经 `/internal/v1/sessions/:id/control` 转给节点。v1 用它接上现有的 Drive-In 服务（`node:legacy`）：在媒体管线搬进节点之前，agent 通过它控制车上现在的播放器。

**配对码只能在本机签发**：签发接口 `POST /local/v1/owner-code` 不在上表里，也不在节点的 TCP 端口上，只挂在节点的本地 Unix socket 上（默认是仓库根目录的 `.yolo-node.sock`，权限 0600，可用 `NODE_LOCAL_SOCKET` 修改），由 `npm run owner-code` 调用，请求同样要带 `nodeSecret` 签名。签名区分不了请求来自用户本人还是控制面：控制面持有 `nodeSecret`，还会把公网上的 `/m/*` 路径签名后转给节点。cloudflared 和 Workers VPC 只能连 TCP 地址，连不到 Unix socket，所以控制面和公网都没法签发配对码。另开一个回环端口也能做到，但前提是 tunnel 永远不指向它，所以没有选。

**请求签名**：请求头 `x-yolo-timestamp` 和 `x-yolo-signature`，签名为 `HMAC-SHA256(nodeSecret, 时间戳\n方法\n路径和查询串\nSHA-256(请求体))`，base64url 编码。时钟偏差超过 5 分钟即拒绝。

## 9. 数据（D1，所有表都带 `user_id`）

| 表 | 内容 |
|---|---|
| `users`、`passkeys` | 用户 id、显示名；passkey 凭证（credential id、公钥、签名计数） |
| `devices` | id、user_id、名称、类型、能力、最后在线时间 |
| （KV）OAuth 客户端、授权、token | 由 `@cloudflare/workers-oauth-provider` 存在 `OAUTH_KV`，token 和密钥只存哈希，`props` 加密存储。所以 D1 里没有 `oauth_*` 表 |
| `nodes` | id、user_id、地址、密钥哈希、版本 |
| `queue_items` | 由现在的表迁移过来，`source_type/url/rating_key` 合并成 `source` JSON |
| `playlists`、`playlist_items` | 同上 |
| `history` | source_key、标题、进度、时长、播放次数、更新时间。只保留最近 500 条。取代 `.play-history.json` |
| `track_preferences` | source_key、选择。`default` 行记录最近一次的偏好。取代 `subtitle_preferences` |

播放状态存在 Hub DO 自己的存储里，不进 D1。用户本人的配对码只在节点内存里，也不进 D1；以前存用过的初始化码的 `init_codes_used` 表由迁移 `0002` 删掉了。迁移脚本（`service/node/scripts/export-legacy-to-d1.js`）把现有的 SQLite 和 JSON 数据一次性导出成 SQL，再用 `wrangler d1 execute` 导入 D1。

## 10. MCP 工具（服务名 `yolo`）

| 工具 | 参数 | 注解 |
|---|---|---|
| `get_status` | 无 | readOnly |
| `list_devices` | 无 | readOnly |
| `search` | `query, type?` | readOnly。在媒体库里搜索；如果参数是 URL，就解析出标题 |
| `browse` | `library_id?, item_id?` | readOnly |
| `play` | `url? \| item_id? \| queue_item_id?, device?, start_at?` | |
| `control` | `action: pause\|resume\|stop\|next\|previous` | |
| `seek` | `position_seconds` | |
| `transfer` | `device` | |
| `list_tracks` | `item_id?` | readOnly |
| `set_tracks` | `subtitles?: string[], audio?: string` | |
| `queue_list` / `queue_add` / `queue_remove` | `url \| item_id, position?` / `queue_item_id` | 删除标 destructive |
| `queue_clear` | 无 | destructive |
| `playlist_list` / `playlist_get` | `playlist_id?` | readOnly |
| `playlist_create` / `playlist_add` / `playlist_import` / `playlist_enqueue` | 各自参数 | |
| `playlist_delete` | `playlist_id` | destructive |
| `history` | `limit?` | readOnly |

补充约定：

- 注解按上表设置：只读工具标 readOnly，删除类标 destructive。其余写操作显式标 `destructiveHint: false`，因为 MCP 默认把非只读工具当成 destructive。`queue_list` 是读操作，也标 readOnly。
- 每个工具只要求一个 scope：只读工具要 `read`；`play`、`control`、`seek`、`transfer`、`set_tracks` 要 `control`；改队列和播放列表的工具要 `manage`。
- `item_id` 是库条目 id，格式为 `<片源>:<id>`，例如 `plex:<ratingKey>`。`list_tracks` 的 `item_id` 也可以是 URL。
- 工具描述不提具体的片源或网站，能播哪些网站、有哪些片库取决于节点上的片源插件。控制面插件可以加工具（[yolo-plugins.md](yolo-plugins.md) 第 4 节），用同一套 scope。
- `play` 不带 `start_at` 时，从历史记录里的进度接着播。
- 出错时工具返回 `isError: true`，内容是第 5 节的错误 JSON。

服务描述要写清楚三点：

1. Yolo 是什么。
2. 播放前先搜索，不要猜 ID。
3. 默认在当前设备上播放。

## 11. 待确认

见 [yolo-decisions.md](yolo-decisions.md#待定)，以那里的列表为准。

## 12. 实现状态（2026-10-11）

| 部分 | 状态 | 位置 |
|---|---|---|
| MCP（第 10 节全部 22 个工具，Streamable HTTP） | 已实现 | `service/control/src/mcp/` |
| OAuth：动态注册、CIMD、授权码 + PKCE、可轮换的 refresh token、三个 scope、授权页 | 已实现 | `service/control/src/index.js`、`auth/` |
| 用户本人 passkey 登录 + 节点签发的 6 位配对码（首次注册和重置） | 已实现。服务端流程和 `npm run owner-code` 在本地验证过，还没用真实浏览器和 passkey 测过 | `service/control/src/auth/`、`service/node/src/owner-code.js`、`local.js` |
| `/v1` HTTP API（第 5 节） | 已实现 | `service/control/src/api/v1.js` |
| Hub DO、`/v1/realtime`（票据、`hello`/`welcome`、`report`、`ended`、自动回复心跳、连接和消息限额） | 已实现，还没有客户端使用；心跳和限额 2026-10-11 在本地 Worker 上验证过 | `service/control/src/hub/` |
| D1 表（第 9 节） | 已实现。`0003` 把 0.1 的数据改成插件的 Source | `service/control/migrations/` |
| `nodeFetch()`：Workers VPC，可切换到 Tunnel + Access；拒绝调用 Worker 自己，Worker 拒绝带节点签名的请求（508） | 已实现 | `service/control/src/node-client.js` |
| 插件框架（0.2）：`@useyolo/plugin-api`、节点加载器和片源注册表、控制面构建时打包插件、`yolo.config.json` | 已实现，接口为实验性 | `service/plugin-api/`、`service/node/src/plugins.js`、`sources.js`、`service/control/src/plugins.js`、`scripts/generate-plugins.js` |
| 官方片源插件：Plex、yt-dlp | 已实现 | `plugins/source-plex/`、`plugins/source-ytdlp/` |
| 节点：健康检查、库、元数据、音轨、播放列表展开、网址认领 | 已实现，全部经过片源插件 | `service/node/src/app.js` |
| 节点：`prepare` 和会话 | 只支持节点渲染器 `node:legacy`，播放仍由 `server/` 完成，只能播放两个官方插件的 Source | `service/node/src/legacy.js` |
| 节点：`/m/*` 媒体流、给实时设备的 `prepare` | 没实现，要把 `server/` 的媒体管线搬过来 | |
| 媒体 URL 签名 | 控制面已签发，节点还没有校验的地方 | `service/core/src/signing.js` |
| 设备码登录（RFC 8628）、扫码配对 | 没实现。`workers-oauth-provider` 不支持设备码授权，需要自己做 | |
| 设置页（撤销客户端、管理 passkey） | 没实现 | |
| Drive-In 播放器改用 v1 协议 | 没实现 | |

实现时对草案做的取舍：

- token 的 audience 是部署的源（例如 `https://yolo.haitian.site`），这样一个 token 同时覆盖 `/mcp` 和 `/v1`。protected resource 元数据在 `/.well-known/oauth-protected-resource`。
- Agent 默认申请全部三个 scope（`requiredScopes`），用户可以在授权页取消勾选。scope 之间没有包含关系。
- 删除设备目前只是删掉设备记录。设备 token 要等设备码登录做完才有。
- 配对码重置只删 passkey 和网页登录会话，不撤销已经授权给 agent 的 OAuth token。设置页做好之前，要撤销 agent 只能手动删 `OAUTH_KV` 里的记录。

**部署和第一次登录**

在 `service/control` 下：

1. `npx wrangler secret put NODE_SECRET`，值和家里 `.env` 里的 `NODE_SECRET` 相同。用户本人登录不需要别的 secret。
2. `npx wrangler d1 migrations apply yolo --remote`。从 0.1 升级时，这一步会执行 `0003`，紧接着做第 3 步，并重启节点（第 8 节「0.2 的变化」）。
3. `npx wrangler deploy`。

在家里机器的仓库根目录下：

4. `npm install`（新增了工作区时必须做，否则节点找不到 `@useyolo/plugin-api`），然后 `npm run dev:node` 启动节点。cloudflared 要在运行，Workers VPC 服务指向 `127.0.0.1:9191`（见 `wrangler.jsonc`）。没有 `yolo.config.json` 时节点加载官方插件，见 [yolo-plugins.md](yolo-plugins.md) 第 5 节。
5. `npm run owner-code`，然后在 15 分钟内打开 `https://yolo.haitian.site/login`，输入打印出来的 6 位码，创建 passkey。passkey 全丢时，重复这一步就是重置。
