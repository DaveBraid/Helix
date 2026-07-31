import { describe, expect, it } from "vitest";
import { RemoteWriteGate } from "../src/services/remote-write-gate";

describe("RemoteWriteGate", () => {
  it("rejects contract testing while a normal remote write is in flight", () => {
    const gate = new RemoteWriteGate();
    const releaseWrite = gate.enterShared();
    expect(() => gate.enterExclusive()).toThrow(/远端访问正在进行/);
    releaseWrite();
    const releaseTest = gate.enterExclusive();
    releaseTest();
  });

  it("rejects new writes for the full exclusive contract-test window", () => {
    const gate = new RemoteWriteGate();
    const releaseTest = gate.enterExclusive();
    expect(gate.isExclusive()).toBe(true);
    expect(() => gate.enterShared()).toThrow(/其他远端访问已冻结/);
    releaseTest();
    expect(gate.isExclusive()).toBe(false);
    const releaseWrite = gate.enterShared();
    releaseWrite();
  });

  it("makes releases idempotent", () => {
    const gate = new RemoteWriteGate();
    const release = gate.enterShared();
    release();
    release();
    const releaseTest = gate.enterExclusive();
    releaseTest();
  });
});
