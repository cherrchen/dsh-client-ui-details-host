/**
 * ShellDetailsService (`ctx.shellDetails`): dynamic `details` takeover,
 * one active surface instance, descriptors, and layout open/close.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, SlotLabel, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  DETAILS_HEADER_ACTIONS_SLOT,
  DETAILS_HOST_ENTRY_ID,
  DETAILS_HOST_PRIORITY,
  DETAILS_SURFACE_SLOT,
  SHELL_DETAILS_API_VERSION,
  SHELL_DETAILS_ENABLED_FEATURES,
  type DetailsHostInjected,
  type DetailsHostState,
  type DetailsSurfaceCloseReason,
  type DetailsSurfaceDescriptor,
  type DetailsSurfaceInstance,
  type ShellDetailsController,
  type ShellDetailsFeature,
  type ShellDetailsOpenRequest,
  type ShellDetailsSnapshot,
} from './contract.ts'
import {
  DetailsDescriptorRegistry,
  notifyClosed,
  notifyOpened,
} from './descriptor.ts'
import {
  DetailsSurfaceDuplicateError,
  DetailsSurfaceNotFoundError,
  DetailsTakeoverConflictError,
} from './errors.ts'
import { createSurfaceInstance } from './instance.ts'
import { DetailsHost } from './DetailsHost.tsx'

/** Mutable snapshot source for DetailsHost inject and public subscribe. */
class DetailsHostStateSource implements HostObservable<DetailsHostState> {
  #snapshot: DetailsHostState = { activeId: null, activeInstance: null, label: null }
  readonly #listeners = new Set<() => void>()

  /**
   * @returns the current active-surface snapshot.
   */
  getSnapshot(): DetailsHostState {
    return this.#snapshot
  }

