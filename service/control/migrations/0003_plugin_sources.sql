-- Sources become plugin-owned (Yolo 0.2, decisions 20 and 21). A source is now
-- {"plugin": <source id>, "id": <item id>, …} and its key is "<plugin>:<id>";
-- see docs/yolo-plugins.md. Rows written before plugins used
-- {"kind": "plex" | "url", …}. Those two kinds now belong to the official
-- source plugins, so this one-time data migration names them:
--
-- - Plex items become {"plugin":"plex","id":<ratingKey>}. Their key,
--   "plex:<ratingKey>", does not change.
-- - URLs in the queue and in playlists become unclaimed {"url": …}; the node
--   asks its source plugins to claim them when they play.
-- - History and track preferences of URLs were keyed "url:<canonical URL>".
--   The yt-dlp plugin uses the same canonical URL as its id, so they move to
--   "ytdlp:<canonical URL>" and keep their resume positions and choices.
--
-- The Hub keeps its playback state outside D1; a state saved before plugins
-- reads as idle (HubCore.state()).

UPDATE queue_items
SET source = json_object('plugin', 'plex', 'id', CAST(json_extract(source, '$.ratingKey') AS TEXT))
WHERE json_extract(source, '$.kind') = 'plex';

UPDATE queue_items
SET source = json_object('url', json_extract(source, '$.url'))
WHERE json_extract(source, '$.kind') = 'url';

UPDATE playlist_items
SET source = json_object('plugin', 'plex', 'id', CAST(json_extract(source, '$.ratingKey') AS TEXT))
WHERE json_extract(source, '$.kind') = 'plex';

UPDATE playlist_items
SET source = json_object('url', json_extract(source, '$.url'))
WHERE json_extract(source, '$.kind') = 'url';

UPDATE history
SET source = json_object('plugin', 'plex', 'id', CAST(json_extract(source, '$.ratingKey') AS TEXT))
WHERE json_extract(source, '$.kind') = 'plex';

UPDATE history
SET source = json_object('plugin', 'ytdlp', 'id', substr(source_key, 5), 'url', json_extract(source, '$.url')),
    source_key = 'ytdlp:' || substr(source_key, 5)
WHERE json_extract(source, '$.kind') = 'url' AND substr(source_key, 1, 4) = 'url:';

UPDATE track_preferences
SET source_key = 'ytdlp:' || substr(source_key, 5)
WHERE substr(source_key, 1, 4) = 'url:';
