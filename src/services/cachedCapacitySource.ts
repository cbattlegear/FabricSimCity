import type {
  CapacityCityPage,
  CapacityCitySummarySnapshot,
  CapacityTimepoint,
  OperationSample,
} from '../capacityCityContracts'
import type { AtlasSnapshot } from '../fabricContracts'
import type {
  CapacitySource,
  CityPageRequest,
  OperationSampleRequest,
  TimepointRequest,
} from '../collect/source'
import type { JsonValue, SnapshotKind } from '../appState'
import type { AppStateStore } from './appState'

export interface CachedCapacitySourceOptions {
  tenantId: string
}

function scopeRequest(value: { [key: string]: JsonValue }): JsonValue {
  return value
}

function requestForCityPage(request: CityPageRequest): JsonValue {
  return scopeRequest({
    capacityId: request.capacityId,
    metric: request.metric,
    pageSize: request.pageSize,
    pageToken: request.pageToken ?? null,
  })
}

function requestForTimepoints(request: TimepointRequest): JsonValue {
  return scopeRequest({
    capacityId: request.capacityId,
    start: request.start,
    end: request.end,
  })
}

function requestForOperationSamples(request: OperationSampleRequest): JsonValue {
  return scopeRequest({
    capacityId: request.capacityId,
    timepoint: request.timepoint ?? null,
    limit: request.limit,
  })
}

export function createCachedCapacitySource(
  inner: CapacitySource,
  store: AppStateStore,
  options: CachedCapacitySourceOptions,
): CapacitySource {
  async function readThrough<TSnapshot>(
    snapshotKind: SnapshotKind,
    request: JsonValue | undefined,
    fetchSnapshot: () => Promise<TSnapshot>,
  ): Promise<TSnapshot> {
    const scope = {
      tenantId: options.tenantId,
      sourceKind: inner.kind,
      snapshotKind,
      request,
    }
    const cached = await store.readCachedSnapshot<TSnapshot>(scope)
    if (cached.status === 'hit') return cached.snapshot
    const snapshot = await fetchSnapshot()
    await store.writeCachedSnapshot(scope, snapshot)
    return snapshot
  }

  return {
    kind: inner.kind,
    capabilities: inner.capabilities,
    readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
      return readThrough('Atlas', undefined, () => inner.readAtlas(signal))
    },
    readCitySummaries(signal?: AbortSignal): Promise<CapacityCitySummarySnapshot> {
      return readThrough('CitySummaries', undefined, () => inner.readCitySummaries(signal))
    },
    readCityPage(request: CityPageRequest): Promise<CapacityCityPage> {
      return readThrough('CityPage', requestForCityPage(request), () => inner.readCityPage(request))
    },
    readTimepoints(request: TimepointRequest): Promise<CapacityTimepoint[]> {
      return readThrough('Timepoints', requestForTimepoints(request), () => inner.readTimepoints(request))
    },
    readOperationSamples(request: OperationSampleRequest): Promise<OperationSample[]> {
      return readThrough(
        'OperationSamples',
        requestForOperationSamples(request),
        () => inner.readOperationSamples(request),
      )
    },
  }
}
