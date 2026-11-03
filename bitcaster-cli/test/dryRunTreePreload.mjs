// Print every registered command and its declared --dry-run mode instead of
// parsing arguments. The CLI still runs its startup declaration check first.
import { Command } from 'commander'
import { commandPath, dryRunModeOf } from '../src/dryRunPolicy.ts'

Command.prototype.parseAsync = async function () {
  const commands = []
  const walk = (command) => {
    for (const child of command.commands) {
      commands.push({
        path: commandPath(child),
        // Test-only read of Commander 12's private action field.
        hasAction: child._actionHandler !== null,
        mode: dryRunModeOf(child) ?? null,
      })
      walk(child)
    }
  }
  walk(this)
  process.stdout.write(`${JSON.stringify(commands)}\n`)
  return this
}
