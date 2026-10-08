# Yolo v1 协议草案

状态：草案，待确认。确认后按此实现，Drive-In 成为第一个客户端。背景、决策理由和待定事项见 [yolo-decisions.md](yolo-decisions.md)。

Yolo 是一个私人的、由 agent 驱动的流媒体服务。服务端分两部分：控制面跑在 Cloudflare，媒体节点跑在家里。客户端包括特斯拉 canvas 播放器（Drive-In）、普通浏览器、手机，以及通过 MCP 接入的 agent。

- 官网：`useyolo.app`
- npm：`@useyolo/*`
- MCP 服务名：`yolo`

## 0. 范围

v1 要做的：

- 控制面 + 媒体节点 + Drive-In 客户端 + MCP。
- 单用户。但所有数据表都带 `user_id`。
- 来源类型：URL（yt-dlp）和 Plex。

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
| node | 家里的媒体节点，负责解析、转码、代理、Plex、缓存 |
| source | 内容来源，例如 `{kind:"url"}`、`{kind:"plex"}`，以后还有 `{kind:"spotify"}` |
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
   │  Cloudflare Tunnel + service token
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
| 特斯拉、电视 | 设备码流程（RFC 8628）。车机屏幕显示一个码，用户在手机上打开 `/device` 输入确认 |
| 媒体节点 | 配对时生成 `nodeSecret`，存在节点本地。控制面调用节点时，同时带上 Tunnel service token 和请求签名 |

用户本人登录：v1 用一个管理密码加 passkey（二选一）。授权页和设备确认页都要求先登录。

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
// Source：内容从哪来。可扩展
{ kind: "url", url: "https://www.youtube.com/watch?v=…" }
{ kind: "plex", ratingKey: "12345" }

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

`sourceKey` 是来源的规范化键，用于历史和音轨偏好：

- URL 来源：`url:<规范化后的 URL>`
- Plex 来源：`plex:<ratingKey>`

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
| GET | `/v1/library` | read | 媒体库列表。目前只有 Plex，以后加其他来源 |
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

所有消息共用一个信封格式：`{ v: 1, type, id?, ... }`。带 `id` 的命令需要设备回 `ack`。心跳间隔 25 秒，因为 Cloudflare 空闲 100 秒就会断开连接。

**设备发给服务端**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | 首次连接时没有 `deviceId`，服务端会分配一个 |
| `report` | `status, position, duration, playing, viewport?` | 只有当前设备上报。至少每 5 秒一次，状态变化时立即上报 |
| `ended` | `sessionId` | 播放结束，Hub 从队列取下一项 |
| `error` | `sessionId, code, message` | 播放失败。由 Hub 决定是重建会话还是停止 |
| `ack` | `id` | 确认收到命令 |
| `pong` | `ts` | 心跳回复 |

**服务端发给设备**

| type | 发给谁 | 说明 |
|---|---|---|
| `welcome` | 刚连上的设备 | 包含 `deviceId`、当前的 `state`、`queue`、`playlists` |
| `load` | 当前设备 | 包含流描述、`startTime`、`autoplay`、`reason`（`play`、`recovery`、`seek`、`quality`、`transfer`） |
| `pause`、`resume`、`stop`、`seek` | 当前设备 | 控制命令 |
| `tracks` | 当前设备 | 更换字幕或音轨。带上字幕的 VTT URL |
| `deactivate` | 原来的当前设备 | 播放被切到别的设备，本机停止，变成遥控器 |
| `state`、`queue`、`playlists`、`devices` | 所有设备 | 状态变化的广播 |
| `ping` | 所有设备 | 心跳 |

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

节点只监听 `127.0.0.1`，对外通过 Tunnel 暴露。每个请求都必须同时带上 service token 和 `nodeSecret` 签名。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/v1/health` | 版本号、yt-dlp/ffmpeg/Plex 是否可用、缓存占用 |
| POST | `/internal/v1/prepare` | 参数为 `{ sessionId, source, capabilities, viewport, startTime, reason, tracks }`，返回流描述。**同一个 `sessionId` 重复调用会重建会话**，节点重启后的恢复和 Plex 跳转都靠这一点 |
| POST | `/internal/v1/sessions/:id/stop` | 停止会话，作废 token，回收 ffmpeg 和 Plex 转码 |
| POST | `/internal/v1/sessions/:id/tracks` | 更换音轨。Plex 的图片字幕需要重建会话 |
| POST | `/internal/v1/sessions/:id/progress` | 控制面转发播放进度。节点负责回写 Plex 进度，以及检测 Plex 会话是否失效 |
| GET | `/internal/v1/tracks?source=` | 列出某个来源可选的音轨 |
| GET | `/internal/v1/library/…` | 和第 5 节的库接口一一对应 |
| POST | `/internal/v1/playlists/expand` | 展开外部播放列表的 URL，返回 `Source` 列表 |
| GET | `/m/{token}/…` | 媒体流，用现有的代理、DASH 转 HLS、Plex HLS、字幕实现 |

节点离线时：`prepare` 返回 `node_offline`。页面、MCP、队列管理照常可用，播放器显示"媒体节点离线"。

## 9. 数据（D1，所有表都带 `user_id`）

| 表 | 内容 |
|---|---|
| `users` | id、显示名、密码哈希、passkey |
| `devices` | id、user_id、名称、类型、能力、最后在线时间 |
| `oauth_clients`、`oauth_grants`、`oauth_tokens` | 客户端、授权、token（只存哈希） |
| `nodes` | id、user_id、地址、密钥哈希、版本 |
| `queue_items` | 由现在的表迁移过来，`source_type/url/rating_key` 合并成 `source` JSON |
| `playlists`、`playlist_items` | 同上 |
| `history` | source_key、标题、进度、时长、播放次数、更新时间。取代 `.play-history.json` |
| `track_preferences` | source_key、选择。`default` 行记录最近一次的偏好。取代 `subtitle_preferences` |

播放状态存在 Hub DO 自己的存储里，不进 D1。迁移脚本负责把现有的 SQLite 和 JSON 数据一次性导入 D1。

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

服务描述要写清楚三点：

1. Yolo 是什么。
2. 播放前先搜索，不要猜 ID。
3. 默认在当前设备上播放。

## 11. 待确认

见 [yolo-decisions.md](yolo-decisions.md#待定)，以那里的列表为准。
