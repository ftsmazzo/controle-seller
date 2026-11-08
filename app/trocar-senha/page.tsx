import { redirect } from 'next/navigation';
import { AuthForm } from '@/app/components/auth-form';
import { requireSession } from '@/src/server/session.mjs';
export default async function ChangePasswordPage() {
  const session = await requireSession();
  if (!session.mustChangePassword) redirect('/empresas');
  return <main className="form-wrap" style={{minHeight:'100vh'}}>
    <AuthForm kind="password" />
  </main>;
}
