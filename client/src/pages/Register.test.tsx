import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import Register from './Register';

function renderWithRouter(component: React.ReactNode) {
  return render(
    <BrowserRouter>
      <AuthProvider>
        {component}
      </AuthProvider>
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Register - Invite Validation', () => {
  it('shows loading spinner while validating invite code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never resolves */ })));

    // Set up the URL with a code
    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);
    expect(screen.getByText('Checking invite...')).toBeInTheDocument();
  });

  it('shows inviter name when share_display_name is true', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        valid: true,
        inviter_name: 'Alice',
        expires_at: null,
      }),
    });

    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);

    await waitFor(() => {
      expect(screen.getByText('Invited by Alice')).toBeInTheDocument();
    });
  });

  it('shows "Invited" when inviter_name is null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        valid: true,
        inviter_name: null,
        expires_at: null,
      }),
    });

    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);

    await waitFor(() => {
      expect(screen.getByText('Invited')).toBeInTheDocument();
    });
  });

  it('shows "already used" error for used codes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        valid: false,
        reason: 'already_used',
      }),
    });

    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);

    await waitFor(() => {
      expect(screen.getByText('This invite has already been redeemed.')).toBeInTheDocument();
    });
  });

  it('shows "not found" error for unknown codes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        valid: false,
        reason: 'not_found',
      }),
    });

    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);

    await waitFor(() => {
      expect(screen.getByText('This invite link doesn\'t exist.')).toBeInTheDocument();
    });
  });

  it('shows "expired" error for expired codes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        valid: false,
        reason: 'expired',
      }),
    });

    window.history.pushState({}, '', '/register?code=testcode123');

    renderWithRouter(<Register />);

    await waitFor(() => {
      expect(screen.getByText('This invite has expired.')).toBeInTheDocument();
    });
  });
});
