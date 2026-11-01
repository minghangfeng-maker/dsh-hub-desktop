/**
 * Finish the upstream desktop introduction on a Hub account.
 *
 * `@deepseek-ai/dsh-client-ui-settings-account` shows its first-run introduction
 * whenever the account is signed in and the durable step is not `done`: pick a
 * purpose, pick how much work detail to show, add credits. On a Hub desktop the
 * account is issued by the Hub and the credits come from the Hub wallet, so a
 * Hub user has nothing to decide there and would only be walked through the
 * upstream product's wording. The product therefore records the introduction as
 * finished instead of asking.
 *
 * Two boundaries keep this narrow. Only the fresh `welcome` step is rewritten: a
 * user who already moved through a page in the upstream wizard keeps that
 * progress, and a finished one stays finished. And the DeepSeek-account switch
 * (the advanced setting) leaves the wizard alone, because that path hands the
 * account back to the upstream provider and the wizard belongs to it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { info, warn } from './log.ts'

/** Profile entry id whose Config carries the desktop introduction's progress. */
export const ONBOARDING_NAMESPACE = 'ui-settings-account'

/** Step the upstream controller writes after its last page. */
const FINISHED_STEP = 'done'

/** Completion reason the upstream controller stores for a user who went through every page. */
const FINISHED_REASON = 'completed'

/** The one field this module reads out of the entry's live value. */
interface ProgressValue {
  readonly step?: unknown
}

/**
 * Read the live introduction step from the settings service.
 * @param settings - Settings service of the running Host.
 * @returns The stored step, or undefined when the row is absent or not an object.
 */
function storedStep(settings: { describe: () => readonly { ns: string; value: unknown }[] }): unknown {
  const descriptor = settings.describe().find(row => row.ns === ONBOARDING_NAMESPACE)
  const value: unknown = descriptor?.value
  if (typeof value !== 'object' || value === null) return undefined
  return (value as ProgressValue).step
}

/**
 * Record the upstream introduction as finished for a Hub account.
 *
 * Runs at Host start and after a Hub sign-in. Every failure is a logged warning:
 * a settings write that does not land leaves the wizard visible, which is the
 * upstream behavior rather than a broken Host.
 * @param ctx - Host context of the connector, used only to reach the settings service.
 */
export function finishUpstreamOnboarding(ctx: Context): void {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  let step: unknown
  try {
    step = storedStep(settings)
  } catch (error) {
    warn(`could not read the upstream desktop introduction: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // No row means this composition (or a container profile) has no introduction.
  if (step === undefined) return
  if (step !== 'welcome') return
  void settings.update(ONBOARDING_NAMESPACE, { step: FINISHED_STEP, completion: FINISHED_REASON })
    .then(() => { info('the upstream desktop introduction is finished: a Hub account starts in the workspace') })
    .catch((error: unknown) => {
      warn(`could not finish the upstream desktop introduction: ${error instanceof Error ? error.message : String(error)}`)
    })
}
