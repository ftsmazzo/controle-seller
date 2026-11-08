import { listTenants, requireSession } from '@/src/server/session.mjs';
export default async function CompaniesPage() {
  const session = await requireSession();
  const tenants = await listTenants(session.userId);
  return <main className="form-wrap" style={{minHeight:'100vh'}}>
    <section className="card" style={{width:'min(720px,100%)'}}>
      <span className="eyebrow">Espaço de trabalho</span><h2>Escolha sua empresa</h2>
      <p className="muted">Cada empresa mantém dados, acessos e integrações isolados.</p>
      <div className="stack">
        {tenants.map(tenant => <form className="company" action="/api/tenants" method="post" key={tenant.id}>
          <input type="hidden" name="tenantId" value={tenant.id}/><div><strong>{tenant.name}</strong><br/><span className="pill">{tenant.role}</span></div>
          <button className="button secondary">Abrir</button>
        </form>)}
        {!tenants.length && <div className="empty">Você ainda não participa de nenhuma empresa.</div>}
      </div>
      <form action="/api/tenants" method="post" style={{marginTop:'2rem'}}>
        <label className="field">Criar nova empresa<input name="name" minLength={2} maxLength={120} placeholder="Nome da empresa" required/></label>
        <button className="button">Criar empresa</button>
      </form>
    </section>
  </main>;
}
