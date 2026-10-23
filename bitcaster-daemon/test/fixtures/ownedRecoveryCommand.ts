import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Only for recovery fixtures. Commands must not leave their inherited process group.
export async function ownedRecoveryCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maximumBytes = 1024 * 1024,
): Promise<string> {
  if (process.platform !== 'linux') throw new Error('recovery fixture requires Linux')
  const child = spawn(
    'python3',
    [
      fileURLToPath(new URL('./ownedRecoveryCommand.py', import.meta.url)),
      String(timeoutMs),
      String(maximumBytes),
      executable,
      ...args,
    ],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  let output = ''
  let size = 0
  let overflow = false
  child.stdout.on('data', (data: Buffer) => {
    size += data.length
    if (size > maximumBytes * 2 + 1024) {
      overflow = true
      child.stdin.end() // Request cleanup; do not kill the supervisor.
    } else output += data.toString()
  })
  child.stderr.on('data', () => {})
  child.stdin.on('error', () => {})
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', () => reject(new Error('recovery supervisor could not start')))
    child.once('close', done)
  })
  child.stdin.destroy()
  if (code !== 0 || overflow) throw new Error('owned recovery command failed')
  return Buffer.from(JSON.parse(output).stdout, 'base64').toString('utf8')
}
