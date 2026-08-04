import { describe, expect, it } from "vitest";
import {
  runTemplateStartup,
  templateStartupAction,
} from "../src/services/template-setup";

describe("template startup safety", () => {
  it.each([
    [true, true, "none", 0, []],
    [false, false, "prompt", 0, []],
    [false, true, "ensure-existing", 1, ["Template/Helix/Project.md"]],
  ] as const)("uses %s/%s startup plan %s", async (recoveryMode, setupCompleted, expectedAction, expectedEnsures, expectedResult) => {
    let writes = 0;
    const manager = {
      async ensureDefaults() {
        writes += 1;
        return ["Template/Helix/Project.md"];
      },
    };
    const action = templateStartupAction(recoveryMode, setupCompleted);
    expect(action).toBe(expectedAction);
    await expect(runTemplateStartup(action, manager as never)).resolves.toEqual(expectedResult);
    expect(writes).toBe(expectedEnsures);
  });
});
