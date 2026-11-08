import { redirect } from 'next/navigation';
import { readSession } from '@/src/server/session.mjs';
export default async function Home() {
  const session = await readSession();
  redirect(session ? (session.mustChangePassword ? '/trocar-senha' : session.activeTenantId ? '/dashboard' : '/empresas') : '/login');
}
