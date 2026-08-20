import { describe, expect, it, vi } from 'vitest'
import { tryCreateAtlasScene, type AtlasSceneFactory } from './atlasSceneFactory'

const canvas = {} as HTMLCanvasElement
const callbacks = { onHover: vi.fn(), onSelect: vi.fn(), onOpen: vi.fn() }

describe('3D scene initialization fallback', () => {
  it('returns null instead of throwing when WebGL initialization fails', () => {
    const factory: AtlasSceneFactory = () => { throw new Error('WebGL unavailable') }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(tryCreateAtlasScene(factory, canvas, callbacks)).toBeNull()
    expect(warning).toHaveBeenCalledWith('The 3D atlas could not initialize.', expect.any(Error))
    warning.mockRestore()
  })

  it('returns the controller when WebGL initialization succeeds', () => {
    const controller = { setSnapshot: vi.fn(), setSelected: vi.fn(), dispose: vi.fn() }
    const factory: AtlasSceneFactory = () => controller

    expect(tryCreateAtlasScene(factory, canvas, callbacks)).toBe(controller)
  })
})
