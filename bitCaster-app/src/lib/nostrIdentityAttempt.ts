/** One tab owns one selected identity. A later user action supersedes earlier work. */
let generation = 0;
let lifetime = new AbortController();

export class SupersededNostrIdentityError extends Error {
  constructor() {
    super("The identity selection changed.");
  }
}

export interface NostrIdentityAttempt {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  requireCurrent(): void;
}

export function captureNostrIdentityAttempt(): NostrIdentityAttempt {
  const selected = generation;
  return {
    signal: lifetime.signal,
    isCurrent: () => selected === generation,
    requireCurrent() {
      if (selected !== generation) throw new SupersededNostrIdentityError();
    },
  };
}

export function beginNostrIdentityAttempt(): NostrIdentityAttempt {
  const previous = lifetime;
  generation += 1;
  lifetime = new AbortController();
  previous.abort();
  return captureNostrIdentityAttempt();
}
