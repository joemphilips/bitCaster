// Playwright adds --no-sandbox unless chromiumSandbox is true. GitHub-hosted
// Ubuntu runners restrict unprivileged user namespaces through AppArmor, so the
// sandbox cannot start there. Those runner VMs are disposable, so a set CI
// variable is the only opt-out.
const noSandboxSwitch = '--no-sandbox'

export function isChromiumSandboxEnabled(env = process.env) {
  return !env.CI
}

export function chromiumLaunchOptions(options = {}, env = process.env) {
  if (options.args?.includes(noSandboxSwitch))
    throw new Error(`Do not pass ${noSandboxSwitch}. Use the CI opt-out.`)
  return { ...options, chromiumSandbox: isChromiumSandboxEnabled(env) }
}
