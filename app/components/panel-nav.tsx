'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navigation: Array<[string, string]> = [
  ['Visão geral', '/dashboard'],
  ['Pedidos', '/pedidos'],
  ['Produtos', '/produtos'],
  ['Marketing', '/marketing'],
  ['Estoque', '/estoque'],
  ['Recebimentos', '/recebimentos'],
  ['Qualidade', '/qualidade'],
  ['Ações', '/acoes'],
  ['Configurações', '/configuracoes'],
];

export function PanelNav() {
  const pathname = usePathname();
  return (
    <>
      <nav className="nav" aria-label="Navegação principal">
        {navigation.map(([label, href]) => (
          <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot" aria-label="Conta e empresa">
        <Link href="/empresas">Trocar empresa</Link>
        <form action="/api/auth/logout" method="post">
          <button className="quiet-button" type="submit">Sair</button>
        </form>
      </div>
    </>
  );
}
