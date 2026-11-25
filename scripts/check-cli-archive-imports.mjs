// Check that each module that the extracted CLI archive can load is in the archive.
//
// Usage: node scripts/check-cli-archive-imports.mjs <package directory> <package name>...
//
// Run it from a clean directory without NODE_PATH, so that no workspace
// `node_modules` directory can supply a missing package. The check loads each
// published module of the named packages. Then it loads each package that a
// loaded module names in a lazy `require` or `import`, until no new module
// loads. A lazy load fails only when the product runs that code path, so an
// import of the entry points alone does not find a missing package.
import { readFileSync } from 'node:fs'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire, isBuiltin, registerHooks } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The package has a fallback for each of these modules, and it does not depend on them.
const OPTIONAL_MODULES = new Set(['bufferutil', 'utf-8-validate', 'encoding'])
// SignalR calls `require` through the local name `requireFunc`.
const LAZY_LOAD_PATTERN =
  /(?<![.\w$])(import|require|requireFunc)\)?\(\s*(["'])([@.\w][@.\w/-]*)\2\s*\)/g
const CHECK_SCHEME = 'archive-check:'

/** Return the literal names that the source loads with `import()` or `require()`. */
export function lazyModuleNames(source) {
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const names = { import: new Set(), require: new Set() }
  for (const [, call, , name] of code.matchAll(LAZY_LOAD_PATTERN)) {
    names[call === 'import' ? 'import' : 'require'].add(name)
  }
  return { import: [...names.import], require: [...names.require] }
}

async function checkArchive(packageDir, packageNames) {
  const root = await realpath(resolve(packageDir))
  const loaded = new Set()
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith(CHECK_SCHEME)) return nextResolve(specifier, context)
      const { name, parentURL } = JSON.parse(specifier.slice(CHECK_SCHEME.length))
      return nextResolve(name, { ...context, parentURL })
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) loaded.add(url)
      return nextLoad(url, context)
    },
  })
  const failures = []
  const attempt = async (label, work) => {
    try {
      await work()
    } catch (error) {
      failures.push(`${label}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  for (const name of packageNames) {
    const { modules, bins } = await publishedModules(join(root, 'node_modules', ...name.split('/')))
    // A bin runs when it loads, so only its lazy loads are checked here. The
    // packaging script runs the bins.
    for (const file of bins) loaded.add(pathToFileURL(file).href)
    for (const file of modules) {
      await attempt(file.slice(root.length + 1), () => import(pathToFileURL(file).href))
    }
  }
  const checked = new Set()
  for (let pending = [...loaded]; pending.length > 0; pending = unchecked(loaded, checked)) {
    for (const url of pending) {
      checked.add(url)
      const file = fileURLToPath(url)
      if (!file.startsWith(root + sep)) {
        failures.push(`${file}: the module is outside the archive`)
        continue
      }
      if (!/\.[cm]?js$/.test(file)) continue
      const require = createRequire(file)
      const names = lazyModuleNames(readFileSync(file, 'utf8'))
      const load = {
        import: (name) => import(CHECK_SCHEME + JSON.stringify({ name, parentURL: url })),
        require: (name) => require(name),
      }
      for (const kind of ['import', 'require']) {
        for (const name of names[kind]) {
          if (isBuiltin(name) || OPTIONAL_MODULES.has(name)) continue
          await attempt(`${file.slice(root.length + 1)} loads ${name}`, () => load[kind](name))
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`the archive cannot load:\n${[...new Set(failures)].join('\n')}`)
  }
  return loaded.size
}

function unchecked(loaded, checked) {
  return [...loaded].filter((url) => !checked.has(url))
}

async function publishedModules(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const bins = new Set(Object.values(manifest.bin ?? {}).map((path) => resolve(directory, path)))
  const entries = await readdir(join(directory, 'dist'), { recursive: true })
  const modules = entries
    .filter((path) => path.endsWith('.js'))
    .map((path) => join(directory, 'dist', path))
    .filter((path) => !bins.has(path))
    .sort()
  if (modules.length === 0 && bins.size === 0) throw new Error(`${directory} has no modules`)
  return { modules, bins }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [packageDir, ...packageNames] = process.argv.slice(2)
  if (packageDir === undefined || packageNames.length === 0) {
    throw new Error('usage: check-cli-archive-imports.mjs <package directory> <package name>...')
  }
  try {
    const count = await checkArchive(packageDir, packageNames)
    process.stdout.write(`${JSON.stringify({ modules: count })}\n`)
    // A loaded module can hold the event loop, so the check ends here.
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}
