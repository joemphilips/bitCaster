// Test-only browser instrumentation. The parent connected suite loads this same
// source before navigation. Native methods always receive the original arguments.
globalThis.__installPriceChartCanvasObserver = function (owner, options = {}) {
  const geometry = options.geometry !== false;
  const proto = CanvasRenderingContext2D.prototype;
  const restores = [];
  const states = new Map();
  const paths = new WeakMap();
  const colorContext = document.createElement("canvas").getContext("2d");
  const normalize = (color) => {
    colorContext.strokeStyle = color;
    return colorContext.strokeStyle;
  };
  const colors = new Set((options.colors ?? ["#3b82f6"]).map(normalize));
  let revision = 0;
  function owns(canvas) {
    const host = typeof owner === "string" ? document.querySelector(owner) : owner;
    return host?.contains(canvas) ?? false;
  }
  function state(context) {
    if (!owns(context.canvas)) return null;
    let value = states.get(context);
    if (!value) {
      value = { path: [], rect: null, clip: null, stack: [], draws: [], revision: 0 };
      states.set(context, value);
    }
    return value;
  }
  function patch(target, name, observe) {
    const original = target[name];
    target[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      observe(this, args);
      return result;
    };
    restores.push(() => {
      target[name] = original;
    });
  }
  const point = (x, y, matrix) => {
    const p = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  };
  const transform = (command, matrix) => {
    const p = point(command.x, command.y, matrix);
    return {
      ...command,
      ...p,
      ...(command.r === undefined
        ? {}
        : {
            r: command.r * Math.hypot(matrix.a, matrix.b),
          }),
    };
  };
  const rectangle = (x, y, width, height, matrix) => {
    const a = point(x, y, matrix),
      b = point(x + width, y + height, matrix);
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  };
  const intersect = (a, b) => {
    if (!a) return b;
    const left = Math.max(a.left, b.left),
      top = Math.max(a.top, b.top);
    return {
      left,
      top,
      width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
      height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top),
    };
  };
  patch(proto, "save", (ctx) => {
    const s = state(ctx);
    if (s) s.stack.push(s.clip);
  });
  patch(proto, "restore", (ctx) => {
    const s = state(ctx);
    if (s) s.clip = s.stack.pop() ?? null;
  });
  patch(proto, "beginPath", (ctx) => {
    const s = state(ctx);
    if (s) {
      s.path = [];
      s.rect = null;
    }
  });
  patch(proto, "rect", (ctx, [x, y, w, h]) => {
    const s = state(ctx);
    if (s) s.rect = rectangle(x, y, w, h, ctx.getTransform());
  });
  patch(proto, "clip", (ctx, args) => {
    const s = state(ctx);
    if (!s) return;
    if (args[0] instanceof Path2D)
      throw new Error("Canvas oracle requires the native rectangular context clip");
    if (!s.rect) throw new Error("Canvas oracle encountered a nonrectangular chart clip");
    s.clip = intersect(s.clip, s.rect);
  });
  patch(proto, "clearRect", (ctx) => {
    const s = state(ctx);
    if (s) {
      s.draws = [];
    }
  });
  for (const dimension of ["width", "height"]) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension);
    Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, value);
        for (const [ctx, s] of states)
          if (ctx.canvas === this) {
            s.draws = [];
            s.path = [];
            s.rect = null;
            s.clip = null;
            s.stack = [];
          }
      },
    });
    restores.push(() => Object.defineProperty(HTMLCanvasElement.prototype, dimension, descriptor));
  }
  if (geometry) {
    for (const name of ["moveTo", "lineTo", "arc"]) {
      const command = (args) => ({
        type: name === "moveTo" ? "M" : name === "lineTo" ? "L" : "A",
        x: args[0],
        y: args[1],
        ...(name === "arc" ? { r: args[2] } : {}),
      });
      patch(Path2D.prototype, name, (path, args) => {
        const list = paths.get(path) ?? [];
        list.push(command(args));
        paths.set(path, list);
      });
      patch(proto, name, (ctx, args) => {
        const s = state(ctx);
        if (s) s.path.push(transform(command(args), ctx.getTransform()));
      });
    }
  }
  for (const method of ["stroke", "fill"])
    patch(proto, method, (ctx, args) => {
      const s = state(ctx);
      const color = method === "stroke" ? ctx.strokeStyle : ctx.fillStyle;
      if (!s || !s.clip || !colors.has(color) || ctx.globalAlpha === 0) return;
      s.revision = ++revision;
      let commands = [];
      if (geometry) {
        if (args[0] instanceof Path2D) {
          const path = paths.get(args[0]);
          if (!path)
            throw new Error("Unobserved cached Path2D: install observer before chart creation");
          commands = path.map((command) => transform(command, ctx.getTransform()));
        } else commands = s.path.slice();
      }
      // Keep only the current frame, bounded by actual series pieces and markers.
      s.draws.push({ method, color, commands, clip: s.clip, lineWidth: ctx.lineWidth, revision });
    });
  return {
    snapshot() {
      const draws = [];
      for (const [ctx, s] of states) {
        if (!owns(ctx.canvas)) {
          states.delete(ctx);
          continue;
        }
        const rect = ctx.canvas.getBoundingClientRect();
        const sx = rect.width / ctx.canvas.width,
          sy = rect.height / ctx.canvas.height;
        const screenRect = (r) => ({
          left: rect.left + r.left * sx,
          top: rect.top + r.top * sy,
          width: r.width * sx,
          height: r.height * sy,
        });
        for (const draw of s.draws)
          draws.push({
            ...draw,
            clip: screenRect(draw.clip),
            commands: draw.commands.map((p) => ({
              ...p,
              x: rect.left + p.x * sx,
              y: rect.top + p.y * sy,
              ...(p.r === undefined ? {} : { r: p.r * sx }),
            })),
          });
      }
      return { revision, draws, plot: draws[draws.length - 1]?.clip ?? null };
    },
    restore() {
      for (const restore of restores.reverse()) restore();
      states.clear();
    },
  };
};
