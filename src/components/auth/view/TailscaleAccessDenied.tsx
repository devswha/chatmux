import { RefreshCw, ShieldX } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthScreenLayout from './AuthScreenLayout';

export default function TailscaleAccessDenied() {
  const { error } = useAuth();

  return (
    <AuthScreenLayout
      title="Tailscale access required"
      description="ChatMux only accepts approved Tailscale accounts on this server."
      footerText="Ask the server owner to add your Tailscale login."
    >
      <div className="space-y-4">
        <div className="flex justify-center" aria-hidden>
          <ShieldX className="h-10 w-10 text-muted-foreground" />
        </div>
        <AuthErrorAlert errorMessage={error || 'Access denied by the server policy.'} />
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
      </div>
    </AuthScreenLayout>
  );
}
