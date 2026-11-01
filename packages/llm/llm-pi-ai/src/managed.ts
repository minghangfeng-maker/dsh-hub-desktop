/**
 * Provider routes another plugin owns on this adapter's behalf.
 *
 * A desktop Hub delivers model routes the user must not edit, while the user's
 * own routes stay in the profile patch the Models page writes. Both reach the
 * adapter through one registration surface, so the route set, the model list, and
 * the configurable-provider directory see their union, and an edit to the user's
 * section touches only the user's routes.
 *
 * A contribution is a whole set per source. A replacement is committed only when
 * the adapter could actually register the merged routes and directory entries:
 * the registry asks its owner to apply the prospective snapshot first, and a
 * throw leaves every previous set, registration, and directory entry serving.
 * `withdraw()` empties a slot for a signed-out contributor that may sign in again;
 * `release()` ends the slot's life so a later adapter or connector instance can
 * hold the same source name.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/managed
 */
import { Config } from './config.ts'
import type { Options, PiAiProviderProfile } from './config.ts'

/** What one contributor holds. */
export interface PiAiManagedProviderSlot {
  /** Contributor name used in diagnostics and conflict messages. */
  readonly source: string
  /**
   * Replace this source's whole provider set.
   *
   * The candidate set is validated against this package's schema, the user's own
   * routes, every other source, and the live adapter and directory registrations
   * before the swap; a throw leaves the previous set serving.
   * @param providers - Provider profiles keyed by route, as manifest or settings data.
   * @throws {Error} When a route is invalid, owned elsewhere, or cannot be registered.
   */
  replace(providers: Readonly<Record<string, unknown>>): void
  /**
   * Withdraw every route this source contributed. The slot stays usable: a
   * contributor that signs out and back in replaces its set again.
   * @throws {Error} When the slot was released.
   */
  withdraw(): void
  /**
   * End this slot: its routes leave the adapter and the source name becomes free.
   * The connector scope releases its slot when the connector unloads, so a new
   * connector instance can contribute the same source name.
   * @throws {Error} When the slot was released.
   */
  release(): void
}

/** One detached view of every managed provider set. */
export interface ManagedProvidersSnapshot {
  /** Detached provider profiles keyed by route, in contributor order. */
  readonly providers: Readonly<Record<string, PiAiProviderProfile>>
  /** Every managed route key. */
  readonly routes: ReadonlySet<string>
  /** Monotonic counter that changes whenever a set is committed, withdrawn, or released. */
  readonly revision: number
}

/** How one application relates to the live state. */
export interface ManagedProvidersApplyOptions {
  /**
   * True for the rollback application after a failed commit: the snapshot is the
   * last good state, so route ownership checks must not treat the routes being
   * restored as foreign.
   */
  readonly restoring: boolean
}

/**
 * Apply one prospective snapshot to the live adapter and directory.
 *
 * The owner implements this as one transaction: it validates and prepares the
 * merged route set and directory entries, registers them, and throws when any
 * part cannot be registered. The registry calls it with the previous snapshot
 * when a commit fails, so the owner restores what is actually serving.
 */
export type ManagedProvidersApply = (snapshot: ManagedProvidersSnapshot, options: ManagedProvidersApplyOptions) => void

/** The contribution registry this adapter provides to the composition. */
export interface PiAiManagedProviders {
  /**
   * Hold one contributor slot.
   * @param source - Contributor name; one live slot per source.
   * @returns The slot, which replaces atomically, withdraws, and releases.
   * @throws {Error} When the source already holds a slot.
   */
  contribute(source: string): PiAiManagedProviderSlot
  /**
   * Read the merged managed set.
   * @returns Detached provider profiles, their route keys, and the revision counter.
   */
  snapshot(): ManagedProvidersSnapshot
  /**
   * Observe committed changes.
   * @param listener - Called after a set was committed, withdrawn, or released.
   * @returns Unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Validate one JSON-shaped provider set through the adapter's own configuration
 * schema, then detach it as plain mutable data.
 *
 * The contributor hands over parsed JSON (a manifest fragment), so the schema is
 * the boundary that narrows it; its output is deeply readonly, and the adapter's
 * own resolution types the profiles as mutable, hence the JSON round trip.
 * @param source - Contributor name, for the refusal message.
 * @param providers - Raw provider profiles keyed by route.
 * @returns Validated profiles keyed by route.
 * @throws {Error} When the set does not satisfy the configuration schema.
 */
function parseManagedProviders(source: string, providers: Readonly<Record<string, unknown>>): Record<string, PiAiProviderProfile> {
  let text: string | undefined
  try {
    // The schema's `providers` member is volatile, so validation yields the same
    // observable the running plugin reads; its current value is the parsed set.
    const parsed = Config({ providers: structuredClone(providers) as NonNullable<Options['providers']> }).providers.get()
    text = JSON.stringify(parsed)
  } catch (error) {
    throw new Error(
      `the managed provider set from "${source}" is not valid llm-pi-ai configuration: `
      + (error instanceof Error ? error.message : String(error)),
    )
  }
  return JSON.parse(text) as Record<string, PiAiProviderProfile>
}

/** One contribution registry instance per adapter mount. */
export class PiAiManagedProviderRegistry implements PiAiManagedProviders {
  private sets = new Map<string, Record<string, PiAiProviderProfile>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  /**
   * Candidate sets while a transaction is in flight. `snapshot()` serves these so
   * the owner's registration code captures the configuration being committed, not
   * the one already published; the revision moves to the candidate value too, so
   * the adapter's memo recognizes the change and re-resolves.
   */
  private pending: Map<string, Record<string, PiAiProviderProfile>> | undefined

