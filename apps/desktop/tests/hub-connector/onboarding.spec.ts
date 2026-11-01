import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { finishUpstreamOnboarding, ONBOARDING_NAMESPACE } from '../../hub/plugins/hub-connector/src/onboarding.ts'

/**
 * Build a context whose settings service answers one progress value.
 * @param options - Descriptor value (`absent` for no row), update outcome, and describe failure.
 * @returns The fake context plus the update spy.
 */
function fakeContext(options: {
  value?: unknown
  absent?: boolean
  update?: () => Promise<void>
  describeThrows?: boolean
}): { ctx: Context; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(options.update ?? (async () => {}))
  const row = { ns: ONBOARDING_NAMESPACE, value: 'value' in options ? options.value : { step: 'welcome' } }
  const settings = {
    describe: () => {
      if (options.describeThrows === true) throw new Error('describe failed')
      return options.absent === true ? [] : [row]
    },
    update,
  }
  const ctx = { get: (name: string) => (name === 'settings' ? settings : undefined) } as unknown as Context
  return { ctx, update }
}

describe('upstream desktop introduction', () => {
  it('finishes a fresh introduction when a Hub account provides the account service', async () => {
    const { ctx, update } = fakeContext({ value: { step: 'welcome', completion: null } })
    finishUpstreamOnboarding(ctx)
    await Promise.resolve()
    expect(update).toHaveBeenCalledWith(ONBOARDING_NAMESPACE, { step: 'done', completion: 'completed' })
  })

  it('leaves progress a user already made in the upstream wizard', () => {
    const { ctx, update } = fakeContext({ value: { step: 'process', purpose: 'office', completion: null } })
    finishUpstreamOnboarding(ctx)
    expect(update).not.toHaveBeenCalled()
  })

  it('leaves a finished introduction untouched', () => {
    const { ctx, update } = fakeContext({ value: { step: 'done', completion: 'skipped' } })
    finishUpstreamOnboarding(ctx)
    expect(update).not.toHaveBeenCalled()
  })

  it('does nothing when the composition has no introduction row', () => {
    const { ctx, update } = fakeContext({ absent: true })
    finishUpstreamOnboarding(ctx)
    expect(update).not.toHaveBeenCalled()
  })

  it('does nothing when the row carries no object value', () => {
    for (const value of [undefined, 'welcome', 7, null, ['welcome']]) {
      const { ctx, update } = fakeContext({ value })
      finishUpstreamOnboarding(ctx)
      expect(update).not.toHaveBeenCalled()
    }
  })

  it('does nothing when the Host provides no settings service', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(() => { finishUpstreamOnboarding(ctx) }).not.toThrow()
  })

  it('logs a failed read instead of failing the Host start', () => {
    const { ctx, update } = fakeContext({ describeThrows: true })
    expect(() => { finishUpstreamOnboarding(ctx) }).not.toThrow()
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps a rejected settings write as a logged warning', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, update } = fakeContext({ update: async () => { throw new Error('read-only profile') } })
    finishUpstreamOnboarding(ctx)
    await Promise.resolve()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.flat().join(' ')).toContain('read-only profile')
    log.mockRestore()
  })
})
