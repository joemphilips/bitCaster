import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  connections,
  connectedState,
  disconnectedState,
  mockGenerateNip98Header,
} = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  connectedState: 'Connected',
  disconnectedState: 'Disconnected',
  mockGenerateNip98Header: vi.fn(),
}))

type FakeConnection = {
  state: string
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  onclose: ReturnType<typeof vi.fn>
  onreconnecting: ReturnType<typeof vi.fn>
}

vi.mock('@microsoft/signalr', () => ({
  HubConnectionState: {
    Connected: connectedState,
    Disconnected: disconnectedState,
  },
  HttpTransportType: { WebSockets: 1 },
  HubConnectionBuilder: class {
    withUrl() {
      return this
    }
    withAutomaticReconnect() {
      return this
    }
    build() {
      const connection = connections.shift()
      if (!connection) throw new Error('missing fake SignalR connection')
      return connection
    }
  },
}))

vi.mock('@/lib/markets', () => ({
  generateNip98Header: mockGenerateNip98Header,
}))

import { generateTradeHubAccessToken, useTradeHub } from '../useTradeHub'

function makeConnection(failInitialStarts = 0): FakeConnection {
  const connection: FakeConnection = {
    state: disconnectedState,
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    onclose: vi.fn(),
    onreconnecting: vi.fn(),
  }

  let attempts = 0
  connection.start.mockImplementation(async () => {
    attempts += 1
    if (attempts <= failInitialStarts) {
      throw new Error('negotiate failed')
    }
    connection.state = connectedState
  })

  return connection
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGenerateNip98Header.mockResolvedValue('Nostr signed-token')
  connections.length = 0
})

describe('generateTradeHubAccessToken', () => {
  it('returns the raw NIP-98 token for SignalR Bearer transport', async () => {
    const token = await generateTradeHubAccessToken('https://example.com/hubs/trade')

    expect(token).not.toMatch(/^Nostr\s+/)
    expect(token).toBe('signed-token')
    expect(mockGenerateNip98Header).toHaveBeenCalledWith(
      'https://example.com/hubs/trade',
      'GET',
    )
  })
})

describe('useTradeHub', () => {
  it('retries an initial negotiation failure while mounted', async () => {
    const connection = makeConnection(1)
    connections.push(connection)
    const onError = vi.fn()

    renderHook(() => useTradeHub(true, { onError }))

    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(connection.state).toBe(connectedState)
  })
})
