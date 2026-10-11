// Map-backed stand-in for a Workers KV namespace (get/put/delete/list).
export function createMemoryKv() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
    // Pages of two, so callers have to follow the cursor (the last key seen).
    async list({ prefix = "", cursor } = {}) {
      const names = [...map.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      const keys = names.slice(0, 2).map((name) => ({ name }));
      const done = names.length <= 2;
      return { keys, list_complete: done, ...(done ? {} : { cursor: keys.at(-1).name }) };
    },
  };
}
