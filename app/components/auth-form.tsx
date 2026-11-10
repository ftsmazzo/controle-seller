'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

type Kind = 'login' | 'password';

export function AuthForm({ kind }: { kind: Kind }) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      const form = event.currentTarget;
      const data = new FormData(form);
      if (kind === 'password' && data.get('password') !== data.get('passwordConfirmation')) {
        setError('As senhas não coincidem.');
        return;
      }
      setLoading(true);
      const body = new URLSearchParams();
      for (const [key, value] of data) {
        if (typeof value === 'string') body.append(key, value);
      }
      const response = await fetch(form.action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });

      // 303/302 com Set-Cookie: navegamos manualmente para aplicar a sessão.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location') || (kind === 'login' ? '/empresas' : '/');
        window.location.assign(location);
        return;
      }
      if (response.type === 'opaqueredirect' || response.status === 0) {
        window.location.assign(kind === 'login' ? '/empresas' : '/');
        return;
      }
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }

      const payload = await response.json().catch(() => ({
        error: response.ok
          ? 'Não foi possível concluir a solicitação.'
          : `Falha no acesso (${response.status}).`,
      })) as {
        error?: string | { formErrors?: string[] };
      };
      const message = typeof payload.error === 'string'
        ? payload.error
        : payload.error?.formErrors?.[0];
      setError(message ?? `Falha no acesso (${response.status}).`);
    } catch {
      setError('Falha de conexão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const login = kind === 'login';
  return <form className="card form-card" method="post" aria-busy={loading}
    action={login ? '/api/auth/login' : '/api/auth/password'} onSubmit={submit}>
    <span className="eyebrow">{login ? 'Acesso seguro' : 'Primeiro acesso'}</span>
    <h2>{login ? 'Entre na sua conta' : 'Crie sua senha'}</h2>
    <p className="muted">{login
      ? 'Use o e-mail cadastrado pelo administrador.'
      : 'Use 12 ou mais caracteres, com maiúscula, minúscula e número.'}</p>
    {error && <p id="auth-error" className="error" ref={alertRef} role="alert" tabIndex={-1}>{error}</p>}
    {login && <label className="field">E-mail
      <input type="email" name="email" autoComplete="email" required disabled={loading}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-error' : undefined} />
    </label>}
    <label className="field">{login ? 'Senha' : 'Nova senha'}
      <input type="password" name="password" autoComplete={login ? 'current-password' : 'new-password'}
        minLength={login ? undefined : 12} required disabled={loading}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-error' : undefined} />
    </label>
    {!login && <label className="field">Confirme a nova senha
      <input type="password" name="passwordConfirmation" autoComplete="new-password"
        minLength={12} required disabled={loading}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'auth-error' : undefined} />
    </label>}
    <span role="status" aria-live="polite">{loading ? 'Enviando…' : ''}</span>
    <button className="button" type="submit" disabled={loading} aria-busy={loading}>
      {loading ? 'Aguarde…' : login ? 'Continuar' : 'Salvar e continuar'}
    </button>
  </form>;
}
