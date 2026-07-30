import { describe, expect, it } from "vitest";
import { SingleFlight } from "../src/services/single-flight";

describe("SingleFlight queue drain", () => {
  it("shares one consumer across interleaved drain requests and permits a later run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const lock = new SingleFlight();
    const operation = async () => {
      calls += 1;
      await gate;
    };
    const first = lock.run(operation);
    const second = lock.run(operation);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    await lock.run(async () => {
      calls += 1;
    });
    expect(calls).toBe(3);
  });
});
