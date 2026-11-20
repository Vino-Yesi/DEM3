import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/passwords';

export default function PasswordChange() {
  const { user, loading, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (loading) return <div className="min-h-screen bg-black" />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.mustChangePassword) return <Navigate to="/" replace />;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await changePassword(password);
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update your password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#050508] text-white flex items-center justify-center p-4">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-6 sm:p-8 shadow-2xl">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300">
          <KeyRound className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-bold">Choose a new password</h1>
        <p className="mt-2 text-sm leading-6 text-white/60">
          {user.mustChangePassword
            ? 'This account used an older or temporary password. Set a unique password before opening warehouse screens.'
            : 'Update your sign-in password.'}
        </p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <label className="block text-xs text-white/65">
            New password
            <input
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-sky-400/60"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </label>
          <label className="block text-xs text-white/65">
            Confirm new password
            <input
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-sky-400/60"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </label>
          <p className="text-[11px] leading-5 text-white/45">
            Use 12 or more characters. Passwords are stored as a salted PBKDF2 hash, not readable text.
          </p>
          {error && <p role="alert" className="rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
          <button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save new password'}
          </button>
        </form>
        <button type="button" onClick={logout} className="mt-4 w-full rounded-lg border border-white/10 px-4 py-2 text-xs text-white/60 hover:bg-white/5">
          Sign out instead
        </button>
      </section>
    </main>
  );
}