  /**
   * @param personalRoutes - Route keys the user's own configuration currently declares.
   * @param apply - Live registration transaction; throws when the snapshot cannot be served.
   */
  constructor(
    private readonly personalRoutes: () => ReadonlySet<string>,
    private readonly apply: ManagedProvidersApply,
  ) {}

  contribute(source: string): PiAiManagedProviderSlot {
    if (source === '') throw new Error('a managed provider source needs a name')
    if (this.sets.has(source)) throw new Error(`the managed provider source "${source}" is already contributed`)
    const next = new Map(this.sets)
    next.set(source, {})
    this.commit(next)
    let released = false
    const assertLive = (operation: string): void => {
      if (!released) return
      throw new Error(`the managed provider source "${source}" was released; ${operation} is no longer accepted`)
    }
    return {
      source,
      replace: (providers) => {
        assertLive('replace')
        this.replace(source, providers)
      },
      withdraw: () => {
        assertLive('withdraw')
        this.withdraw(source)
      },
      release: () => {
        assertLive('release')
        this.withdraw(source, { release: true })
        released = true
      },
    }
  }

  snapshot(): ManagedProvidersSnapshot {
    if (this.pending === undefined) return this.snapshotOf(this.sets)
    // The candidate is what a commit would publish, so a registration performed
    // during the transaction reads the new display name and retry policy.
    return this.snapshotOf(this.pending, this.revision + 1)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Detach every profile and route so a caller cannot mutate internal state. */
  private snapshotOf(
    sets: ReadonlyMap<string, Record<string, PiAiProviderProfile>>,
    revision = this.revision,
  ): ManagedProvidersSnapshot {
    const providers: Record<string, PiAiProviderProfile> = {}
    for (const set of sets.values()) {
      for (const [route, profile] of Object.entries(set)) {
        providers[route] = structuredClone(profile)
      }
    }
    return { providers, routes: new Set(Object.keys(providers)), revision }
  }

  private replace(source: string, providers: Readonly<Record<string, unknown>>): void {
    if (!this.sets.has(source)) throw new Error(`the managed provider source "${source}" is not contributed`)
    const profiles = parseManagedProviders(source, providers)
    const personal = this.personalRoutes()
    const heldByOthers = new Set<string>()
    for (const [other, set] of this.sets) {
      if (other === source) continue
      for (const route of Object.keys(set)) heldByOthers.add(route)
    }
    for (const route of Object.keys(profiles)) {
      if (personal.has(route)) {
        throw new Error(
          `the managed model route "${route}" from "${source}" collides with a provider the user configured;`
          + ' the Hub update is refused and the previous routes stay in service',
        )
      }
      if (heldByOthers.has(route)) {
        throw new Error(`the managed model route "${route}" from "${source}" is already contributed by another source`)
      }
    }
    const next = new Map(this.sets)
    next.set(source, profiles)
    this.commit(next)
  }

  private withdraw(source: string, options: { readonly release?: boolean } = {}): void {
    if (!this.sets.has(source)) return
    // A withdrawal of an empty set changes nothing; a release still frees the name.
    if (options.release !== true && Object.keys(this.sets.get(source) ?? {}).length === 0) return
    const next = new Map(this.sets)
    if (options.release === true) next.delete(source)
    else next.set(source, {})
    this.commit(next)
  }

  /**
   * Try one whole prospective state, then publish it.
   *
   * The owner's apply is the transaction: a throw means nothing moved, so the
   * revision and the stored sets stay exactly as they were and the caller sees
   * the failure. On success the listeners observe a committed change.
   */
  private commit(next: Map<string, Record<string, PiAiProviderProfile>>): void {
    const previous = this.sets
    this.pending = next
    try {
      this.apply(this.snapshot(), { restoring: false })
    } catch (error) {
      // The candidate is no longer offered once the transaction failed; the owner
      // then restores what it actually registered from the published snapshot.
      this.pending = undefined
      try {
        this.apply(this.snapshotOf(previous), { restoring: true })
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'the managed provider change failed and the previous routes could not be restored',
        )
      }
      throw error
    }
    this.pending = undefined
    this.sets = next
    this.revision += 1
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // These are UI notifications; the registration already committed above.
      }
    }
  }
}
