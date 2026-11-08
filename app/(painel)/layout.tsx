import Link from 'next/link';
import { PanelNav } from '@/app/components/panel-nav';
import { requireReadySession } from '@/src/server/session.mjs';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireReadySession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="logo" href="/dashboard" aria-label="Controle Seller — visão geral">
          <span>controle</span><b>seller</b>
        </Link>
        <p className="tenant-note">Lucro real · canais · ads</p>
        <PanelNav />
      </aside>
      <main className="content" id="conteudo-principal">
        <header className="top">
          <div>
            <span className="eyebrow">Painel operacional</span>
            <h1>{session.name.split(' ')[0]}, o que escala e o que drena margem?</h1>
          </div>
          <span className="pill">Empresa ativa</span>
        </header>
        {children}
      </main>
    </div>
  );
}
