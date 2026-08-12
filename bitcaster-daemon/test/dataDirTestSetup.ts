import { configureDataDirForTest } from '../src/dataDir.ts'

configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME)
