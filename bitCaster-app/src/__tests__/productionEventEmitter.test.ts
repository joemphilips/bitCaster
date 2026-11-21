// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserConfig } from "vite";

// A static import would add the Vite configuration to the app type check.
const viteConfigModule = "../../vite.config.ts";

type Listener = (...args: unknown[]) => void;
interface Emitter {
  on(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  removeAllListeners(event?: string): unknown;
  emit(event: string, ...args: unknown[]): boolean;
}
type EmitterClass = new () => Emitter;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The emitter class that the production build gives to NDK in place of tseep. */
async function productionEmitter(): Promise<EmitterClass> {
  const { default: viteConfig } = (await import(/* @vite-ignore */ viteConfigModule)) as {
    default: UserConfig;
  };
  const aliases = (viteConfig.resolve?.alias ?? []) as {
    find: string | RegExp;
    replacement: string;
  }[];
  const tseep = aliases.find(({ find }) =>
    typeof find === "string" ? find === "tseep" : find.test("tseep"),
  );
  expect(tseep).toBeDefined();
  return ((await import(/* @vite-ignore */ tseep!.replacement)) as { EventEmitter: EmitterClass })
    .EventEmitter;
}

async function defaultEmitter(): Promise<EmitterClass> {
  return ((await import("tseep")) as unknown as { EventEmitter: EmitterClass }).EventEmitter;
}

// Each scenario records what the listeners receive and what emit returns.
const scenarios: [string, (emitter: Emitter, trace: string[]) => void, string[]][] = [
  [
    "a listener that removes itself during an emit does not stop a later listener",
    (emitter, trace) => {
      // NDKPool.connect: each pending connect check removes itself when the relay connects.
      const pool = () => trace.push("pool");
      const checkA = () => {
        trace.push("checkA");
        emitter.off("connect", checkA);
      };
      const checkB = () => {
        trace.push("checkB");
        emitter.off("connect", checkB);
      };
      emitter.on("connect", pool);
      emitter.on("connect", checkA);
      emitter.on("connect", checkB);
      trace.push(`emit ${emitter.emit("connect")}`);
      trace.push(`emit ${emitter.emit("connect")}`);
    },
    ["pool", "checkA", "checkB", "emit true", "pool", "emit true"],
  ],
  [
    "a once listener runs after the persistent listeners, in one emit only",
    (emitter, trace) => {
      emitter.on("event", (value) => trace.push(`first ${String(value)}`));
      emitter.once("event", (value) => trace.push(`once ${String(value)}`));
      emitter.on("event", (value) => trace.push(`second ${String(value)}`));
      trace.push(`emit ${emitter.emit("event", "a")}`);
      trace.push(`emit ${emitter.emit("event", "b")}`);
    },
    ["first a", "second a", "once a", "emit true", "first b", "second b", "emit true"],
  ],
  [
    "a listener added during an emit runs from the next emit",
    (emitter, trace) => {
      const added = (value: unknown) => trace.push(`added ${String(value)}`);
      let adding = true;
      emitter.on("event", (value) => {
        trace.push(`first ${String(value)}`);
        if (adding) emitter.on("event", added);
        adding = false;
      });
      emitter.on("event", (value) => trace.push(`second ${String(value)}`));
      emitter.emit("event", "a");
      emitter.emit("event", "b");
    },
    ["first a", "second a", "first b", "second b", "added b"],
  ],
  [
    "removing all listeners during an emit does not stop that emit",
    (emitter, trace) => {
      emitter.on("event", () => {
        trace.push("first");
        emitter.removeAllListeners("event");
      });
      emitter.on("event", () => trace.push("second"));
      trace.push(`emit ${emitter.emit("event")}`);
      trace.push(`emit ${emitter.emit("event")}`);
    },
    ["first", "second", "emit true", "emit false"],
  ],
  [
    "each of two listeners receives as many arguments as the longest listener declares",
    (emitter, trace) => {
      emitter.on("event", (...args) => trace.push(`rest ${args.length}`));
      emitter.on("event", (value) => trace.push(`one ${String(value)}`));
      emitter.emit("event", "a", "b");
    },
    ["rest 1", "one a"],
  ],
];

// The Content Security Policy of the production server blocks eval. NDK delivers relay
// events through the tseep event emitter. The default tseep build calls two or more
// listeners through a function that it makes with eval. The production build must keep
// the behavior of the default build, without eval.
describe("the NDK event emitter of the production build", () => {
  it.each(scenarios)("%s, as in the default tseep build", async (_name, scenario, expected) => {
    const defaultTrace: string[] = [];
    scenario(new (await defaultEmitter())(), defaultTrace);
    expect(defaultTrace).toEqual(expected);

    const Production = await productionEmitter();
    vi.stubGlobal("eval", () => {
      throw new EvalError("The Content Security Policy blocks eval.");
    });
    const productionTrace: string[] = [];
    scenario(new Production(), productionTrace);
    expect(productionTrace).toEqual(expected);
  });
});
