import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Settings, Zap } from 'lucide-react';

interface Props {
  hasNoTrackers: boolean;
}

export default function WelcomeModal({ hasNoTrackers }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const isDismissed = localStorage.getItem('welcome_modal_dismissed');
    if (hasNoTrackers && !isDismissed) {
      setIsOpen(true);
    }
  }, [hasNoTrackers]);

  const handleDismiss = () => {
    localStorage.setItem('welcome_modal_dismissed', 'true');
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface border border-border rounded-xl p-8 max-w-md w-full">
        <h2 className="text-2xl font-bold text-text mb-2">Welcome to Price Tracker</h2>
        <p className="text-text-muted mb-6">Get started with these quick actions:</p>

        <div className="space-y-3 mb-6">
          <Link
            to="/add"
            className="flex items-center gap-3 p-4 bg-bg border border-border rounded-lg hover:border-primary transition-colors no-underline"
          >
            <Plus className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="font-medium text-text">Add your first tracker</div>
              <div className="text-xs text-text-muted">Track a product URL</div>
            </div>
          </Link>

          <Link
            to="/settings"
            className="flex items-center gap-3 p-4 bg-bg border border-border rounded-lg hover:border-primary transition-colors no-underline"
          >
            <Settings className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="font-medium text-text">Set up notifications</div>
              <div className="text-xs text-text-muted">Get alerts when prices drop</div>
            </div>
          </Link>

          <Link
            to="/deals"
            className="flex items-center gap-3 p-4 bg-bg border border-border rounded-lg hover:border-primary transition-colors no-underline"
          >
            <Zap className="w-5 h-5 text-primary flex-shrink-0" />
            <div>
              <div className="font-medium text-text">Browse community deals</div>
              <div className="text-xs text-text-muted">See what others are tracking</div>
            </div>
          </Link>
        </div>

        <button
          onClick={handleDismiss}
          className="w-full px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors"
        >
          Get Started
        </button>
        <button
          onClick={handleDismiss}
          className="w-full mt-2 px-4 py-2 bg-bg border border-border text-text rounded-lg font-medium hover:bg-surface-hover transition-colors"
        >
          Don't show again
        </button>
      </div>
    </div>
  );
}
