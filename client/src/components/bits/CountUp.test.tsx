import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CountUp from './CountUp'

describe('CountUp', () => {
  beforeEach(() => {
    // jsdom has matchMedia only if mocked
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  it('renders the final value immediately under prefers-reduced-motion', () => {
    render(<CountUp value={42} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })
  it('applies prefix and decimals', () => {
    render(<CountUp value={12.5} prefix="$" decimals={2} />)
    expect(screen.getByText('$12.50')).toBeInTheDocument()
  })
})
