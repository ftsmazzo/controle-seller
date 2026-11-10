import { redirect } from 'next/navigation';
import { AuthForm } from '@/app/components/auth-form';
import { readSession } from '@/src/server/session.mjs';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await readSession()) redirect('/');
  const query = await searchParams;
  const raw = query.error;
  const initialError = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;

  return (
    <main className="auth">
      <section className="brand">
        <span className="eyebrow">Controle Seller</span>
        <h1>Margem<br />sem névoa.</h1>
        <p>Uma base confiável para operar vendas, custos e decisões.</p>
      </section>
      <section className="form-wrap">
        <AuthForm kind="login" {...(initialError ? { initialError } : {})} />
      </section>
    </main>
  );
}
