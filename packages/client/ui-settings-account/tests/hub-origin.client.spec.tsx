// @vitest-environment jsdom
/**
 * The account card's Hub-address row.
 *
 * The row reads one connector document and writes one address, so these cases pin
 * what the card must never do: offer the address on a build without a connector,
 * store a new address without confirmation, or claim a result the connector did
 * not send.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { GlobalStandardProps, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountSection, type AccountSectionInjected, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import {
  HubOriginWatcher,
  parseHubOrigin,
  type HubOriginChangeResult,
  type HubOriginSnapshot,
} from '../src/client/hub-origin.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Origin the build carries in these cases. */
const BUILT = 'https://hub.example.com'

/** Another Hub the user can point this install at. */
const OTHER = 'https://other.example.com'

/** One resolved theme snapshot; the slot's theme hook serves this in the application. */
const theme: ThemeSnapshot = {
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}

/** Status document the connector serves for one address. */
function statusDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signedIn: true,
    hubOrigin: BUILT,
    hubOriginOverride: '',
    builtHubOrigin: BUILT,
    loginPhase: null,
    ...overrides,
  }
}

/** One snapshot the card can render. */
function snapshot(overrides: Partial<HubOriginSnapshot> = {}): HubOriginSnapshot {
  return { origin: BUILT, builtOrigin: BUILT, override: '', signedIn: true, signingIn: false, ...overrides }
}

/** One fetch answer a watcher can consume. */
function reply(status: number, body: unknown = {}): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response
}

/** The account view one mount renders. */
function accountView(signedIn: boolean): AccountView {
  return {
    status: signedIn ? 'credential-stored' : 'signed-out',
    attempt: null,
    links: { usageUrl: `${BUILT}/usage`, topUpUrl: `${BUILT}/usage` },
  }
}

/** Copy with the `{name}` placeholders the component passes filled in. */
function translate(copy: typeof en | typeof zh): TranslateNS<'settings.account'> {
  const dictionary: Record<string, string> = copy
  return (key, params) => {
    let text = dictionary[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

/**
 * Render the account section over one Hub-address snapshot.
 * @param initial - Address state the connector published, or undefined without a connector.
 * @param options - Whether the account is signed in, and which language to render.
 * @returns The injected face the card calls, and a publisher for a later snapshot.
 */
function mount(initial: HubOriginSnapshot | undefined, options: { signedIn: boolean; copy?: typeof en | typeof zh }) {
  const copy = options.copy ?? en
  let hubOrigin = initial
  const operations: AccountSectionInjected = {
    avatarFailed: vi.fn(),
    hooks: {
      account: {
        getSnapshot: (): AccountSnapshot => ({
          view: accountView(options.signedIn), details: undefined, avatar: undefined, failed: false, hubOrigin,
        }),
        subscribe: () => () => {},
      },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} },
    },
    hasRunningAccountTasks: vi.fn(async () => false),
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    refreshAccount: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()), signOut: vi.fn(() => Promise.resolve()),
    restartHub: vi.fn(() => Promise.resolve()),
    changeHubOrigin: vi.fn(async (): Promise<HubOriginChangeResult> => ({ status: 'failed' })),
  }
  const tree = () => (
    <AccountSection {...({} as GlobalStandardProps)} {...operations}
      useAccount={selector => selector(operations.hooks.account.getSnapshot())}
      useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
      close={() => {}} t={translate(copy)} />
  )
  const rendered = render(tree())
  return {
    operations,
    t: translate(copy),
    /** Publish one later snapshot, as the watcher does after a change. */
    show(next: HubOriginSnapshot | undefined) {
      hubOrigin = next
      rendered.rerender(tree())
    },
  }
}

it('reads the address the connector reports and rejects anything else', () => {
  expect(parseHubOrigin(statusDocument())).toEqual({ origin: BUILT, builtOrigin: BUILT, override: '', signedIn: true, signingIn: false })
  expect(parseHubOrigin(statusDocument({ hubOriginOverride: OTHER, loginPhase: 'waiting-browser' })))
    .toMatchObject({ override: OTHER, signingIn: true })
  // An older connector reports no override; the row reads that as "follows the build".
  const older = statusDocument()
  delete older.hubOriginOverride
  expect(parseHubOrigin(older)).toMatchObject({ override: '' })
  // No effective address means nothing to show: no connector, or a build with no origin.
  expect(parseHubOrigin(statusDocument({ hubOrigin: '' }))).toBeUndefined()
  expect(parseHubOrigin({ signedIn: true })).toBeUndefined()
  expect(parseHubOrigin(null)).toBeUndefined()
})

