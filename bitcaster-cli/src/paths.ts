import { homedir } from 'node:os'
import { join } from 'node:path'

export function cliHomeDir(): string {
  return process.env.BITCASTER_CLI_HOME || join(homedir(), '.bitcaster-cli')
}
