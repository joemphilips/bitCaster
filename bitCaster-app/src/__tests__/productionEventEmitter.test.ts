// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { UserConfig } from "vite";

// A static import would add the Vite configuration to the app type check.
const viteConfigModule = "../../vite.config.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Content Security Policy of the production server blocks eval. NDK delivers relay
// events through the tseep event emitter. The default tseep build compiles the call of
// two or more listeners with eval.
it("delivers an NDK event to every listener in the production build without eval", async () => {
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
  const { EventEmitter } = (await import(/* @vite-ignore */ tseep!.replacement)) as {
    EventEmitter: new () => {
      on(event: string, listener: (value: string) => void): void;
      emit(event: string, value: string): boolean;
    };
  };
  vi.stubGlobal("eval", () => {
    throw new EvalError("The Content Security Policy blocks eval.");
  });
  const emitter = new EventEmitter();
  const received: string[] = [];
  emitter.on("event", (value) => received.push(`first ${value}`));
  emitter.on("event", (value) => received.push(`second ${value}`));

  expect(emitter.emit("event", "a")).toBe(true);
  expect(received).toEqual(["first a", "second a"]);
});
