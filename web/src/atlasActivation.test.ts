import { describe, expect, it } from 'vitest'
import { CityActivation } from './atlasActivation'

describe('atlas double-click activation', () => {
  it('opens the city both clicks landed on', () => {
    const gesture = new CityActivation()
    gesture.click('db-orders')
    gesture.click('db-orders')

    expect(gesture.activate()).toBe('db-orders')
  })

  it('opens nothing when the two clicks landed on different cities', () => {
    const gesture = new CityActivation()
    gesture.click('db-orders')
    gesture.click('db-audit')

    expect(gesture.activate()).toBeNull()
  })

  it('opens nothing when either click landed on the ground between cities', () => {
    const first = new CityActivation()
    first.click(null)
    first.click('db-orders')
    expect(first.activate()).toBeNull()

    const second = new CityActivation()
    second.click('db-orders')
    second.click(null)
    expect(second.activate()).toBeNull()
  })

  it('opens nothing when no click has been recorded', () => {
    expect(new CityActivation().activate()).toBeNull()
  })

  it('consumes the pair, so one further click cannot re-enter the same city', () => {
    const gesture = new CityActivation()
    gesture.click('db-orders')
    gesture.click('db-orders')
    expect(gesture.activate()).toBe('db-orders')

    gesture.click('db-orders')

    expect(gesture.activate()).toBeNull()
  })

  it('accepts a fresh pair after a previous one was consumed', () => {
    const gesture = new CityActivation()
    gesture.click('db-orders')
    gesture.click('db-orders')
    gesture.activate()

    gesture.click('db-audit')
    gesture.click('db-audit')

    expect(gesture.activate()).toBe('db-audit')
  })
})
