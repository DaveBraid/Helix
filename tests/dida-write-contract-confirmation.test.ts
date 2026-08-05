import { describe, expect, it } from "vitest";
import {
  DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS,
  DidaWriteContractConfirmationGate,
} from "../src/ui/dida-write-contract-confirmation";

describe("Dida write-contract confirmation gate", () => {
  it("requires a second request inside the shared confirmation window", () => {
    let now = 0;
    const gate = new DidaWriteContractConfirmationGate(() => now);
    expect(gate.request()).toBe("armed");
    now = DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS - 1;
    expect(gate.request()).toBe("confirmed");
    expect(gate.isArmed()).toBe(false);
  });

  it("expires an armed request and invokes the shared expiry callback", () => {
    let now = 0;
    let timer: (() => void) | undefined;
    let expired = 0;
    const gate = new DidaWriteContractConfirmationGate(
      () => now,
      ((callback: () => void) => {
        timer = callback;
        return 1;
      }) as unknown as typeof globalThis.setTimeout,
      (() => undefined) as unknown as typeof globalThis.clearTimeout,
    );

    expect(gate.request(() => { expired += 1; })).toBe("armed");
    now = DIDA_WRITE_CONTRACT_CONFIRM_WINDOW_MS;
    timer?.();
    expect(expired).toBe(1);
    expect(gate.isArmed()).toBe(false);
    expect(gate.request()).toBe("armed");
  });

  it("disarms a retained old timer so it cannot invoke its expiry callback", () => {
    let timer: (() => void) | undefined;
    let expired = 0;
    const gate = new DidaWriteContractConfirmationGate(
      () => 0,
      ((callback: () => void) => {
        timer = callback;
        return 1;
      }) as unknown as typeof globalThis.setTimeout,
      (() => undefined) as unknown as typeof globalThis.clearTimeout,
    );

    gate.request(() => { expired += 1; });
    gate.disarm();
    timer?.();
    expect(expired).toBe(0);
    expect(gate.isArmed()).toBe(false);
  });

  it("requires confirmation from the same entry instead of allowing cross-entry execution", () => {
    const settings = new DidaWriteContractConfirmationGate();
    const command = new DidaWriteContractConfirmationGate();
    expect(settings.request()).toBe("armed");
    expect(command.request()).toBe("armed");
    expect(settings.request()).toBe("confirmed");
  });

  it("calls Electron-style default timers with globalThis as their receiver", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let scheduled: (() => void) | undefined;
    let cleared = false;
    const setWithReceiver = function(
      this: typeof globalThis,
      callback: TimerHandler,
    ): ReturnType<typeof globalThis.setTimeout> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      scheduled = callback as () => void;
      return 42 as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const clearWithReceiver = function(
      this: typeof globalThis,
      timer: ReturnType<typeof globalThis.setTimeout>,
    ): void {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(timer).toBe(42);
      cleared = true;
    };
    globalThis.setTimeout = setWithReceiver as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = clearWithReceiver as typeof globalThis.clearTimeout;
    try {
      const gate = new DidaWriteContractConfirmationGate(() => 0);
      expect(gate.request()).toBe("armed");
      expect(scheduled).toBeTypeOf("function");
      gate.disarm();
      expect(cleared).toBe(true);
      expect(gate.isArmed()).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