it('stops reading once the build has no connector route', async () => {
  const published: (HubOriginSnapshot | undefined)[] = []
  const fetch = vi.fn(async () => reply(404))
  const watcher = new HubOriginWatcher((value) => { published.push(value) }, { origin: 'http://host', intervalMs: 5, fetch })
  watcher.start()
  await waitFor(() => { expect(published).toEqual([undefined]) })
  watcher.dispose()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('submits one address and reports what the connector answered', async () => {
  const calls: string[] = []
  const answers: Response[] = [
    reply(400, { error: 'invalid-origin', message: 'the Hub requires HTTPS' }),
    reply(409, { error: 'sign-in-in-progress' }),
    reply(200, statusDocument({ hubOrigin: OTHER, hubOriginOverride: OTHER, signedIn: false })),
  ]
  const published: (HubOriginSnapshot | undefined)[] = []
  const watcher = new HubOriginWatcher((value) => { published.push(value) }, {
    origin: 'http://host',
    fetch: async (input, init): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(`${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`)
      return answers.shift() ?? reply(500)
    },
  })
  expect(await watcher.change('http://hub.example.com')).toEqual({ status: 'invalid-origin' })
  expect(await watcher.change(OTHER)).toEqual({ status: 'sign-in-in-progress' })
  const changed = await watcher.change(OTHER)
  watcher.dispose()
  expect(calls).toEqual([
    'POST http://host/hub-connector/api/settings {"hubOrigin":"http://hub.example.com"}',
    `POST http://host/hub-connector/api/settings {"hubOrigin":"${OTHER}"}`,
    `POST http://host/hub-connector/api/settings {"hubOrigin":"${OTHER}"}`,
  ])
  expect(changed).toMatchObject({ status: 'changed', snapshot: { origin: OTHER, override: OTHER, signedIn: false } })
  expect(published).toEqual([{ origin: OTHER, builtOrigin: BUILT, override: OTHER, signedIn: false, signingIn: false }])
})

it('renders no address row on a build without a connector', () => {
  for (const signedIn of [true, false]) {
    const view = mount(undefined, { signedIn })
    expect(screen.queryByText(view.t('hubOriginTitle'))).toBeNull()
    cleanup()
  }
})

it('shows the address in effect whether or not the account is signed in', () => {
  const signedInView = mount(snapshot(), { signedIn: true })
  expect(screen.getByText(signedInView.t('hubOriginTitle'))).toBeTruthy()
  expect(screen.getByText(BUILT)).toBeTruthy()
  cleanup()
  const signedOutView = mount(snapshot({ signedIn: false }), { signedIn: false })
  expect(screen.getByText(signedOutView.t('hubOriginTitle'))).toBeTruthy()
  expect(screen.getByText(BUILT)).toBeTruthy()
})

it('asks before pointing the computer at another Hub and names the sign-out', async () => {
  const view = mount(snapshot(), { signedIn: true })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginChange') }))
  const input = screen.getByRole('textbox', { name: view.t('hubOriginTitle') })
  expect(input.getAttribute('value')).toBe(BUILT)
  fireEvent.change(input, { target: { value: OTHER } })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginSave') }))
  // Nothing is stored before the confirmation step.
  expect(view.operations.changeHubOrigin).not.toHaveBeenCalled()
  const confirm = screen.getByRole('group', { name: view.t('hubOriginConfirmTitle') })
  expect(confirm.textContent).toContain(view.t('hubOriginConfirmBody').replace('{origin}', OTHER))
  expect(confirm.textContent).toContain(view.t('hubOriginConfirmSignOut'))
  fireEvent.click(within(confirm).getByRole('button', { name: view.t('cancel') }))
  expect(screen.queryByRole('group', { name: view.t('hubOriginConfirmTitle') })).toBeNull()
  expect(view.operations.changeHubOrigin).not.toHaveBeenCalled()
})

it('stores the confirmed address and drops the editor when the connector accepted it', async () => {
  const view = mount(snapshot(), { signedIn: true })
  vi.mocked(view.operations.changeHubOrigin as (value: string) => Promise<HubOriginChangeResult>)
    .mockResolvedValue({ status: 'changed', snapshot: snapshot({ origin: OTHER, override: OTHER, signedIn: false }) })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginChange') }))
  fireEvent.change(screen.getByRole('textbox', { name: view.t('hubOriginTitle') }), { target: { value: OTHER } })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginSave') }))
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginConfirmAction') }))
  await waitFor(() => { expect(view.operations.changeHubOrigin).toHaveBeenCalledWith(OTHER) })
  await waitFor(() => { expect(screen.queryByRole('textbox', { name: view.t('hubOriginTitle') })).toBeNull() })
  expect(screen.queryByRole('group', { name: view.t('hubOriginConfirmTitle') })).toBeNull()
  view.show(snapshot({ origin: OTHER, override: OTHER, signedIn: false }))
  expect(screen.getByText(OTHER)).toBeTruthy()
})

it('offers the default address for a customised install and restores it', async () => {
  const view = mount(snapshot({ origin: OTHER, override: OTHER, signedIn: false }), { signedIn: true })
  expect(screen.getByText(view.t('hubOriginCustomised').replace('{built}', BUILT))).toBeTruthy()
  expect(screen.getByText(view.t('hubOriginUpdateNote'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginRestore') }))
  const confirm = screen.getByRole('group', { name: view.t('hubOriginConfirmTitle') })
  expect(confirm.textContent).toContain(view.t('hubOriginConfirmBody').replace('{origin}', BUILT))
  // Signed out, so the confirmation does not promise a sign-out.
  expect(confirm.textContent).not.toContain(view.t('hubOriginConfirmSignOut'))
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginConfirmAction') }))
  await waitFor(() => { expect(view.operations.changeHubOrigin).toHaveBeenCalledWith('') })
})

it('restores the default without a confirmation when nothing is customised', () => {
  const view = mount(snapshot(), { signedIn: true })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginChange') }))
  fireEvent.change(screen.getByRole('textbox', { name: view.t('hubOriginTitle') }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginSave') }))
  expect(screen.queryByRole('group', { name: view.t('hubOriginConfirmTitle') })).toBeNull()
  expect(screen.queryByRole('textbox', { name: view.t('hubOriginTitle') })).toBeNull()
  expect(view.operations.changeHubOrigin).not.toHaveBeenCalled()
})

it('closes the editor without a confirmation when the address did not change', () => {
  const view = mount(snapshot(), { signedIn: true })
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginChange') }))
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginSave') }))
  expect(screen.queryByRole('group', { name: view.t('hubOriginConfirmTitle') })).toBeNull()
  expect(screen.queryByRole('textbox', { name: view.t('hubOriginTitle') })).toBeNull()
  expect(view.operations.changeHubOrigin).not.toHaveBeenCalled()
})

it('shows a refused address and an attempt that must finish first', async () => {
  const view = mount(snapshot(), { signedIn: true })
  const change = vi.mocked(view.operations.changeHubOrigin as (value: string) => Promise<HubOriginChangeResult>)
  const submit = (value: string) => {
    fireEvent.change(screen.getByRole('textbox', { name: view.t('hubOriginTitle') }), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginSave') }))
    fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginConfirmAction') }))
  }
  // One editor stays open across both refusals; the row only offers "Change" once it closes.
  fireEvent.click(screen.getByRole('button', { name: view.t('hubOriginChange') }))
  change.mockResolvedValueOnce({ status: 'invalid-origin' })
  submit('http://hub.example.com')
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(view.t('hubOriginInvalid')) })
  change.mockResolvedValueOnce({ status: 'sign-in-in-progress' })
  submit(OTHER)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(view.t('hubOriginSigningIn')) })
})

it('disables the change while a sign-in is in flight', () => {
  const view = mount(snapshot({ signingIn: true }), { signedIn: true })
  const change = screen.getByRole('button', { name: view.t('hubOriginChange') }) as HTMLButtonElement
  expect(change.disabled).toBe(true)
})
