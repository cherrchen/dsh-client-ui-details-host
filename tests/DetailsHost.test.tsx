// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DetailsHost } from '../src/client/DetailsHost.tsx'
import type { DetailsHostProps } from '../src/client/DetailsHost.tsx'
import type { DetailsHostState, DetailsSurfaceInstance } from '../src/client/contract.ts'

afterEach(() => {
  cleanup()
})

const unused = (): never => {
  throw new Error('unused')
}

function instance(overrides: Partial<DetailsSurfaceInstance> = {}): DetailsSurfaceInstance {
  return {
    instanceId: 'details-instance-1',
    surfaceId: 'test.alpha',
    payload: { tab: 'diff' },
    label: 'Alpha',
    sessionId: 'session-a',
    ...overrides,
  }
}

function props(state: DetailsHostState, close = vi.fn()): DetailsHostProps {
  return {
    sessionId: 'session-a' as DetailsHostProps['sessionId'],
    useSession: unused,
    useSessions: unused,
    useWorkspaces: unused,
    renderSlot: (_name, owner, options) => (
      <div
        data-testid={`surface-${String(options?.only)}`}
        data-instance-id={(owner as { detailsInstance: DetailsSurfaceInstance }).detailsInstance.instanceId}
        data-payload={JSON.stringify((owner as { detailsInstance: DetailsSurfaceInstance }).detailsInstance.payload)}
      />
    ),
    useDetailsHost: selector => selector(state),
    close,
  }
}

describe('DetailsHost', () => {
  it('renders nothing while idle', () => {
    const view = render(<DetailsHost {...props({ activeId: null, activeInstance: null, label: null })} />)
    expect(view.container.querySelector('[data-details-host]')).toBeNull()
  })

  it('renders the active surface with owner payload and closes from the header', () => {
    const close = vi.fn()
    const active = instance()
    render(<DetailsHost {...props({ activeId: active.surfaceId, activeInstance: active, label: 'Alpha' }, close)} />)
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
    const surface = screen.getByTestId('surface-test.alpha')
    expect(surface.getAttribute('data-instance-id')).toBe('details-instance-1')
    expect(surface.getAttribute('data-payload')).toBe(JSON.stringify({ tab: 'diff' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
