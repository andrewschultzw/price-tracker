import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Savings from './Savings';
import * as api from '../api';

vi.mock('../api');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Savings public page', () => {
  it('renders the hero number from the public endpoint', async () => {
    vi.mocked(api.getPublicSavings).mockResolvedValue({
      total_saved: 1247.83,
      purchase_count: 23,
      since: '2026-04-01T00:00:00Z',
      monthly: [
        { month: '2026-04', saved: 200 },
        { month: '2026-05', saved: 1047.83 },
      ],
    });
    render(<MemoryRouter><Savings /></MemoryRouter>);
    await waitFor(() => screen.getByText(/\$1,247\.83/));
    expect(screen.getByText(/23 purchases/i)).toBeInTheDocument();
  });

  it('renders gracefully when no purchases exist', async () => {
    vi.mocked(api.getPublicSavings).mockResolvedValue({
      total_saved: 0,
      purchase_count: 0,
      since: null,
      monthly: [],
    });
    render(<MemoryRouter><Savings /></MemoryRouter>);
    await waitFor(() => screen.getByText(/no purchases yet/i));
  });
});
