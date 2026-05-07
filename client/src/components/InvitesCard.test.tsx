import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InvitesCard } from './InvitesCard';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('InvitesCard', () => {
  it('renders "Used: X of N" for non-admin', async () => {
    vi.spyOn(api, 'getMyInviteQuota').mockResolvedValue({
      used: 1,
      remaining: 2,
      default: 3,
    });
    vi.spyOn(api, 'getMyInvites').mockResolvedValue([]);
    render(<InvitesCard />);
    expect(
      await screen.findByText(/Used:\s*1\s*of\s*3.*2\s*remaining/i),
    ).toBeInTheDocument();
  });

  it('renders "Unlimited (admin)" when remaining is null', async () => {
    vi.spyOn(api, 'getMyInviteQuota').mockResolvedValue({
      used: 0,
      remaining: null,
      default: 3,
    });
    vi.spyOn(api, 'getMyInvites').mockResolvedValue([]);
    render(<InvitesCard />);
    expect(await screen.findByText(/Unlimited \(admin\)/i)).toBeInTheDocument();
  });

  it('disables Generate button when remaining is 0 and not admin', async () => {
    vi.spyOn(api, 'getMyInviteQuota').mockResolvedValue({
      used: 3,
      remaining: 0,
      default: 3,
    });
    vi.spyOn(api, 'getMyInvites').mockResolvedValue([]);
    render(<InvitesCard />);
    const btn = await screen.findByRole('button', {
      name: /Generate invite link/i,
    });
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it('Generate flow calls createMyInvite and refreshes the list', async () => {
    vi.spyOn(api, 'getMyInviteQuota')
      .mockResolvedValueOnce({ used: 0, remaining: 3, default: 3 })
      .mockResolvedValueOnce({ used: 1, remaining: 2, default: 3 });
    vi.spyOn(api, 'getMyInvites')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 7,
          code: 'pt-abc-123',
          created_by: 1,
          used_by: null,
          expires_at: '2026-06-05T00:00:00.000',
          created_at: '2026-05-06T00:00:00.000Z',
        },
      ]);
    const createSpy = vi
      .spyOn(api, 'createMyInvite')
      .mockResolvedValue({
        id: 7,
        code: 'pt-abc-123',
        created_by: 1,
        used_by: null,
        expires_at: '2026-06-05T00:00:00.000',
        created_at: '2026-05-06T00:00:00.000Z',
      });

    render(<InvitesCard />);
    const btn = await screen.findByRole('button', {
      name: /Generate invite link/i,
    });
    fireEvent.click(btn);

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(await screen.findByText(/pt-abc-123/)).toBeInTheDocument();
  });
});
