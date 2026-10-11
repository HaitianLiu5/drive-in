// Test fixture: registers a tool, then fails, so nothing it registered is kept.
export default function brokenTool(yolo) {
  yolo.registerTool({
    name: "half_done",
    title: "Half done",
    description: "Never served.",
    scope: "read",
    input: yolo.z.object({}),
    run: () => ({}),
  });
  throw new Error("missing API key");
}
