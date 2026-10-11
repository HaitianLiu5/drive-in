import { execFileSync } from "node:child_process";
import { YoloError } from "@useyolo/plugin-api";
import { createPlex } from "./plex.js";

// Official source plugin: a Plex Media Server library (decision 22: Plex is
// an optional source; Yolo keeps its own history and progress).
//
// Options (yolo.config.json), each falling back to the environment:
//   url    PLEX_URL, else http://localhost:32400
//   token  PLEX_TOKEN, else on macOS the token Plex Media Server keeps in its
//          own preferences (the same default as the Drive-In server)
//
// Sources: { plugin: "plex", id: <ratingKey> }. Plex does not claim URLs.

export const SOURCE_ID = "plex";
const DEFAULT_URL = "http://localhost:32400";

function tokenFromPlexPreferences() {
  try {
    return execFileSync("defaults", ["read", "com.plexapp.plexmediaserver", "PlexOnlineToken"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return "";
  }
}

// The source's methods over a client; `client()` throws until "start".
export function createPlexSource(client) {
  return {
    health: async () => client().health(),
    describe: async (source) => client().describe(source.id),
    tracks: async (source) => client().tracks(source.id),
    libraries: async () => client().libraries(),
    items: async (sectionKey, page) => client().libraryItems(sectionKey, page),
    children: async (ratingKey) => client().children(ratingKey),
    search: async (query, options) => client().search(query, options),
    artwork: async (ratingKey, variant) => client().artwork(ratingKey, variant),
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function plexPlugin(yolo, { readToken = tokenFromPlexPreferences } = {}) {
  let plex = null;

  // Reading the token may run `defaults`, so it waits for "start".
  yolo.on("start", () => {
    const url = String(yolo.options.url || yolo.env.PLEX_URL || DEFAULT_URL);
    const token = String(yolo.options.token || yolo.env.PLEX_TOKEN || readToken() || "");
    plex = createPlex({ url, token });
    if (!plex.configured) yolo.log.warn("No Plex token: set PLEX_TOKEN or the plugin's token option");
  });
  yolo.on("shutdown", () => {
    plex = null;
  });

  yolo.registerSource(SOURCE_ID, createPlexSource(() => {
    if (!plex) throw new YoloError("internal", "The Plex source has not started");
    return plex;
  }));
}
