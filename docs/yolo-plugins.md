# Yolo 插件开发指南

状态：**实验性**，随 Yolo 0.2 实现，2026-10-11。1.0 之前插件接口可以不兼容地修改。设计和理由见 [yolo-roadmap.md 第 3 节](yolo-roadmap.md#3-插件模型) 和[决策 19–24](yolo-decisions.md)，节点接口见 [yolo-v1.md 第 8 节](yolo-v1.md#8-控制面到节点的内部接口)。

做法参考 pi 的扩展机制（`badlogic/pi-mono` 的 `extensions.md` 和 `packages.md`）：插件是导出工厂函数的普通 npm 包，在工厂函数里注册能力，按加载顺序执行。

## 1. 插件是什么

一个插件就是一个 npm 包，`package.json` 的 `yolo` 字段写明两个入口：

```json
{
  "name": "@someone/yolo-source-example",
  "type": "module",
  "yolo": { "node": "./src/node.js", "control": "./src/control.js" },
  "peerDependencies": { "@useyolo/plugin-api": "*" }
}
```

| 入口 | 跑在哪里 | 什么时候加载 | 0.2 能注册什么 |
|---|---|---|---|
| `node` | 家里的媒体节点（Node.js） | 节点启动时 | 片源：`yolo.registerSource` |
| `control` | 控制面（Cloudflare Worker） | 部署时打包进 Worker | MCP 工具：`yolo.registerTool` |

两个入口都可以没有，但至少要有一个。每个入口都是 ES 模块，默认导出一个工厂函数 `(yolo) => void | Promise<void>`。Yolo 调用它一次，传入对应一侧的 API。

宿主提供的包（目前只有 `@useyolo/plugin-api`）要写在 `peerDependencies` 里，不要写进 `dependencies`。节点加载插件时，会把插件里的 `import "@useyolo/plugin-api"` 指向节点自己的那一份，所以插件装在哪个目录都能加载，而且和节点共用同一个 `YoloError` 类。插件自己用到的其他包照常写进 `dependencies`。

0.2 只实现了片源插件和 MCP 工具。元数据、协议、设备这三类插件在路线图里，接口还没有。

## 2. 节点入口和片源

```js
import { YoloError } from "@useyolo/plugin-api";

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function (yolo) {
  yolo.registerSource("example", {
    claim: (url) => (new URL(url).hostname === "video.example" ? { id: new URL(url).pathname, url } : undefined),
    describe: async (source) => ({ title: `Video ${source.id}`, thumbnail: null, duration: 60 }),
  });
}
```

`yolo` 上有：

| 成员 | 说明 |
|---|---|
| `plugin` | `{ name, version }`，取自插件的 `package.json` |
| `options` | 配置文件里这个插件的 `options`，只读，没有时是 `{}` |
| `env` | 节点的环境变量，已经读过仓库根目录的 `.env` |
| `log` | `debug`、`info`、`warn`、`error`，每行自动带插件名 |
| `registerSource(id, impl)` | 注册一个片源。`id` 只能用小写字母、数字和 `-`，以字母开头，整个节点内唯一 |
| `on("start" \| "shutdown", fn)` | 生命周期事件，见第 3 节。返回一个取消订阅的函数 |

### Source 和 sourceKey

片源里的每个条目用一个 Source 表示：

```js
{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }
```

- `plugin` 由 Yolo 填成片源的 `id`，插件返回 Source 时不用写。
- `id` 由插件决定，表示条目在这个片源里是谁。数字会被转成字符串。
- 其他字段都归插件所有。Yolo 原样保存在队列、播放列表和历史里，不会去读。整个 Source 的 JSON 不能超过 4KB。
- `<plugin>:<id>` 是这个条目的 **sourceKey**。历史、续播进度和字幕偏好都按它保存，片库条目的 id 也是它。所以同一个内容，插件每次都必须给出同一个 `id`。官方 yt-dlp 插件用规范化后的网址作为 `id`，同一个视频的不同写法因此共用一条历史。

网址在被认领之前是一个未认领的引用 `{ url }`。节点离线时，加进队列的网址就保持这个样子，等到播放时再交给节点认领。

### 片源可以实现的方法

所有方法都是可选的，没实现的能力 Yolo 不会调用。方法只会在插件的 `start` 处理器执行完之后才被调用。

| 方法 | 用途 | 返回 |
|---|---|---|
| `claim(url)` | 认领一个 http(s) 网址 | Source（不含 `plugin`），或 `undefined` 交给下一个片源 |
| `expand(url)` | 展开播放列表或合集网址（`playlist_import`） | `{ title, items: [{ source, title, thumbnail, duration }] }`，或 `undefined` 交给下一个 |
| `describe(source)` | 标题、封面、时长 | `{ title, thumbnail?, artwork?, duration?, isLive? }` |
| `tracks(source)` | 字幕和音轨 | `{ subtitles: Track[], audio: Track[] }`。不实现就当作没有 |
| `libraries()` | 片库列表 | `[{ id, title, type }]` |
| `items(libraryId, { offset, limit })` | 浏览片库，分页 | `{ total, offset, items: LibraryItem[] }` |
| `children(itemId)` | 剧集、季等子项 | `{ parent?, items: LibraryItem[] }` |
| `search(query, { type, limit })` | 搜索 | `LibraryItem[]` |
| `artwork(itemId, variant)` | 封面图 | 一个图片 `Response` |
| `health()` | 状态，出现在 `/internal/v1/health` 里 | 任意对象 |

规则：

- **认领按顺序进行**。节点收到网址时，按配置里的加载顺序、同一插件内按注册顺序依次调用 `claim`，第一个返回 Source 的片源胜出。`expand` 也一样。官方 yt-dlp 插件会认领所有 http(s) 网址，所以要优先处理网址的插件应该排在它前面。
- **`claim` 要快，而且不能联网**：控制面每次播放网址前都会先调用它。需要网络请求的事放到 `describe` 里做。`claim` 抛错时，错误会直接返回给调用方，不会交给下一个片源。
- **片库 id 是本地的**。`libraries`、`items`、`children`、`search` 返回的 `id` 和传进来的 `libraryId`、`itemId` 都是插件自己的 id，Yolo 对外加上前缀 `<片源 id>:`。播放某个条目，就是播放 Source `{ plugin: <片源 id>, id }`。
- **封面**可以用 `thumbnail` 给一个 http(s) 地址，也可以用 `artwork: "poster"` 这样的变体名。用变体名时，Yolo 把它换成控制面的 `/v1/library/items/<id>/artwork?variant=…`，请求最终落到这个片源的 `artwork(itemId, variant)` 上。
- **报错**用 `YoloError(code, message)`，code 见 [yolo-v1.md 第 5 节](yolo-v1.md#5-http-api控制面v1)，例如 `not_found`、`resolve_failed`。其他异常会变成 `internal`。
- **多个片源一起搜索**：`libraries` 和 `search` 会问所有实现了它们的片源。只要有一个成功，就返回结果，失败的片源列在 `unavailable` 里。

## 3. 生命周期

1. **加载**：节点按配置顺序导入每个插件的 `node` 入口并调用工厂函数。工厂函数里只做注册，**不要启动进程、socket、定时器或文件监听**。同步注册即可，也可以是 async 函数。
2. **`start`**：所有工厂函数执行完后，节点按加载顺序执行各插件的 `start` 处理器。长期占用的资源在这里创建。单个处理器超过 30 秒没完成就算失败。
3. **`shutdown`**：节点收到 SIGTERM 或 SIGINT 时，按加载顺序执行 `shutdown` 处理器，最多等 5 秒。处理器必须**可以重复执行**，而且在什么都没启动时也不能报错。

出错时：

| 情况 | 结果 |
|---|---|
| 入口找不到、导入失败、工厂函数抛错 | 这个插件标记为 `failed`，它已经注册的东西全部丢弃，其他插件照常加载 |
| `start` 处理器抛错或超时 | 插件标记为 `failed`，它的片源被移除，并执行它的 `shutdown` 处理器来释放已经启动的资源 |
| `shutdown` 处理器抛错 | 记日志，其他处理器照常执行 |

不管哪种情况，节点都继续运行。`/internal/v1/health` 的 `plugins` 列出每个插件的状态（`started`、`failed`、`disabled`、`stopped`）和错误原因，节点启动时也会打印一遍。

## 4. 控制面入口和 MCP 工具

Worker 不能在运行时加载代码，所以 `control` 入口在部署时打包：`wrangler.jsonc` 的构建命令会先运行 `service/control/scripts/generate-plugins.js`，它读取和节点同一份配置，生成 `service/control/src/plugins.generated.js`，用静态 `import` 引入每个启用插件的 `control` 入口。`wrangler dev`、`wrangler deploy` 和 `npm run check` 里的 dry-run 构建都会自动重新生成。配置里有插件找不到时，构建直接失败，不会悄悄漏掉它。

```js
/** @param {import("@useyolo/plugin-api").YoloControlAPI} yolo */
export default function (yolo) {
  const { z } = yolo;
  yolo.registerTool({
    name: "queue_length",
    title: "Queue length",
    description: "How many items are waiting in the queue.",
    scope: "read",
    annotations: { readOnlyHint: true },
    input: z.object({}),
    run: async (args, { services }) => ({ queued: (await services.listQueue()).length }),
  });
}
```

- `yolo` 上有 `plugin`、`options`、`log`、`z`（宿主的 zod）和 `registerTool`。
- 工具名用 `lower_snake_case`，不能和 Yolo 自带的 22 个工具或别的插件重名。
- `scope` 是调用它需要的唯一一个 OAuth scope：`read`、`control` 或 `manage`。
- `annotations` 默认是「非只读、非破坏性」。
- `input` 是一个对象 schema，用 `yolo.z.object({...})` 写。
- `run(args, { services })` 的返回值以 JSON 返回给 agent。抛出 `YoloError` 时，工具返回 `isError` 和对应的错误码。`services` 就是 MCP 工具和 `/v1` 共用的那层服务。
- 工厂函数在第一次 MCP 请求时执行，不在 Worker 的全局作用域里执行。
- **插件的 `options` 会原样打包进 Worker 代码**，不要在 `control` 插件的选项里放密钥，密钥用 Worker secret。

## 5. 配置

| 情况 | 加载什么 |
|---|---|
| 设置了 `YOLO_CONFIG` | 这个文件（绝对路径，或者相对仓库根目录的路径；也可以写在 `.env` 里） |
| 仓库根目录有 `yolo.config.json` | 这个文件。它被 git 忽略，可以从 `yolo.config.example.json` 复制 |
| 都没有 | `plugins/official.json`：两个官方片源插件，选项全部取自环境变量（零配置默认） |

格式：

```json
{
  "plugins": [
    { "source": "./plugins/source-plex", "options": { "url": "http://localhost:32400" } },
    { "source": "@someone/yolo-source-example" },
    { "source": "./plugins/source-ytdlp", "enabled": false }
  ]
}
```

- `source` 是相对配置文件的路径（以 `.` 或 `/` 开头），或者一个 npm 包名。包名从配置文件所在目录往上找 `node_modules`，所以先在仓库根目录 `npm install` 它。只写字符串，等于只给 `source`。
- **列表就是完整的加载清单，顺序就是加载顺序**。没列出的插件，包括官方插件，都不会加载；`"enabled": false` 也可以关掉一个插件。
- `options` 原样交给插件的 `yolo.options`。
- 改了配置之后：重启节点；如果涉及 `control` 入口，还要重新部署控制面。

## 6. 信任模型

和 pi 一样，**插件没有权限系统**。节点插件跑在节点进程里，拥有节点的全部权限：能读 `.env`、`NODE_SECRET`、文件系统，也能访问局域网。控制面插件跑在 Worker 里，能用 Worker 的所有 binding，包括 D1 和 OAuth 数据。安装插件之前先审查代码，并固定版本。

## 7. 官方插件

两个官方插件就是按这份指南写的，可以当示例看：

| 插件 | 目录 | 片源 id | Source | 做了什么 |
|---|---|---|---|---|
| `@useyolo/source-plex` | `plugins/source-plex` | `plex` | `{ plugin: "plex", id: <ratingKey> }` | 片库的浏览、搜索、详情、音轨和封面。不认领网址。在 `start` 里读取 `options.url`/`token`，没有就用 `PLEX_URL`、`PLEX_TOKEN`，在 macOS 上最后再从 Plex Media Server 自己的偏好设置里读 token |
| `@useyolo/source-ytdlp` | `plugins/source-ytdlp` | `ytdlp` | `{ plugin: "ytdlp", id: <规范化网址>, url: <原始网址> }` | 认领所有 http(s) 网址，用 yt-dlp 取元数据和字幕，展开播放列表。选项 `binary`、`cookiesFile`、`cookiesFromBrowser`，没有就用 `YTDLP_COOKIES_FILE`、`YTDLP_COOKIES_FROM_BROWSER`。每次调用都起一个短命的 yt-dlp 进程，所以不需要 `start` |

两者都没有 `control` 入口，测试在各自目录的 `test/` 里。

## 8. 0.2 的限制

- 播放仍然借用旧的 Drive-In server（节点渲染器 `node:legacy`）。`service/node/src/legacy.js` 只认识两个官方插件的 Source：Plex 条目走它的 Plex 接口，带 `url` 字段的 Source 按网址播放。其他插件的条目可以浏览、搜索、加进队列，但还不能播放。0.3 把媒体管线搬进节点之后，片源插件会多一个「提供可播放输入」的方法。
- 还没有 `yolo install` 命令，改配置要手动重启节点、重新部署控制面。
- 元数据、协议、设备三类插件还没有接口。
