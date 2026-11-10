'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

type Kind = 'login' | 'password';

export function AuthForm({
  kind,
  initialError = '',
}: {
  kind: Kind;
  initialError?: string;
}) {
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  // Login: POST nativo do browser (cookie + redirect confiáveis no EasyPanel).
  // Troca de senha: continua via fetch para validar confirmação no cliente.
  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      const form = event.currentTarget;
      const data = new FormData(form);
      if (data.get('password') !== data.get('passwordConfirmation')) {
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
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location') || '/';
        window.location.assign(location.startsWith('/') ? location : '/');
        return;
      }
      if (response.type === 'opaqueredirect' || response.status === 0) {
        window.location.assign('/');
        return;
      }
      const payload = await response.json().catch(() => ({
        error: `Falha no acesso (${response.status}).`,
      })) as { error?: string };
      setError(typeof payload.error === 'string' ? payload.error : `Falha no acesso (${response.status}).`);
    } catch (err) {
      setError(err instanceof Error ? `Falha de conexão: ${err.message}` : 'Falha de conexão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const login = kind === 'login';
  return (
    <form
      className="card form-card"
      method="post"
      action={login ? '/api/auth/login' : '/api/auth/password'}
      aria-busy={loading}
      onSubmit={login ? undefined : submitPassword}
    >
      <span className="eyebrow">{login ? 'Acesso seguro' : 'Primeiro acesso'}</span>
      <h2>{login ? 'Entre na sua conta' : 'Crie sua senha'}</h2>
      <p className="muted">{login
        ? 'Use o e-mail cadastrado pelo administrador.'
        : 'Use 12 ou mais caracteres, com maiúscula, minúscula e número.'}</p>
      {error && (
        <p id="auth-error" className="error" ref={alertRef} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {login && (
        <label className="field">
          E-mail
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            disabled={loading}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'auth-error' : undefined}
          />
        </label>
      )}
      <label className="field">
        {login ? 'Senha' : 'Nova senha'}
        <input
          type="password"
          name="password"
          autoComplete={login ? 'current-password' : 'new-password'}
          minLength={login ? undefined : 12}
          required
          disabled={loading}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'auth-error' : undefined}
        />
      </label>
      {!login && (
        <label className="field">
          Confirme a nova senha
          <input
            type="password"
            name="passwordConfirmation"
            autoComplete="new-password"
            minLength={12}
            required
            disabled={loading}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'auth-error' : undefined}
          />
        </label>
      )}
      <span role="status" aria-live="polite">{loading ? 'Enviando…' : ''}</span>
      <button className="button" type="submit" disabled={loading} aria-busy={loading}>
        {loading ? 'Aguarde…' : login ? 'Continuar' : 'Salvar e continuar'}
      </button>
    </form>
  );
}
