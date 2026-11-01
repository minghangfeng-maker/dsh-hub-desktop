/**
 * Local owner of the phone channel: the switch the user flips, the account the
 * switch applies to, and the connection lifetime behind both.
 *
 * Two rules shape this class:
 * - the switch is off until the user turns it on, and a switch that was on for a
 *   different account never resumes for a new one;
 * - signing out closes the channel and clears the binding, so the next account
 *   starts from "off" instead of inheriting the previous user's consent.
 *
 * The controller reads the account's grant through {@link ChannelControllerOptions.readCredentials}
 * instead of holding it, so a grant that appears, expires, or changes account is
 * picked up by the next status read without an event subscription in between.
 */

import { bindingMatches, createBinding } from './binding.ts'
import { readChannelRecord, writeChannelRecord, type ChannelRecord } from './store.ts'
import type { ChannelLifecycle } from './lifecycle.ts'
import type { ChannelCredentials, ChannelStatus } from './types.ts'

/** Collaborators the controller reaches outside itself. */
export interface ChannelControllerOptions {
  /** Desktop profile directory holding the record. */
  readonly profile: string
  /** Connection lifetime the switch drives. */
  readonly lifecycle: ChannelLifecycle
  /** Current grant facts, or undefined while the device is signed out. */
  readonly readCredentials: () => ChannelCredentials | undefined
  /** Clock, replaced in tests. */
  readonly now: () => Date
  /** Diagnostic sink; a failed record write must not stop the channel. */
  readonly log?: (message: string) => void
}

/** Whether a record already says exactly this. */
function isSameRecord(left: ChannelRecord, right: ChannelRecord): boolean {
  if (left.enabled !== right.enabled) return false
  if (left.enabledAt !== right.enabledAt) return false
  if (left.binding === null || right.binding === null) return left.binding === right.binding
  return left.binding.nodeId === right.binding.nodeId
    && left.binding.username === right.binding.username
    && left.binding.hubOrigin === right.binding.hubOrigin
    && left.binding.boundAt === right.binding.boundAt
}

/** What the account page reads and writes. */
export class ChannelController {
  private readonly profile: string
  private readonly lifecycle: ChannelLifecycle
  private readonly readCredentials: () => ChannelCredentials | undefined
  private readonly now: () => Date
  private readonly log: (message: string) => void
  private record: ChannelRecord
  private disposed = false

  /**
   * @param options - profile, connection lifetime, grant reader, clock, and diagnostics.
   */
  constructor(options: ChannelControllerOptions) {
    this.profile = options.profile
    this.lifecycle = options.lifecycle
    this.readCredentials = options.readCredentials
    this.now = options.now
    this.log = options.log ?? (() => undefined)
    this.record = readChannelRecord(options.profile)
    // A stored switch only resumes once credentials prove it belongs to this account.
    this.lifecycle.setEnabled(false)
    this.refresh()
  }

  /** @returns whether the local switch is on. */
  get enabled(): boolean {
    return this.record.enabled
  }

  /** @returns the status the account page renders, after reconciling the current grant. */
  status(): ChannelStatus {
    this.refresh()
    return this.lifecycle.status()
  }

  /**
   * @param listener - receives every status change.
   * @returns disposer removing the listener.
   */
  onChange(listener: (status: ChannelStatus) => void): () => void {
    return this.lifecycle.onChange(listener)
  }

  /**
   * @param listener - receives every frame; the BFF adapter attaches here.
   * @returns disposer removing the listener.
   */
  attachFrames(listener: (text: string) => void): () => void {
    return this.lifecycle.attachFrames(listener)
  }

  /**
   * Send one frame on the current connection.
   * @param text - complete envelope text.
   * @returns whether a connected socket accepted it.
   */
  send(text: string): boolean {
    return this.lifecycle.send(text)
  }

  /**
   * Turn the channel on or off, persisting the choice.
   * @param enabled - requested switch position.
   * @returns the status after the change.
   */
  setEnabled(enabled: boolean): ChannelStatus {
    if (this.disposed) return this.lifecycle.status()
    this.refresh()
    if (enabled && this.record.binding === null) {
      // Nothing to bind to yet: remember the intent only once an account exists.
      this.log('the phone channel stays off until an account is bound')
      return this.lifecycle.status()
    }
    const next: ChannelRecord = enabled
      ? { enabled: true, enabledAt: this.now().toISOString(), binding: this.record.binding }
      : { enabled: false, enabledAt: null, binding: this.record.binding }
    if (!isSameRecord(next, this.record)) {
      this.record = next
      this.persist()
    }
    this.lifecycle.setEnabled(enabled)
    return this.lifecycle.status()
  }

  /**
   * Reconcile the stored switch with the account's current grant.
   *
   * Signing out clears the binding and turns the switch off; a grant that names a
   * different device, account, or origin replaces the binding and stops the
   * channel until the user turns it on again.
   */
  refresh(): void {
    if (this.disposed) return
    const credentials = this.readCredentials()
    if (credentials === undefined) {
      const cleared: ChannelRecord = { enabled: false, enabledAt: null, binding: null }
      if (!isSameRecord(cleared, this.record)) {
        this.record = cleared
        this.persist()
      }
      this.lifecycle.setEnabled(false)
      this.lifecycle.setCredentials(undefined)
      return
    }
    if (!bindingMatches(this.record.binding, credentials)) {
      const binding = createBinding({
        nodeId: credentials.nodeId,
        username: credentials.username,
        hubOrigin: credentials.hubOrigin,
        at: this.now(),
      })
      this.record = { enabled: false, enabledAt: null, binding }
      this.persist()
      this.lifecycle.setEnabled(false)
      this.lifecycle.setCredentials(credentials)
      return
    }
    this.lifecycle.setCredentials(credentials)
    this.lifecycle.setEnabled(this.record.enabled)
  }

  /**
   * Retry the connection now instead of waiting for the schedule.
   * @returns the status after arming the attempt.
   */
  retryNow(): ChannelStatus {
    this.refresh()
    this.lifecycle.retryNow()
    return this.lifecycle.status()
  }

  /** Stop the channel and stop persisting. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
  }

  /** Write the record; a failed write is reported and does not stop the channel. */
  private persist(): void {
    try {
      writeChannelRecord(this.profile, this.record)
    } catch (error) {
      this.log(`the phone channel record could not be written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