  /**
   * Subscribe to snapshot replacement.
   * @param listener - notified after a distinct snapshot is published.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Replace the snapshot when the active instance identity or label changes.
   * @param snapshot - next published state.
   */
  set(snapshot: DetailsHostState): void {
    const prev = this.#snapshot
    if (
      snapshot.activeId === prev.activeId
      && snapshot.label === prev.label
      && snapshot.activeInstance?.instanceId === prev.activeInstance?.instanceId
      && snapshot.activeInstance?.payload === prev.activeInstance?.payload
    ) {
      return
    }
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

function resolveLabel(label: SlotLabel | undefined, id: string): string {
  if (typeof label === 'function') return label()
  if (typeof label === 'string') return label
  return id
}

function isOpenRequest(value: string | ShellDetailsOpenRequest): value is ShellDetailsOpenRequest {
  return typeof value === 'object' && value !== null && 'surfaceId' in value
}

function toPublicSnapshot(state: DetailsHostState): ShellDetailsSnapshot {
  return {
    open: state.activeInstance !== null,
    activeId: state.activeId,
    activeInstance: state.activeInstance,
    label: state.label,
    canGoBack: false,
    historyDepth: 0,
  }
}

/** `ctx.shellDetails` implementation. */
export class ShellDetailsService extends Service implements ShellDetailsController {
  static inject = ['slots', 'layout', 'sessions']

  readonly apiVersion = SHELL_DETAILS_API_VERSION
  readonly features: ReadonlySet<ShellDetailsFeature> = new Set(SHELL_DETAILS_ENABLED_FEATURES)

  private readonly owner: Context
  private readonly state = new DetailsHostStateSource()
  private readonly descriptors = new DetailsDescriptorRegistry()
  private takeover: (() => void) | undefined

  /**
   * @param ctx - owning plugin fiber. Takeover registrations ride this fiber
   * so consumer `open()` calls cannot pin the occupant to another plugin.
   */
  constructor(ctx: Context) {
    super(ctx, 'shellDetails')
    this.owner = ctx
    ctx.effect(() => () => {
      this.closeWithReason('host-unload')
      this.descriptors.clear()
    }, 'shellDetails: unload')
    ctx.effect(() => {
      const sessions = ctx.sessions
      let current = sessions.list.getSnapshot().current
      return sessions.list.subscribe(() => {
        const next = sessions.list.getSnapshot().current
        if (next === current) return
        current = next
        this.closeWithReason('session-close')
      })
    }, 'shellDetails: session switch')
    ctx.effect(() => ctx.slots.subscribe(DETAILS_SURFACE_SLOT, () => { this.onSurfacesChanged() }), 'shellDetails: surface ledger')
    ctx.effect(() => ctx.slots.onEntryError((key, entry) => {
      if (key !== DETAILS_SURFACE_SLOT) return
      if (entry.options.id === this.activeId) this.closeWithReason('surface-crash')
    }), 'shellDetails: surface crash')
  }

  /**
   * @returns the active surface id, or null while closed.
   */
  get activeId(): string | null {
    return this.state.getSnapshot().activeId
  }

  /**
   * @returns the active surface instance, or null while closed.
   */
  get activeInstance(): DetailsSurfaceInstance | null {
    return this.state.getSnapshot().activeInstance
  }

  /**
   * Read the public reactive snapshot.
   * @returns current shell details state.
   */
  getSnapshot(): ShellDetailsSnapshot {
    return toPublicSnapshot(this.state.getSnapshot())
  }

  /**
   * Subscribe to public snapshot changes.
   * @param listener - notified after a distinct snapshot is published.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    return this.state.subscribe(listener)
  }

  /**
   * Register optional behavior metadata for a surface id.
   * @param descriptor - lifecycle and future dedupe metadata.
   * @returns disposer that removes the descriptor.
   */
  registerSurface<P = unknown>(descriptor: DetailsSurfaceDescriptor<P>): () => void {
    return this.descriptors.register(descriptor)
  }

  /**
   * Occupy `details` with DetailsHost, activate a surface, and open the column.
   * @param id - registered `shell.details.surface` contribution id.
   */
  open(id: string): void
  /**
   * Occupy `details` with DetailsHost, create an instance from `request`,
   * and open the column.
   * @param request - surface id plus optional payload.
   * @returns the committed active instance.
   */
  open<P = unknown>(request: ShellDetailsOpenRequest<P>): DetailsSurfaceInstance<P>
  open(idOrRequest: string | ShellDetailsOpenRequest): DetailsSurfaceInstance | void {
    const request: ShellDetailsOpenRequest = isOpenRequest(idOrRequest)
      ? idOrRequest
      : { surfaceId: idOrRequest }
    const returnInstance = isOpenRequest(idOrRequest)
    const acquiredTakeover = this.takeover === undefined

    // `shell.details.surface` contributions materialize through slots.inject
    // only after DetailsHost declares the slot, so takeover precedes lookup.
    if (acquiredTakeover) {
      try {
        this.takeover = this.registerTakeover()
        this.assertTakeoverWinner()
      } catch (error) {
        this.rollbackTakeover()
        throw error
      }
    } else {
      try {
        this.assertTakeoverWinner()
      } catch (error) {
        this.rollbackTakeover()
        throw error
      }
    }

    try {
      const entry = this.requireUniqueSurface(request.surfaceId)
      const label = resolveLabel(entry.options.label, request.surfaceId)
      const candidate = createSurfaceInstance(
        request.surfaceId,
        request.payload as unknown,
        label,
        this.currentSessionId(),
      )
      const previous = this.activeInstance
      if (previous !== null) {
        notifyClosed(this.descriptors, previous, 'replace')
      }
      this.commitInstance(candidate)
      notifyOpened(this.descriptors, candidate)
      this.owner.layout.openDetails()
      return returnInstance ? candidate : undefined
    } catch (error) {
      if (acquiredTakeover) this.rollbackTakeover()
      throw error
    }
  }

  /**
   * Close the details column, clear the active instance, and dispose takeover.
   */
  close(): void {
    this.closeWithReason('user')
  }

  /**
   * Open `id` when it is not active; close when it is.
   * @param id - registered `shell.details.surface` contribution id.
   */
  toggle(id: string): void {
    if (this.isOpen(id)) this.close()
    else this.open(id)
  }

  /**
   * Whether any surface is active, or whether `id` is the active surface.
   * @param id - optional surface id to compare.
   * @returns open state for the requested query.
   */
  isOpen(id?: string): boolean {
    if (id === undefined) return this.activeInstance !== null
    return this.activeId === id
  }

  private closeWithReason(reason: DetailsSurfaceCloseReason): void {
    if (this.takeover === undefined && this.activeInstance === null) return
    const leaving = this.activeInstance
    if (leaving !== null) {
      notifyClosed(this.descriptors, leaving, reason)
    }
    try {
      this.owner.layout.closeDetails()
    } catch (error) {
      if (error instanceof Error && /panel actions not wired/.test(error.message)) {
        // Root entry already gone during plugin unload.
      } else {
        throw error
      }
    }
    this.clearState()
    const dispose = this.takeover
    this.takeover = undefined
    dispose?.()
  }

  private registerTakeover(): () => void {
    return this.owner.slots.register({
      name: 'details',
      // Single-cell slot: identity rides `registrant`, not list `id`.
      registrant: DETAILS_HOST_ENTRY_ID,
      priority: DETAILS_HOST_PRIORITY,
      children: {
        'shell.details.surface': { kind: 'list', scope: 'session' },
        [DETAILS_HEADER_ACTIONS_SLOT]: { kind: 'list', scope: 'session' },
      },
      inject: (): DetailsHostInjected => ({
        hooks: { detailsHost: this.state },
        close: () => { this.close() },
      }),
    }, DetailsHost)
  }

  private assertTakeoverWinner(): void {
    const winner = this.owner.slots.entriesOfSlot('details')[0]
    if (winner === undefined || winner.component !== DetailsHost) {
      throw new DetailsTakeoverConflictError(winner?.registrant ?? winner?.options.id)
    }
  }

  private commitInstance(instance: DetailsSurfaceInstance): void {
    this.state.set({
      activeId: instance.surfaceId,
      activeInstance: instance,
      label: instance.label,
    })
  }

  private clearState(): void {
    this.state.set({ activeId: null, activeInstance: null, label: null })
  }

  private requireUniqueSurface(id: string): StoredEntry {
    const matches = this.owner.slots.entries(DETAILS_SURFACE_SLOT)
      .filter(candidate => candidate.options.id === id)
    if (matches.length === 0) {
      throw new DetailsSurfaceNotFoundError(id)
    }
    if (matches.length > 1) {
      throw new DetailsSurfaceDuplicateError(id, matches.length)
    }
    return matches[0]!
  }

  private currentSessionId(): string {
    const current = this.owner.sessions.list.getSnapshot().current
    return typeof current === 'string' && current.length > 0 ? current : ''
  }

  private rollbackTakeover(): void {
    this.clearState()
    const dispose = this.takeover
    this.takeover = undefined
    dispose?.()
  }

  private onSurfacesChanged(): void {
    const activeId = this.activeId
    if (activeId === null) return
    const present = this.owner.slots.entries(DETAILS_SURFACE_SLOT).some(entry => entry.options.id === activeId)
    if (!present) this.closeWithReason('surface-unload')
  }
}
