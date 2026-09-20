import { useId, useState, type FormEvent } from 'react';
import { loginWithPassword, type SessionState } from './api';

export function LoginForm(props: { onAuthenticated: (session: SessionState) => Promise<void> | void }) {
  const loginId = useId();
  const passwordId = useId();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setRateLimited(false);
    try {
      const session = await loginWithPassword(login, password);
      setPassword('');
      await props.onAuthenticated(session);
    } catch (err) {
      const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status: number }).status) : 0;
      if (status === 429) {
        setRateLimited(true);
        setError('Too many login attempts. Try again later.');
      } else {
        setError('Invalid credentials.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="boot login-screen" aria-labelledby="login-title" data-testid="login-screen">
      <h1 id="login-title">Atlas</h1>
      <p className="muted">Sign in with your operator-provisioned credential.</p>
      <form className="login-form" onSubmit={(event) => void onSubmit(event)} data-testid="login-form">
        <label htmlFor={loginId}>Login</label>
        <input
          id={loginId}
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          required
          data-testid="login-username"
        />
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          data-testid="login-password"
        />
        <button type="submit" className="primary" disabled={busy || !login.trim() || !password} data-testid="login-submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? (
          <p role="alert" className={rateLimited ? 'login-rate' : 'login-error'}>
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
