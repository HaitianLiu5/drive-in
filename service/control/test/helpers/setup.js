import { HubCore } from "../../src/hub/hub-core.js";
import { createServices } from "../../src/services.js";
import { createTestD1 } from "./d1.js";
import { createDefaultNode, createFakeTransport, createMemoryStorage } from "./fakes.js";

export const USER = "usr_test";

// A full control plane minus Workers: real migrations, HubCore, services.
export function createTestControlPlane({ node = createDefaultNode(), connected = [] } = {}) {
  const db = createTestD1();
  db.raw.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', 0)").run(USER, USER);
  const transport = createFakeTransport(connected);
  let clock = 1_000_000;
  const hub = new HubCore({
    userId: USER,
    storage: createMemoryStorage(),
    db,
    node,
    transport,
    now: () => clock,
  });
  const services = createServices({ db, userId: USER, hub, node });
  return {
    db, node, transport, hub, services,
    advance(ms) {
      clock += ms;
    },
  };
}
