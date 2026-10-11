-- Owner pairing codes are now issued and checked by the home media node and
-- never stored in Cloudflare (decision 16), so the used-init-code table from
-- 0001 is no longer read or written. Nothing references it.
DROP TABLE IF EXISTS init_codes_used;
