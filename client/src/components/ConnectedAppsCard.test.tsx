import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectedAppsCard } from './ConnectedAppsCard';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectedAppsCard', () => {
  it('renders existing tokens with name + prefix + created date', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([
      { id: 1, name: 'My Mac', prefix: 'pt_a3b9c', created_at: 1700000000000, last_used_at: null, revoked_at: null },
    ]);
    render(<ConnectedAppsCard />);
    expect(await screen.findByText('My Mac')).toBeInTheDocument();
    expect(screen.getByText(/pt_a3b9c/)).toBeInTheDocument();
  });

  it('clicking Generate opens the dialog', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([]);
    render(<ConnectedAppsCard />);
    await waitFor(() => expect(screen.getByText(/Generate new token/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Generate new token/i));
    expect(screen.getByPlaceholderText(/e\.g\./i)).toBeInTheDocument();
  });

  it('Generate flow reveals plaintext token once', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([]);
    vi.spyOn(api, 'createApiToken').mockResolvedValue({
      id: 1, name: 'My Mac', token: 'pt_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk',
      prefix: 'pt_aaaab', created_at: Date.now(),
      last_used_at: null, revoked_at: null,
    });
    render(<ConnectedAppsCard />);
    await waitFor(() => screen.getByText(/Generate new token/i));
    fireEvent.click(screen.getByText(/Generate new token/i));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), { target: { value: 'My Mac' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate$/i }));
    expect(await screen.findByText(/pt_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk/)).toBeInTheDocument();
  });

  it('Revoke calls the API and removes the row', async () => {
    vi.spyOn(api, 'listApiTokens')
      .mockResolvedValueOnce([{ id: 7, name: 'Old', prefix: 'pt_aaaaa', created_at: 0, last_used_at: null, revoked_at: null }])
      .mockResolvedValueOnce([]);
    const revokeSpy = vi.spyOn(api, 'revokeApiToken').mockResolvedValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectedAppsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/i }));
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(7));
  });
});
