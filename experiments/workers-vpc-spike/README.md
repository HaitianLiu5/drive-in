# Workers VPC 实验

这个实验验证决策 17（见 [yolo-decisions.md](../../docs/yolo-decisions.md)）：控制面能不能通过 Workers VPC 稳定地透传视频流。

- 通过：继续用 Workers VPC。
- 不通过：改用 Tunnel 公网域名 + Access service token。

这是一次性的实验，不属于任何 workspace，`npm run check` 不会覆盖它。

## 测什么

一个 Worker 把所有请求转发到家里的 Drive-In，有两条路径：

| 路径 | 走法 |
|---|---|
| `vpc`（默认） | Worker → VPC Service binding → Tunnel → `localhost:9090` |
| `public`（加 `?__via=public`） | Worker → 现有的 Tunnel 公网域名 → `localhost:9090` |

`bench.mjs` 在你的电脑上运行：

- 每 4 秒请求一次约 1.5MB 的静态文件，两条路径交替，大小相当于 720p 视频约 2.5 秒的一个分片。
- 默认连续跑 60 分钟。
- 每个请求都带一个随机查询串，让 `public` 路径绕开 Cloudflare 缓存；万一命中缓存，这个样本会被记为失败。

**通过标准**（三条都要满足）：

1. VPC 路径的失败率不超过 0.5%。
2. VPC 路径的慢尾吞吐（p5）不低于 10 Mbps，也就是 720p 码率 4.8 Mbps 的两倍。
3. VPC 路径的首字节时间 p95，不超过 public 路径 p95 的 1.5 倍再加 100ms。

## 准备

- 家里那台机器上运行着 Drive-In（`npm run start`，端口 9090），以及现有的 `cloudflared` tunnel。
- 本机装有 Node.js 22，并且已经运行过 `npx wrangler login`。
- 跑满 1 小时，家里的上行流量大约是 1.3GB，平均约 3 Mbps，和正常看一小时 720p 视频差不多。

## 步骤

在 `experiments/workers-vpc-spike/` 目录下执行。

1. 查 tunnel ID：

   ```bash
   cloudflared tunnel list
   ```

2. 创建 VPC Service，指向家里机器上的 Drive-In：

   ```bash
   npx wrangler vpc service create yolo-spike-node \
     --type http --tunnel-id <TUNNEL_ID> --ipv4 127.0.0.1 --http-port 9090
   ```

   把返回的 service ID 填进 `wrangler.jsonc` 的 `service_id`。再把 `PUBLIC_ORIGIN` 改成你现有的 tunnel 公网域名。

3. 设置访问令牌，然后部署：

   ```bash
   export SPIKE_TOKEN=$(openssl rand -hex 24)
   echo "$SPIKE_TOKEN" | npx wrangler secret put SPIKE_TOKEN
   npx wrangler deploy
   ```

   这个 Worker 等于给家里的 Drive-In 开了一个新入口，所以没有令牌的请求一律返回 401。

4. 先确认两条路径都通：

   ```bash
   curl -H "Authorization: Bearer $SPIKE_TOKEN" \
     https://yolo-spike-vpc.<你的子域>.workers.dev/__spike/health
   ```

   `vpc` 和 `public` 都应该返回 `"ok": true`。

5. 跑一小时：

   ```bash
   node bench.mjs --worker https://yolo-spike-vpc.<你的子域>.workers.dev --minutes 60
   ```

   - 每分钟打印一行汇总，失败的请求会单独打印出来。
   - 结束时打印结论（PASS 或 FAIL）。原始数据写进 `vpc-spike-*.json`。
   - 中途按一次 Ctrl+C 会提前结束，照样出结论。

6. 可选：用真实播放器测一次。在特斯拉或电脑浏览器里打开：

   ```
   https://yolo-spike-vpc.<你的子域>.workers.dev/__spike/login?token=<SPIKE_TOKEN>
   ```

   这样会写入一个 cookie，然后跳转到播放器。之后的页面、WebSocket 和视频流都走 VPC 路径。找一部电影看半小时以上，留意有没有卡顿、断流、控制失灵。`bench.mjs` 测不到这三样：真实 HLS 的节奏、WebSocket 长连接、Plex 转码流。

7. 把结论写回 [yolo-decisions.md](../../docs/yolo-decisions.md) 的决策 17。

## 清理

```bash
npx wrangler delete
npx wrangler vpc service delete <SERVICE_ID>
```
