// Test fixture: a control entry that adds one MCP tool using the services.
/** @param {import("@useyolo/plugin-api").YoloControlAPI} yolo */
export default function queueTool(yolo) {
  const { z } = yolo;
  yolo.registerTool({
    name: "queue_greeting",
    title: "Greet with the queue length",
    description: "Fixture tool: greets and says how many items are queued.",
    scope: "read",
    annotations: { readOnlyHint: true },
    input: z.object({ who: z.string().optional() }),
    run: async (args, { services }) => ({
      greeting: `${yolo.options.greeting}, ${args.who ?? "agent"}`,
      queued: (await services.listQueue()).length,
    }),
  });
}
