export type LineageBatchDecision =
  | "none"
  | "apply-canvas"
  | "rebuild-canvas"
  | "manual-conflict";

export function lineageBatchDecision(
  canvasChanged: boolean,
  projectChanged: boolean,
): LineageBatchDecision {
  if (canvasChanged && projectChanged) return "manual-conflict";
  if (canvasChanged) return "apply-canvas";
  if (projectChanged) return "rebuild-canvas";
  return "none";
}
