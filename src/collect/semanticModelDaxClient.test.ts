import { describe, expect, it, vi } from 'vitest'
import {
  bindDaxParameters,
  createSemanticModelDaxClient,
  daxLiteral,
  normalizeRowKey,
} from './semanticModelDaxClient'
import { CapacitySourceError } from './source'
import type { SemanticModelDaxRequest } from './semanticModelSource'

function request(overrides: Partial<SemanticModelDaxRequest> = {}): SemanticModelDaxRequest {
  return {
    queryName: 'capacitySummary',
    query: 'EVALUATE ROW("x", 1)',
    parameters: {},
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rowsResponse(rows: readonly Record<string, unknown>[]): Response {
  return jsonResponse({ results: [{ tables: [{ rows }] }] })
}

function client(fetchImpl: typeof globalThis.fetch) {
  return createSemanticModelDaxClient({ datasetId: 'abc-123', fetch: fetchImpl })
}

describe('daxLiteral', () => {
  it('escapes a quote by doubling it, which is how DAX ends a string', () => {
    expect(daxLiteral('a"b')).toBe('"a""b"')
  })

  it('builds a timestamp arithmetically rather than quoting it', () => {
    expect(daxLiteral('2026-09-08T13:45:30Z')).toBe('(DATE(2026,9,8) + TIME(13,45,30))')
  })

  it('normalizes an offset timestamp to UTC', () => {
    expect(daxLiteral('2026-09-08T13:45:30+02:00')).toBe('(DATE(2026,9,8) + TIME(11,45,30))')
  })

  it('leaves a non-timestamp string as a quoted literal', () => {
    expect(daxLiteral('2026-09-08')).toBe('"2026-09-08"')
  })

  it('renders the remaining scalar kinds', () => {
    expect(daxLiteral(null)).toBe('BLANK()')
    expect(daxLiteral(true)).toBe('TRUE()')
    expect(daxLiteral(false)).toBe('FALSE()')
    expect(daxLiteral(42)).toBe('42')
  })

  it('refuses a non-finite number rather than emitting Infinity into a query', () => {
    expect(() => daxLiteral(Number.POSITIVE_INFINITY)).toThrow(CapacitySourceError)
  })
})

describe('bindDaxParameters', () => {
  it('substitutes a placeholder', () => {
    expect(bindDaxParameters('WHERE x = @CapacityId', { CapacityId: 'cap-1' })).toBe(
      'WHERE x = "cap-1"',
    )
  })

  /*
   * The reason binding matches whole identifiers. A naive replace of `@Start` rewrites the front of
   * `@StartOfDay` and leaves behind valid DAX, so the failure would be wrong numbers rather than an
   * error — the expensive kind.
   */
  it('does not rewrite the front of a longer parameter name', () => {
    const bound = bindDaxParameters('@Start / @StartOfDay', {
      Start: 1,
      StartOfDay: 2,
    })
    expect(bound).toBe('1 / 2')
  })

  it('binds every occurrence of the same placeholder', () => {
    expect(bindDaxParameters('@A + @A', { A: 3 })).toBe('3 + 3')
  })

  /*
   * A capacity id arrives from the service, so it is not trusted input. Closing the literal and
   * appending a filter must not survive binding.
   */
  it('contains an attempt to break out of a string literal', () => {
    const hostile = 'x" || TRUE() || "'
    const bound = bindDaxParameters('FILTER(t, [Id] = @CapacityId)', { CapacityId: hostile })
    expect(bound).toBe('FILTER(t, [Id] = "x"" || TRUE() || """)')

    // The literal still decodes back to exactly the input, so nothing escaped into expression text.
    const literal = bound.slice(bound.indexOf('"'), bound.lastIndexOf('"') + 1)
    expect(literal.slice(1, -1).replaceAll('""', '"')).toBe(hostile)
  })

  it('fails loudly when a placeholder was never supplied', () => {
    expect(() => bindDaxParameters('WHERE x = @Missing', {})).toThrow(/@Missing/)
  })
})

describe('normalizeRowKey', () => {
  it('unwraps a SELECTCOLUMNS alias', () => {
    expect(normalizeRowKey('[CapacityId]')).toBe('CapacityId')
  })

  it('unwraps a table-qualified column', () => {
    expect(normalizeRowKey('Metrics[Capacity Id]')).toBe('Capacity Id')
  })

  it('leaves an already-plain key alone', () => {
    expect(normalizeRowKey('CapacityId')).toBe('CapacityId')
  })
})

describe('createSemanticModelDaxClient', () => {
  it('refuses to build without a dataset id', () => {
    expect(() => createSemanticModelDaxClient({ datasetId: '  ' })).toThrow(CapacitySourceError)
  })

  it('posts the bound query to the dataset executeQueries endpoint', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => rowsResponse([]))
    await client(fetchImpl).execute(
      request({ query: 'FILTER(t, [Id] = @CapacityId)', parameters: { CapacityId: 'cap-1' } }),
    )

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/powerbi/v1.0/myorg/datasets/abc-123/executeQueries')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      queries: [{ query: 'FILTER(t, [Id] = "cap-1")' }],
      serializerSettings: { includeNulls: true },
    })
  })

  /*
   * Without unwrapping, the source sees a well-formed response with zero usable fields — a silent
   * empty city rather than an error.
   */
  it('unwraps bracketed column names so the source can read them', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => rowsResponse([{ '[CapacityId]': 'cap-1', '[Sku]': 'F64' }]))
    const rows = await client(fetchImpl).execute(request())
    expect(rows).toEqual([{ CapacityId: 'cap-1', Sku: 'F64' }])
  })

  it('returns empty when the response carries no table', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [{}] }))
    const rows = await client(fetchImpl).execute(request())
    expect(rows).toEqual([])
  })

  it('attaches a bearer token when one is supplied', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => rowsResponse([]))
    const withToken = createSemanticModelDaxClient({
      datasetId: 'abc-123',
      fetch: fetchImpl,
      getAccessToken: () => 'tok-1',
    })
    await withToken.execute(request())
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
  })

  it('sends no authorization header when the proxy holds the token', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => rowsResponse([]))
    await client(fetchImpl).execute(request())
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it.each([
    [401, 'Unauthenticated'],
    [403, 'PermissionDenied'],
    [404, 'NotConfigured'],
    [500, 'Unknown'],
  ])('maps HTTP %i onto %s', async (status, failure) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: { message: 'no' } }, status))
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toMatchObject({ failure, sourceKind: 'SemanticModel' })
  })

  /*
   * The load-bearing mapping. A 400 from executeQueries is a DAX error, and the DAX error this
   * source expects to meet is the Capacity Metrics schema having moved again — which the app
   * treats as a reason to fall back and say so, not as a crash.
   */
  it('maps a DAX error onto Unsupported so a moved schema degrades', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: { message: "Column 'CU s' cannot be found" } }, 400),
    )
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toMatchObject({ failure: 'Unsupported' })
  })

  it('treats a per-result error as Unsupported even under a 200', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ results: [{ error: { message: 'bad measure' } }] }),
    )
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toMatchObject({ failure: 'Unsupported' })
  })

  it('surfaces the service message rather than a generic one', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: { message: "Table 'MetricsByItem' not found" } }, 400),
    )
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toThrow(/MetricsByItem/)
  })

  it('maps a transport failure onto Network', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toMatchObject({ failure: 'Network' })
  })

  it('lets an abort propagate rather than reporting it as a network fault', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('still fails usefully when the error body is not JSON', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response('gateway down', { status: 502 }))
    await expect(
      client(fetchImpl).execute(request()),
    ).rejects.toThrow(/502/)
  })
})
