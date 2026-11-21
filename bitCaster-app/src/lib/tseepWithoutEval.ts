// NDK imports its event emitter from "tseep". The app build replaces that import with this
// module (vite.config.ts). The default tseep build calls two or more listeners of an event
// through a function that it makes with eval, and the server's Content Security Policy
// blocks eval. This module keeps the default build and replaces only that function, so that
// listener order, once listeners, and changes to the listeners during an emit stay the same.
import { EventEmitter as TseepEventEmitter } from "tseep/lib/ee.js";
import type { DefaultEventMap } from "tseep/lib/types.js";

type Listener = (...args: unknown[]) => unknown;

/** The listeners of one event in the default build (a tseep TaskCollection). */
interface TaskCollection {
  length: number;
  _tasks: Listener | Listener[] | null;
  argsNum: number;
  call: Listener;
  rebuild: () => void;
}

// From this listener count, tseep calls the live listener array, not a copy.
const LIVE_LOOP_THRESHOLD = 1500;

/**
 * tseep `rebuild_noawait` with `bakeCollection`, without eval. The first emit after a change
 * calls this. Each listener receives `argsNum` arguments: the largest declared parameter
 * count of the listeners of the event.
 */
function rebuildWithoutEval(this: TaskCollection): void {
  if (this.length === 0) {
    this.call = () => {};
    return;
  }
  if (this.length === 1) {
    this.call = this._tasks as Listener;
    return;
  }
  const tasks = this._tasks as Listener[];
  const argsNum = this.argsNum;
  const fixed = (args: unknown[]) => Array.from({ length: argsNum }, (_, index) => args[index]);
  if (tasks.length < LIVE_LOOP_THRESHOLD) {
    // A copy: a change during the emit does not affect this emit.
    const listeners = tasks.slice();
    this.call = (...args: unknown[]) => {
      const callArgs = fixed(args);
      for (const listener of listeners) listener(...callArgs);
    };
    return;
  }
  this.call = (...args: unknown[]) => {
    const callArgs = fixed(args);
    for (let index = 0; index < tasks.length; ++index) tasks[index](...callArgs);
  };
}

const rebuiltWithoutEval = new WeakSet<TaskCollection>();

/** The default build makes a TaskCollection only in addListener (also on) and prependListener. */
function addingWithoutEval(add: (...args: unknown[]) => unknown) {
  return function (
    this: { events: Record<string | symbol, TaskCollection | undefined> },
    event: string | symbol,
    ...rest: unknown[]
  ) {
    const result = add.call(this, event, ...rest);
    const tasks = this.events[event];
    if (tasks && !rebuiltWithoutEval.has(tasks)) {
      tasks.rebuild = rebuildWithoutEval.bind(tasks);
      rebuiltWithoutEval.add(tasks);
    }
    return result;
  };
}

export class EventEmitter<
  EventMap extends DefaultEventMap = DefaultEventMap,
> extends TseepEventEmitter<EventMap> {}

const base = TseepEventEmitter.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;
const prototype = EventEmitter.prototype as unknown as Record<string, unknown>;
prototype.addListener = prototype.on = addingWithoutEval(base.addListener);
prototype.prependListener = addingWithoutEval(base.prependListener);
