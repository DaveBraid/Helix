import { describe, expect, it, vi } from "vitest";
import { readResponseData } from "../src/integrations/dida/http";

describe("Dida HTTP response parsing", () => {
  it("does not read JSON for a successful empty response", () => {
    const readJson = vi.fn(() => {
      throw new Error("Unexpected end of JSON input");
    });

    expect(readResponseData<void>("", readJson)).toBeUndefined();
    expect(readJson).not.toHaveBeenCalled();
  });

  it("reads JSON exactly once when a response body exists", () => {
    const readJson = vi.fn(() => ({ id: "project-1" }));

    expect(readResponseData("{}", readJson)).toEqual({ id: "project-1" });
    expect(readJson).toHaveBeenCalledOnce();
  });
});
