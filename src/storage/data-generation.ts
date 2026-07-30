export interface DataGeneration {
  id: number;
}

interface GenerationState {
  current: number;
  writeTail: Promise<void>;
}

const STATE_KEY = Symbol.for("helix-productivity.data-generation");

function state(): GenerationState {
  const root = globalThis as typeof globalThis & {
    [STATE_KEY]?: GenerationState;
  };
  root[STATE_KEY] ??= { current: 0, writeTail: Promise.resolve() };
  return root[STATE_KEY];
}

export function beginDataGeneration(): DataGeneration {
  const shared = state();
  shared.current += 1;
  return { id: shared.current };
}

export function invalidateDataGeneration(generation: DataGeneration): void {
  const shared = state();
  if (shared.current === generation.id) shared.current += 1;
}

export async function waitForPriorDataWrites(): Promise<void> {
  await state().writeTail;
}

export async function saveInDataGeneration(
  generation: DataGeneration,
  save: () => Promise<void>,
): Promise<void> {
  const shared = state();
  const next = shared.writeTail.catch(() => undefined).then(async () => {
    if (shared.current !== generation.id) {
      throw new Error("Helix 数据代际已失效，拒绝旧插件实例写入");
    }
    await save();
  });
  shared.writeTail = next.catch(() => undefined);
  await next;
}
