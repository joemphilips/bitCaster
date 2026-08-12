export interface DebounceOptions {
  leading?: boolean;
  trailing?: boolean;
}

export interface DebouncedFunction<TArgs extends unknown[]> {
  (...args: TArgs): void;
  cancel: () => void;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
  options: DebounceOptions = {},
): DebouncedFunction<TArgs> {
  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestArgs: TArgs | null = null;
  let hasPendingTrailing = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const debounced = ((...args: TArgs) => {
    latestArgs = args;
    if (leading && timer === null) {
      fn(...args);
      hasPendingTrailing = false;
    } else {
      hasPendingTrailing = true;
    }

    clear();
    timer = setTimeout(() => {
      timer = null;
      if (trailing && latestArgs && (!leading || hasPendingTrailing)) {
        fn(...latestArgs);
      }
      latestArgs = null;
      hasPendingTrailing = false;
    }, waitMs);
  }) as DebouncedFunction<TArgs>;

  debounced.cancel = () => {
    clear();
    latestArgs = null;
    hasPendingTrailing = false;
  };

  return debounced;
}
