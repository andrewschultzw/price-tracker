import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import WelcomeModal from './WelcomeModal';

function renderWithRouter(component: React.ReactNode) {
  return render(
    <BrowserRouter>
      {component}
    </BrowserRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('WelcomeModal', () => {
  it('renders nothing when hasNoTrackers is false', () => {
    const { container } = renderWithRouter(<WelcomeModal hasNoTrackers={false} />);
    expect(container.querySelector('.fixed')).not.toBeInTheDocument();
  });

  it('renders nothing when localStorage key is set (dismissed)', () => {
    localStorage.setItem('welcome_modal_dismissed', 'true');
    const { container } = renderWithRouter(<WelcomeModal hasNoTrackers={true} />);
    expect(container.querySelector('.fixed')).not.toBeInTheDocument();
  });

  it('renders modal when hasNoTrackers is true and localStorage is empty', () => {
    renderWithRouter(<WelcomeModal hasNoTrackers={true} />);
    expect(screen.getByText('Welcome to Price Tracker')).toBeInTheDocument();
    expect(screen.getByText('Add your first tracker')).toBeInTheDocument();
    expect(screen.getByText('Set up notifications')).toBeInTheDocument();
    expect(screen.getByText('Browse community deals')).toBeInTheDocument();
  });

  it('"Get Started" button (first button) dismisses the modal', async () => {
    const { container } = renderWithRouter(<WelcomeModal hasNoTrackers={true} />);
    expect(screen.getByText('Welcome to Price Tracker')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]); // "Get Started" is the first button

    await waitFor(() => {
      expect(container.querySelector('.fixed')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('welcome_modal_dismissed')).toBe('true');
  });

  it('"Don\'t show again" button dismisses the modal and sets localStorage', async () => {
    const { container } = renderWithRouter(<WelcomeModal hasNoTrackers={true} />);
    expect(screen.getByText('Welcome to Price Tracker')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[1]); // "Don't show again" is the second button

    await waitFor(() => {
      expect(container.querySelector('.fixed')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem('welcome_modal_dismissed')).toBe('true');
  });

  it('contains working links to /add, /settings, and /deals', () => {
    renderWithRouter(<WelcomeModal hasNoTrackers={true} />);

    const addLink = screen.getByText('Add your first tracker').closest('a');
    const settingsLink = screen.getByText('Set up notifications').closest('a');
    const dealsLink = screen.getByText('Browse community deals').closest('a');

    expect(addLink).toHaveAttribute('href', '/add');
    expect(settingsLink).toHaveAttribute('href', '/settings');
    expect(dealsLink).toHaveAttribute('href', '/deals');
  });
});
