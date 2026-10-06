import type { ActivityItem } from '@bitcaster-market/client-sdk/activityLog'
import { NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'

export async function readActivityRows(directory: string): Promise<
  readonly {
    sequence: number
    sourceId: string
    item: ActivityItem
  }[]
> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return database
      .prepare(
        'SELECT sequence, source_id AS sourceId, item_json AS itemJson FROM daemon_activity_feed ORDER BY sequence',
      )
      .all()
      .map((row) => ({
        sequence: Number(row.sequence),
        sourceId: String(row.sourceId),
        item: JSON.parse(String(row.itemJson)) as ActivityItem,
      }))
  } finally {
    database.close()
  }
}

export async function readActivityForWallet(directory: string, walletId: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    return new NativeActivitySqlite(database).page({ walletId }).items
  } finally {
    database.close()
  }
}
