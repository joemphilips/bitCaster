const daemonUrl = process.env.BITCASTER_TEST_DAEMON_URL

if (daemonUrl !== undefined) {
  const testGlobal = globalThis as Record<symbol, unknown>
  testGlobal[Symbol.for('bitcaster.test.daemon-url')] = daemonUrl
}
