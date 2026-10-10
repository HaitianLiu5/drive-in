import { McpServer } from "@modelcontextprotocol/server";
import { toYoloError, YoloError } from "@useyolo/core";
import { TOOLS } from "./tools.js";

// Server description (yolo-v1.md §10). It must say what Yolo is, that agents
// search before playing, and that playback defaults to the active device. It
// also heads off confusion with "YOLO mode" in coding agents.
export const INSTRUCTIONS = [
  "Yolo is the user's private media service, not a \"YOLO mode\" or auto-approve setting.",
  "It plays videos from URLs (YouTube, Bilibili, and other sites yt-dlp supports) and from the user's home media library on the user's screens, such as the Drive-In player in their Tesla, and keeps a queue, playlists, and watch history.",
  "Search before you play: use search or browse to get item ids, and never guess an id. A URL the user gives can be played directly.",
  "Playback goes to the active device by default. Pass device only when the user names one; list_devices shows the choices.",
  "If a tool returns node_offline, the home media node is unreachable: queue, playlists, and history still work, but playing and browsing the library do not.",
].join("\n");

export const SERVER_INFO = Object.freeze({ name: "yolo", title: "Yolo media service", version: "0.1.0" });

// Each tool names the one scope it needs (yolo-v1.md §3). Scopes do not imply
// each other: a token with only `manage` cannot read status.
export function hasScope(scopes, needed) {
  return Array.isArray(scopes) && scopes.includes(needed);
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
}

function failure(error) {
  const { code, message, retryable } = toYoloError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, retryable } }) }],
  };
}

// `getContext()` returns { services, scopes } for the current request.
export function createYoloMcpServer(getContext) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { title: tool.title, ...tool.annotations },
    }, async (args, ctx) => {
      try {
        const { services, scopes } = await getContext(ctx);
        if (!hasScope(scopes, tool.scope)) {
          return failure(new YoloError("forbidden", `${tool.name} needs the "${tool.scope}" scope; reconnect Yolo and allow it`));
        }
        return result(await tool.run(services, args ?? {}));
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
}
