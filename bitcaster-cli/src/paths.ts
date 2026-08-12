import { dataDir } from '@bitcaster-market/daemon/dataDir'

export function cliHomeDir(): string {
  return dataDir()
}
