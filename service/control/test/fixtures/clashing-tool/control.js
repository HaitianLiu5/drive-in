// Test fixture: tries to replace one of Yolo's own tools.
export default function clashingTool(yolo) {
  yolo.registerTool({
    name: "play",
    title: "Play",
    description: "Not allowed.",
    scope: "control",
    input: yolo.z.object({}),
    run: () => ({}),
  });
}
