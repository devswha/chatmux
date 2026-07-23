import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, ShieldCheck, Trash2, UserPlus } from 'lucide-react';

import { api } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

type AccessPayload = {
  authMode: 'none' | 'password' | 'tailscale';
  canManage: boolean;
  currentIdentity: string | null;
  role: 'owner' | 'user' | 'local' | null;
  owner: string | null;
  users: string[];
};

type NetworkPayload = {
  installed?: boolean;
  running?: boolean;
  dnsName?: string | null;
  httpsUrls?: string[];
  suggestedCommand?: string | null;
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
  return payload;
}

export default function AccessSettingsTab() {
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [network, setNetwork] = useState<NetworkPayload | null>(null);
  const [login, setLogin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [accessResponse, networkResponse] = await Promise.all([api.access.get(), api.access.network()]);
      const [nextAccess, nextNetwork] = await Promise.all([
        readJson<AccessPayload>(accessResponse),
        readJson<NetworkPayload>(networkResponse),
      ]);
      setAccess(nextAccess);
      setNetwork(nextNetwork);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load access settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addUser = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!login.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.access.allow(login.trim());
      const payload = await readJson<Pick<AccessPayload, 'owner' | 'users'>>(response);
      setAccess((current) => current ? { ...current, ...payload } : current);
      setLogin('');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to add user.');
    } finally {
      setSaving(false);
    }
  }, [login]);

  const removeUser = useCallback(async (user: string) => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.access.revoke(user);
      const payload = await readJson<Pick<AccessPayload, 'owner' | 'users'>>(response);
      setAccess((current) => current ? { ...current, ...payload } : current);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to remove user.');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!access) {
    return <div className="text-sm text-muted-foreground">{error || 'Loading access settings…'}</div>;
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Remote access"
        description="ChatMux stays bound to localhost. Tailscale Serve provides the private HTTPS endpoint."
      >
        <SettingsCard className="p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-emerald-500" />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium text-foreground">
                {access.authMode === 'tailscale' ? 'Tailscale identity protection is enabled' : 'Local access only'}
              </p>
              {network?.httpsUrls?.length ? (
                <div className="space-y-1">
                  {network.httpsUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 break-all text-sm text-primary hover:underline"
                    >
                      {url}<ExternalLink className="h-3.5 w-3.5 flex-none" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {network?.suggestedCommand || 'No Tailscale HTTPS address is active.'}
                </p>
              )}
              {access.currentIdentity && (
                <p className="text-xs text-muted-foreground">Connected as {access.currentIdentity} ({access.role})</p>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {access.authMode === 'tailscale' && (
        <SettingsSection
          title="Allowed Tailscale accounts"
          description="Only the owner can add or remove accounts. The owner cannot be removed."
        >
          <SettingsCard divided>
            {access.canManage ? access.users.map((user) => (
              <div key={user} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{user}</p>
                  <p className="text-xs text-muted-foreground">{user === access.owner ? 'Owner' : 'Allowed user'}</p>
                </div>
                {user !== access.owner && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void removeUser(user)}
                    aria-label={`Remove ${user}`}
                    className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">Only the owner can view and manage the allowlist.</p>
            )}
          </SettingsCard>

          {access.canManage && (
            <form onSubmit={addUser} className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor="tailscale-login" className="sr-only">Tailscale login</label>
              <input
                id="tailscale-login"
                type="text"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="user@example.com"
                autoComplete="off"
                className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={saving || !login.trim()}
                className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" />
                Add account
              </button>
            </form>
          )}
        </SettingsSection>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
