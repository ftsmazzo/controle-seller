import { calculateOrder, summarize, parseBRL, priceFloor } from './finance.mjs';
import { makeSeed, channels } from './data.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = cents => cents == null ? 'A apurar' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const percent = value => value == null ? 'A apurar' : (value * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const dateLabel = date => date.slice(8, 10) + '/' + date.slice(5, 7);
const moneyInput = cents => cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
const icons = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h3',
  products: 'm3 7 9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7 4l10 5',
  costs: 'M6 3h12v18H6z M9 7h6 M9 11h1 M14 11h1 M9 15h1 M14 15h1 M9 18h1 M14 18h1',
  cash: 'M3 7h18v13H3z M3 7l15-4v4 M16 12h5v5h-5z',
  integrations: 'M8 3v4 M16 3v4 M6 7h12v4a6 6 0 0 1-12 0z M12 17v5',
  roadmap: 'M4 3v18 M4 4h12l-2 4 2 4H4 M17 15h4 M19 13v4',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  revenue: 'M4 17 9 12l4 3 7-10 M14 5h6v6',
  wallet: 'M3 6h16v14H3z M3 6l13-3v3 M14 11h7v5h-7z',
  bag: 'M5 7h14l2 14H3z M8 8V6a4 4 0 0 1 8 0v2',
  shirt: 'm8 3-5 3 3 5 2-1v11h8V10l2 1 3-5-5-3a4 4 0 0 1-8 0'
};
const icon = name => '<svg class="icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (icons[name] || icons.arrow) + '"/></svg>';
const nav = [['overview', 'Visão geral'], ['orders', 'Pedidos'], ['products', 'Produtos e estoque'], ['costs', 'Custos e preço'], ['cash', 'Recebimentos'], ['integrations', 'Integrações'], ['roadmap', 'Plano do produto']];
const headings = {
  overview: ['CLAREZA PARA DECIDIR', 'Seu negócio, por inteiro.', 'Entenda o que vende, o que sobra e onde agir.'],
  orders: ['CADA VENDA CONTA', 'O detalhe faz a margem.', 'Confira receitas, devoluções e custos de cada pedido de exemplo.'],
  products: ['SEU CATÁLOGO, COM CONTEXTO', 'Produtos que sustentam o negócio.', 'Custos por SKU e alertas de estoque para validar a experiência.'],
  costs: ['DECISÃO COM NÚMEROS', 'Preço com margem. Negócio com fôlego.', 'Simule preços e registre despesas nesta demonstração.'],
  cash: ['RESULTADO E CAIXA', 'Vender é o começo. Receber importa.', 'Explore um cenário de repasses separado do resultado das vendas.'],
  integrations: ['UM NEGÓCIO. VÁRIOS CANAIS.', 'As conexões começam aqui.', 'A Uzemy é o piloto. O produto nasce para uma operação multicanal.'],
  roadmap: ['CONSTRUIR COM BASE', 'Da loja piloto à plataforma.', 'O que já funciona, o que vem depois e como validar cada etapa.']
};
const STORAGE = 'controle-seller-demo-v1';
let state;
let storageWarning = '';
try {
  const saved = localStorage.getItem(STORAGE);
  const parsed = saved ? JSON.parse(saved) : null;
  if (parsed) {
    if (parsed.version !== 1 || !Array.isArray(parsed.products) || !Array.isArray(parsed.orders) || !Array.isArray(parsed.expenses)) throw new Error('Base inválida');
    summarize(parsed.orders, parsed.products, parsed.expenses);
  }
  state = parsed || makeSeed();
} catch {
  state = makeSeed();
  storageWarning = 'Não foi possível restaurar a base local. A demonstração foi reiniciada.';
}
let page = 'overview', search = '', statusFilter = 'all';
let toastTimer;
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}
function save() {
  try { localStorage.setItem(STORAGE, JSON.stringify(state)); return true; }
  catch { toast('Alteração nesta sessão. O navegador não permitiu salvar os dados localmente.'); return false; }
}
function filtered() {
  const channel = $('#channel-filter').value;
  const start = $('#date-filter').value;
  const match = row => (channel === 'all' || row.channel === channel) && row.date >= start && row.date <= '2026-11-05';
  return { orders: state.orders.filter(match), expenses: state.expenses.filter(match), channel, start };
}
function metrics() {
  const data = filtered(); return { ...data, ...summarize(data.orders, state.products, data.expenses) };
}
function productArt(product) {
  return '<span class="product-art" style="background:' + escape(product.color) + '">' + icon('shirt') + '</span>';
}
function productCell(product) {
  return '<div class="product-cell">' + productArt(product) + '<div><strong>' + escape(product.name) + '</strong><small>' + escape(product.variant) + '</small></div></div>';
}
function tag(label, type = '') { return '<span class="tag ' + type + '">' + escape(label) + '</span>'; }
function panelHeader(title, subtitle, action = '') {
  return '<div class="panel-header"><div><h2>' + title + '</h2>' + (subtitle ? '<p>' + subtitle + '</p>' : '') + '</div>' + action + '</div>';
}
function kpi(label, amount, note, glyph, classes = '', unknown = false) {
  return '<div class="kpi ' + classes + '"><div class="kpi-top"><span>' + label + '</span><span class="kpi-icon">' + icon(glyph) + '</span></div><div class="metric-number ' + (unknown ? 'muted-number' : '') + '">' + amount + '</div><div class="kpi-foot">' + note + '</div></div>';
}
function chart(m) {
  const days = ['01', '02', '03', '04', '05'].filter(day => '2026-11-' + day >= m.start);
  const values = days.map(day => m.rows.filter(r => r.order.date === '2026-11-' + day).reduce((sum, r) => sum + r.revenue, 0));
  const max = Math.max(...values, 100);
  const width = 540, bottom = 178, top = 20, left = 60, available = 454;
  const step = available / days.length;
  const guides = [0, .5, 1].map(t => {
    const y = bottom - (bottom - top) * t;
    return '<line x1="' + left + '" y1="' + y + '" x2="525" y2="' + y + '" stroke="#ffffff15" stroke-dasharray="3 5"/><text x="6" y="' + (y + 3) + '" fill="#9caa90" font-size="9">' + escape(brl(Math.round(max * t))) + '</text>';
  }).join('');
  const bars = values.map((value, i) => {
    const h = (bottom - top) * value / max;
    const x = left + step * i + step * .24;
    return '<rect x="' + x + '" y="' + (bottom - h) + '" width="' + step * .5 + '" height="' + Math.max(h, 1) + '" rx="5" fill="' + (i === values.length - 1 ? '#d2f298' : '#91ae6d') + '"><title>' + days[i] + '/11: ' + brl(value) + '</title></rect><text x="' + (x + step * .25) + '" y="204" fill="#afbaa4" font-size="10" text-anchor="middle">' + days[i] + ' nov</text>';
  }).join('');
  return '<div class="chart"><svg viewBox="0 0 ' + width + ' 220" role="img" aria-label="Receita líquida de exemplo por dia: ' + escape(values.map((v, i) => days[i] + '/11 ' + brl(v)).join('; ')) + '">' + guides + bars + '</svg></div>';
}
function overview() {
  const m = metrics();
  const low = state.products.filter(p => p.stock < p.minStock);
  const missingProducts = state.products.filter(p => p.costCents == null);
  const variableKnown = m.rows.filter(r => !r.pending && !r.missing.length).reduce((s, r) => s + r.variable, 0);
  const productRows = state.products.slice(0, 4).map(p => '<tr><td>' + productCell(p) + '</td><td>' + brl(p.costCents) + '</td><td class="right">' + (p.stock < p.minStock ? tag(p.stock + ' un. · baixo', 'amber') : tag(p.stock + ' un.')) + '</td></tr>').join('');
  return '<div class="kpi-grid">' +
    kpi('Receita líquida de vendas', brl(m.revenue), 'Após descontos e estornos; inclui frete', 'revenue') +
    kpi('Resultado gerencial', brl(m.result), m.missingCount ? m.missingCount + (m.missingCount === 1 ? ' pedido com custos pendentes' : ' pedidos com custos pendentes') : 'Após custos, anúncios e despesas', 'wallet', 'highlight', m.result == null) +
    kpi('Pedidos realizados', String(m.paidCount).padStart(2, '0'), 'Pagos e devolvidos; sem cancelados', 'bag') +
    kpi('Margem de contribuição', percent(m.margin), 'Antes de anúncios e despesas fixas', 'costs', '', m.margin == null) +
    '</div><div class="grid-main"><section class="panel chart-panel">' +
    panelHeader('O movimento das suas vendas', 'Receita líquida diária · cenário ilustrativo', tag('Receita de exemplo')) +
    '<div class="chart-meta"><div><div class="eyebrow" style="color:#a2b190">NO PERÍODO SELECIONADO</div><div class="chart-number">' + brl(m.revenue) + '</div></div><span class="chart-note">Valores fictícios para validar o produto</span></div>' + chart(m) +
    '</section><section class="panel">' + panelHeader('Seu próximo passo', 'Pequenas ações, mais controle.', tag('Prioridades', 'purple')) +
    '<div class="action-list"><div class="action-row"><span class="action-symbol">!</span><div class="action-content"><strong>' + (missingProducts.length ? 'Um custo precisa de atenção' : 'Custos dos produtos preenchidos') + '</strong><p>' + (missingProducts.length ? 'A Ecobag My está sem custo. A margem permanece a apurar nos pedidos afetados.' : 'Explore agora os pedidos e confira como cada despesa afeta o resultado.') + '</p><a class="arrow-link" href="#products">' + (missingProducts.length ? 'Cadastrar custo' : 'Revisar produtos') + ' →</a></div></div>' +
    '<div class="action-row"><span class="action-symbol green">' + icon('products') + '</span><div class="action-content"><strong>' + low.length + ' SKUs com estoque de exemplo baixo</strong><p>Veja por cor e tamanho quais itens pediriam reposição neste cenário.</p><a class="arrow-link" href="#products">Conferir estoque →</a></div></div>' +
    '<div class="action-row"><span class="action-symbol purple">' + icon('integrations') + '</span><div class="action-content"><strong>Preparar o primeiro canal</strong><p>Nuvemshop é o início. Nuvem Pago é uma hipótese a confirmar com a Uzemy.</p><a class="arrow-link" href="#integrations">Ver preparação →</a></div></div></div></section></div>' +
    '<div class="grid-bottom"><section class="panel">' + panelHeader('Os detalhes do seu catálogo', 'Estoque e custos ilustrativos por variação.', '<a class="button text" href="#products">Ver produtos ↗</a>') +
    '<div class="table-wrap"><table><thead><tr><th>Produto / variação</th><th>Custo unitário</th><th class="right">Estoque fictício</th></tr></thead><tbody>' + productRows + '</tbody></table></div></section>' +
    '<section class="panel">' + panelHeader('O caminho até o resultado', 'Cada desconto tem seu lugar.') +
    '<div class="cost-list"><div class="cost-row"><span>Receita líquida</span><strong>' + brl(m.revenue) + '</strong></div><div class="cost-row"><span>Custos variáveis conhecidos¹</span><strong>− ' + brl(variableKnown) + '</strong></div><div class="cost-row"><span>Publicidade do período</span><strong>− ' + brl(m.adSpend) + '</strong></div><div class="cost-row"><span>Despesas operacionais</span><strong>− ' + brl(m.operating) + '</strong></div><div class="cost-row total"><span>Resultado gerencial</span><strong>' + brl(m.result) + '</strong></div></div><div class="cost-explanation">¹ Custos dos pedidos completos. ' + (m.missingCount ? 'Há pedidos incompletos; por isso o resultado total permanece a apurar.' : 'Todos os custos desta simulação foram preenchidos.') + ' Resultado de vendas e saldo bancário são medidas diferentes.</div></section></div>';
}
const statuses = { paid: ['Pago', ''], pending: ['Pendente', 'amber'], cancelled: ['Cancelado', 'red'], refunded: ['Devolvido', 'purple'] };
function ordersView() {
  return '<div class="section-toolbar"><input class="search" id="order-search" type="search" aria-label="Buscar pedido ou SKU" placeholder="Buscar pedido ou SKU..." value="' + escape(search) + '"><select class="status-select" id="status-filter" aria-label="Filtrar situação">' + [['all', 'Todas as situações'], ...Object.entries(statuses).map(([k, v]) => [k, v[0]])].map(([key, label]) => '<option value="' + key + '"' + (statusFilter === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select><span class="subtle">Clique no pedido para conferir o cálculo.</span></div><section class="panel"><div class="table-wrap full-table"><table><thead><tr><th>Pedido / data</th><th>Canal</th><th>Situação</th><th class="right">Receita líquida</th><th class="right">Contribuição¹</th><th></th></tr></thead><tbody id="order-rows">' + orderRows() + '</tbody></table></div></section><p class="footnote">¹ Receita líquida menos mercadoria, taxas, frete pago, impostos, embalagem e cashback provisionado. Anúncios e despesas operacionais são descontados no total do período. Pedidos pendentes não entram no resultado.</p>';
}
function orderRows() {
  const term = search.toLowerCase();
  const rows = metrics().rows.filter(r => (statusFilter === 'all' || r.order.status === statusFilter) && (r.order.id.toLowerCase().includes(term) || r.order.items.some(l => l.sku.toLowerCase().includes(term)))).sort((a, b) => b.order.date.localeCompare(a.order.date) || b.order.id.localeCompare(a.order.id));
  return rows.length ? rows.map(r => '<tr><td><button class="button text" data-action="order" data-id="' + escape(r.order.id) + '">' + escape(r.order.id) + '</button><div class="subtle">' + dateLabel(r.order.date) + '/2026</div></td><td>' + escape(r.order.channel) + '</td><td>' + tag(...statuses[r.order.status]) + '</td><td class="right">' + (r.pending ? 'Não realizada' : brl(r.revenue)) + '</td><td class="right ' + (r.contribution < 0 ? 'negative' : '') + '">' + (r.pending ? 'Não realizado' : r.missing.length ? tag('Custo pendente', 'amber') : brl(r.contribution)) + '</td><td><button class="button text" data-action="order" data-id="' + escape(r.order.id) + '" aria-label="Detalhes do pedido ' + escape(r.order.id) + '">↗</button></td></tr>').join('') : '<tr><td colspan="6" class="empty">Nenhum pedido corresponde aos filtros.</td></tr>';
}
function productsView() {
  return '<div class="callout amber"><div><strong>Custos preenchidos aqui valem para toda a simulação.</strong><p>No produto em produção, o custo será registrado por vigência e preservado em cada venda. Estoque exibido é fictício e compartilhado nesta demonstração.</p></div></div><section class="panel">' +
    panelHeader('Catálogo de exemplo · Uzemy', 'Nomes e preços de referência da vitrine pública; demais dados fictícios.', tag(state.products.length + ' variações')) +
    '<div class="table-wrap"><table><thead><tr><th>Produto / variação</th><th>SKU de exemplo</th><th>Preço de referência</th><th>Custo de exemplo</th><th>Estoque fictício</th><th></th></tr></thead><tbody>' +
    state.products.map(p => '<tr><td>' + productCell(p) + '</td><td class="muted">' + escape(p.sku) + '</td><td>' + brl(p.priceCents) + '</td><td>' + (p.costCents == null ? tag('Não informado', 'amber') : brl(p.costCents)) + '</td><td><span>' + p.stock + ' unidades</span><div class="stock-track ' + (p.stock < p.minStock ? 'low' : '') + '"><span style="width:' + Math.min(100, p.stock / Math.max(p.minStock * 3, 1) * 100) + '%"></span></div></td><td><button class="button secondary small" data-action="cost" data-sku="' + escape(p.sku) + '">' + (p.costCents == null ? 'Informar custo' : 'Editar custo') + '</button></td></tr>').join('') +
    '</tbody></table></div></section><p class="footnote">A identificação única por SKU permite ligar o mesmo produto às ofertas de diferentes canais. A publicação e a sincronização de estoque entre marketplaces são etapas futuras.</p>';
}
function costsView() {
  const m = metrics();
  return '<div class="grid-main"><section class="panel padded"><div class="eyebrow" style="margin-bottom:9px">SIMULADOR DE PRECIFICAÇÃO</div><h2>Quanto preciso cobrar?</h2><p class="subtle" style="margin-top:7px;margin-bottom:23px">Calcule um preço para cobrir custos e a margem desejada.</p>' +
    '<form id="price-form"><div class="form-grid">' +
    field('Custo do produto (R$)', 'productCost', '28,50') + field('Frete subsidiado (R$)', 'shippingCost', '6,00') +
    field('Embalagem por venda (R$)', 'packagingCost', '1,80') + field('Taxas sobre o preço (%)', 'fees', '16,00') +
    field('Impostos sobre o preço (%)', 'taxes', '4,00') + field('Margem desejada (%)', 'target', '25,00') +
    '</div><button class="button form-submit" type="submit">Calcular preço ' + icon('arrow') + '</button><p id="price-error" class="form-error" role="alert"></p></form><div id="price-result" class="calculator-result"><div class="eyebrow">PREÇO SUGERIDO NO CENÁRIO</div><div class="metric-number">' + brl(priceFloor({ costCents: 2850, shippingCents: 600, packagingCents: 180, feesBps: 1600, taxBps: 400, targetBps: 2500 })) + '</div><p>Simulação. Considere anúncios, devoluções e outros custos aplicáveis ao definir suas taxas.</p></div></section>' +
    '<section class="panel padded"><div class="eyebrow" style="margin-bottom:9px">REGISTRO DE DESPESAS</div><h2>Todo custo tem lugar.</h2><p class="subtle" style="margin-top:7px;margin-bottom:23px">Registre uma despesa fictícia e veja o impacto no período.</p><form id="expense-form"><div class="form-grid">' +
    '<label class="form-field form-wide">Descrição<input name="description" required maxlength="100" placeholder="Ex.: campanha de novembro"></label>' +
    field('Valor (R$)', 'amount', '', '0,00') +
    '<label class="form-field">Categoria<select name="category"><option value="ads">Publicidade</option><option value="operating">Despesa operacional</option></select></label>' +
    '<label class="form-field">Canal<select name="channel">' + channels.map(c => '<option' + (m.channel === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></label>' +
    '<label class="form-field">Data do cenário<input type="date" name="date" min="2026-11-01" max="2026-11-05" value="2026-11-05" required></label>' +
    '</div><button class="button form-submit" type="submit">Adicionar despesa ' + icon('arrow') + '</button><p id="expense-error" class="form-error" role="alert"></p></form><p class="footnote">Alterações são guardadas apenas neste navegador. Nunca insira dados bancários ou credenciais.</p></section></div>' +
    '<section class="panel">' + panelHeader('Despesas do período', 'Somadas uma vez ao resultado gerencial.', tag(brl(m.adSpend + m.operating))) +
    '<div class="table-wrap"><table><thead><tr><th>Descrição</th><th>Canal</th><th>Data</th><th>Categoria</th><th class="right">Valor</th><th></th></tr></thead><tbody>' + (m.expenses.length ? m.expenses.map(e => '<tr><td class="expense-description">' + escape(e.description) + '</td><td>' + escape(e.channel) + '</td><td>' + dateLabel(e.date) + '</td><td>' + tag(e.category === 'ads' ? 'Publicidade' : 'Operacional') + '</td><td class="right">' + brl(e.amountCents) + '</td><td><button class="delete-expense" data-action="delete-expense" data-id="' + escape(e.id) + '" aria-label="Excluir despesa ' + escape(e.description) + '">×</button></td></tr>').join('') : '<tr><td colspan="6" class="empty">Sem despesas no período.</td></tr>') + '</tbody></table></div></section>';
}
function field(label, name, value, placeholder = '') {
  return '<label class="form-field">' + label + '<input name="' + name + '" value="' + value + '" inputmode="decimal" required autocomplete="off" placeholder="' + placeholder + '"></label>';
}
function cashView() {
  const m = metrics();
  const settledBase = m.rows.filter(r => !r.pending && r.order.status !== 'cancelled').reduce((sum, r) => sum + Math.max(0, r.revenue - r.order.feesCents), 0);
  const allocation = [Math.floor(settledBase * .4), Math.floor(settledBase * .35)];
  allocation.push(settledBase - allocation[0] - allocation[1]);
  return '<div class="callout amber"><div><strong>Agenda de recebimentos demonstrativa.</strong><p>A divisão de 40%, 35% e 25% abaixo é arbitrária. Não representa os prazos da Nuvem Pago ou dos marketplaces. O provedor de pagamentos da Uzemy ainda precisa ser confirmado.</p></div></div>' +
    '<div class="grid-main"><section class="panel cash-hero"><div class="eyebrow" style="color:#a5b397">CENÁRIO DE REPASSES</div><h2 style="margin-top:10px">Quando o dinheiro pode entrar.</h2><div class="metric-number">' + brl(settledBase) + '</div><p>Base fictícia: receita líquida menos taxas dos pedidos realizados. Não é saldo disponível nem lucro.</p></section>' +
    '<section class="panel padded"><h2>O que falta para conferir o caixa?</h2><ul class="checklist"><li><span class="check-circle">1</span>Confirmar o meio de pagamento da Uzemy</li><li><span class="check-circle">2</span>Obter o calendário real de liquidação</li><li><span class="check-circle">3</span>Conciliar repasses, retenções e antecipações</li></ul></section></div>' +
    '<div class="cash-grid">' + allocation.map((amount, i) => '<div class="panel"><span class="cash-date">Cenário ' + (i + 1) + ' · ' + ['6 a 12', '13 a 19', '20 a 26'][i] + ' nov</span><div class="cash-value">' + brl(amount) + '</div>' + tag(['40% da base', '35% da base', '25% da base'][i], i ? '' : 'purple') + '<p class="cash-note" style="margin-top:12px">Distribuição de exemplo, sem dados de repasse.</p></div>').join('') + '</div>' +
    '<section class="panel padded" style="margin-top:21px"><h2>Resultado mede a operação. Caixa mede o dinheiro.</h2><p class="subtle" style="margin-top:10px;line-height:1.8">O resultado gerencial considera o que as vendas geraram e os custos envolvidos. A agenda financeira considera datas de recebimento e pagamento. No piloto real, cruzaremos pedidos e extratos de liquidação para explicar as diferenças entre essas duas visões.</p></section>';
}
const integrationDefinitions = [
  ['Nuvemshop', 'N', '#e3eaf7', '#506db0', 'Primeiro canal do piloto', 'Pedidos, produtos e variações. Iniciar com leitura, sem alterar a loja.', 'pilot'],
  ['Nuvem Pago', 'N$', '#e5eef7', '#4f7baf', 'Hipótese a confirmar', 'O meio de pagamento da Uzemy ainda não foi confirmado. Não há taxas ou prazos reais cadastrados.', 'payment'],
  ['Mercado Livre', 'ML', '#fff1a5', '#8e7830', 'Próxima integração', 'Unificar pedidos, comissões e repasses. Validar o vínculo entre anúncios e SKUs.', 'meli'],
  ['Shopee', 'S', '#fbe4da', '#d17a53', 'Próxima integração', 'Ligar pedidos e descontos ao custo real do produto, incluindo taxas por pedido.', 'shopee'],
  ['SHEIN', 'SH', '#e9e8e8', '#424442', 'Acesso a validar', 'Verificar elegibilidade, autorização e dados disponíveis para as contas do piloto.', 'shein']
];
function integrationsView() {
  return '<div class="callout"><div><strong>A loja piloto é Nuvemshop. O modelo do produto é multicanal.</strong><p>Mercado Livre, Shopee e SHEIN foram informados como canais do sócio. Nenhum deles foi conectado nesta versão.</p></div><a class="button secondary small" href="#roadmap">Ver plano</a></div><div class="integration-grid">' +
    integrationDefinitions.map(([name, initials, bg, fg, phase, description, key]) => '<section class="panel integration-card"><div class="integration-head"><div class="integration-logo" style="background:' + bg + ';color:' + fg + '">' + initials + '</div>' + tag('Não conectado', name === 'Nuvemshop' ? 'purple' : '') + '</div><h2>' + name + '</h2><p>' + description + '</p><div class="integration-meta">' + phase + '</div><button class="button secondary small" data-action="setup" data-key="' + key + '">Ver requisitos ' + icon('arrow') + '</button></section>').join('') +
    '<section class="panel integration-card"><div class="integration-head"><div class="integration-logo" style="background:#e7efd9;color:#6e8b46">↔</div>' + tag('Base planejada') + '</div><h2>Um produto, vários canais</h2><p>Cadastro central por SKU e identificação das ofertas por canal. Importação manual poderá apoiar canais sem acesso autorizado à API.</p><div class="integration-meta">Mapeamento de SKUs e dados de origem</div><a class="button secondary small" href="#roadmap">Conhecer a arquitetura ' + icon('arrow') + '</a></section></div>';
}
function roadmapView() {
  return '<div class="callout"><div><strong>Começar com a Uzemy. Validar para muitos vendedores.</strong><p>O primeiro marco é conferir pedidos e margem de uma loja real. A base precisa servir a outras empresas, sem depender de regras exclusivas do piloto.</p></div></div><div class="roadmap-grid">' +
    '<section class="panel phase"><div class="phase-number">01</div>' + tag('Disponível neste protótipo', 'purple') + '<h2>Validar o trabalho do lojista</h2><ul><li>Painel e filtros por canal e período</li><li>Pedidos com memória de cálculo</li><li>Custos por SKU e preço mínimo</li><li>Despesas e exportação de pedidos</li><li>Cenário demonstrativo de recebimentos</li></ul></section>' +
    '<section class="panel phase"><div class="phase-number">02</div>' + tag('Próximo marco') + '<h2>Operar o piloto de verdade</h2><ul><li>Login, empresas e permissões</li><li>PostgreSQL com isolamento entre empresas</li><li>Nuvemshop: autorização e sincronização</li><li>Custos com vigência e histórico preservado</li><li>Conferência com pedidos e extratos reais</li></ul></section>' +
    '<section class="panel phase"><div class="phase-number">03</div>' + tag('Expansão comercial') + '<h2>Atender e crescer</h2><ul><li>Mercado Livre, Shopee e SHEIN por etapas</li><li>Conciliação de repasses e retenções</li><li>Planos e assinaturas recorrentes</li><li>Monitoramento, reprocessamento e suporte</li><li>Estoque unificado e alertas operacionais</li></ul></section></div>' +
    '<section class="panel padded" style="margin-top:21px"><h2>A base técnica proposta para a plataforma</h2><p class="subtle" style="margin-top:8px">Arquitetura de produção planejada. Este painel usa dados locais do navegador.</p><div class="architecture"><div><strong>Canais de venda</strong><small>Nuvemshop · ML · Shopee · SHEIN<br>Adaptadores independentes e autorizados</small></div><div><strong>Fila de sincronização</strong><small>Webhooks, importação histórica, tentativas e deduplicação por evento</small></div><div><strong>Base por empresa</strong><small>PostgreSQL, SKUs, pedidos, custos vigentes, repasses e trilha de auditoria</small></div><div><strong>Gestão e decisões</strong><small>API autenticada, painel, resultado, conciliação e precificação</small></div></div>' +
    '<ul class="checklist"><li><span class="check-circle">✓</span><div><strong>Valores inteiros em centavos e custo ausente explícito.</strong><br><span class="subtle">Implementados e testados no núcleo financeiro deste protótipo.</span></div></li><li><span class="check-circle">○</span><div><strong>Segurança e acesso por empresa.</strong><br><span class="subtle">Exigem backend autenticado e testes de isolamento antes de aceitar dados reais.</span></div></li><li><span class="check-circle">○</span><div><strong>Pronto para cobrar somente após validar os números.</strong><br><span class="subtle">Critério do piloto: reproduzir receitas, descontos, custos, estornos e recebimentos de uma amostra acordada.</span></div></li></ul></section>' +
    '<section class="panel padded" style="margin-top:21px"><h2>Decisões e próximos acessos</h2><ul class="checklist"><li><span class="check-circle">1</span>Confirmar com a Uzemy o meio de pagamento, o custo por variação e as despesas da operação.</li><li><span class="check-circle">2</span>Registrar o aplicativo e autorizar a leitura da loja pelo fluxo oficial da Nuvemshop.</li><li><span class="check-circle">3</span>Definir com o sócio a primeira amostra de pedidos para conferência e o próximo marketplace.</li><li><span class="check-circle">4</span>Validar acesso às APIs de cada marketplace; usar importação controlada quando necessário.</li></ul><div class="source-links"><a href="https://www.uzemy.com.br/" target="_blank" rel="noopener noreferrer">Vitrine pública da Uzemy ↗</a><a href="https://tiendanube.github.io/api-documentation/authentication" target="_blank" rel="noopener noreferrer">Autorização Nuvemshop ↗</a><a href="https://open.sheincorp.com/" target="_blank" rel="noopener noreferrer">Plataforma de desenvolvedores SHEIN ↗</a></div><p class="footnote">Nome Controle Seller é provisório. O schema inicial está no código do projeto como proposta de dados; não existe um banco de produção provisionado.</p></section>' +
    '<div class="section-toolbar" style="margin-top:21px"><p class="subtle">A base de demonstração é salva só neste navegador.</p><button class="button secondary danger small" data-action="reset">Restaurar demonstração</button></div>';
}
const views = { overview, orders: ordersView, products: productsView, costs: costsView, cash: cashView, integrations: integrationsView, roadmap: roadmapView };
function render() {
  const key = location.hash.slice(1);
  page = views[key] ? key : 'overview';
  $('#navigation').innerHTML = nav.map(([id, label]) => '<a href="#' + id + '" class="' + (page === id ? 'active' : '') + '"' + (page === id ? ' aria-current="page"' : '') + '>' + icon(id) + '<span>' + label + '</span>' + (id === 'integrations' ? '<span class="nav-dot">5</span>' : '') + '</a>').join('');
  const [eyebrow, title, subtitle] = headings[page];
  $('#page-eyebrow').textContent = eyebrow; $('#page-title').textContent = title; $('#page-subtitle').textContent = subtitle;
  document.title = title + ' · Controle Seller';
  try { $('#view').innerHTML = views[page](); }
  catch { $('#view').innerHTML = '<div class="error-banner">A base local contém um valor inválido. Abra Plano do produto e restaure a demonstração para continuar.</div>'; }
  bindForms();
}
function openDialog(html) {
  const dialog = $('#detail-dialog');
  $('#dialog-content').innerHTML = html;
  const title = $('#dialog-content h2');
  if (title) { title.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', 'dialog-title'); }
  dialog.showModal();
}
function dialogHead(title, subtitle = '') {
  return '<div class="dialog-head"><div><h2>' + title + '</h2>' + (subtitle ? '<p class="subtle" style="margin-top:5px">' + subtitle + '</p>' : '') + '</div><button class="icon-button" data-action="close" aria-label="Fechar diálogo">×</button></div>';
}
function orderDialog(id) {
  const order = state.orders.find(o => o.id === id);
  if (!order) return;
  const r = calculateOrder(order, state.products);
  const row = (label, value) => '<div class="dialog-row"><span>' + label + '</span><strong>' + value + '</strong></div>';
  openDialog(dialogHead(escape(order.id), escape(order.channel) + ' · ' + dateLabel(order.date) + '/2026 · dados fictícios') +
    '<div class="dialog-product">' + order.items.map(l => escape(state.products.find(p => p.sku === l.sku)?.name || l.sku) + ' · ' + l.quantity + ' un.').join('<br>') + '</div>' +
    row('Situação', tag(...statuses[order.status])) +
    row('Produtos antes dos descontos', brl(r.gross)) + row('Descontos', '− ' + brl(order.discountCents)) +
    row('Frete cobrado do cliente', '+ ' + brl(order.shippingRevenueCents)) + row('Estornos', '− ' + brl(order.refundCents)) +
    row('Receita realizada' + (order.status === 'cancelled' ? ' · cancelado' : ''), brl(r.revenue)) +
    row('Mercadoria consumida', r.cogs == null ? 'Não informada' : '− ' + brl(r.cogs)) +
    [['Taxas', 'feesCents'], ['Frete pago', 'shippingCostCents'], ['Impostos', 'taxCents'], ['Embalagem', 'packagingCents'], ['Cashback provisionado', 'cashbackCents']].map(([label, key]) => row(label, order[key] == null ? 'Não informado' : '− ' + brl(order[key]))).join('') +
    '<div class="dialog-row total"><span>Contribuição antes de anúncios</span><span>' + (r.pending ? 'Não realizada' : brl(r.contribution)) + '</span></div>' +
    '<div class="dialog-note">' + (r.pending ? 'Este pedido está pendente e não entra no resultado realizado.' : r.missing.length ? 'Informações pendentes: ' + escape(r.missing.join(', ')) + '. Nenhum custo ausente é tratado como zero.' : 'Anúncios e despesas operacionais são considerados no total do período, sem rateio artificial por pedido.') + '</div>');
}
function costDialog(sku) {
  const p = state.products.find(p => p.sku === sku);
  if (!p) return;
  openDialog(dialogHead('Custo por variação', escape(p.name) + ' · ' + escape(p.variant)) +
    '<form id="cost-form" data-sku="' + escape(sku) + '">' + field('Custo unitário de exemplo (R$)', 'cost', moneyInput(p.costCents), 'Ex.: 18,50') +
    '<p class="dialog-note">O valor será aplicado a todos os pedidos desta simulação. Na produção, cada venda terá o custo histórico preservado.</p><p id="cost-error" class="form-error" role="alert"></p><button class="button form-submit" type="submit">Salvar custo de exemplo</button></form>');
  $('#cost-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      p.costCents = parseBRL(new FormData(event.target).get('cost'));
      const persisted = save(); $('#detail-dialog').close(); render();
      if (persisted) toast('Custo de exemplo salvo. As margens foram recalculadas.');
    } catch (error) { $('#cost-error').textContent = error.message; }
  });
}
function setupDialog(key) {
  const integration = integrationDefinitions.find(i => i[6] === key);
  const name = integration?.[0] || 'Integração';
  const content = {
    pilot: '<p>O primeiro conector vai ler pedidos, produtos e variações da Nuvemshop. Esta versão ainda não executa a autorização.</p><ul class="checklist"><li>1. Registrar o aplicativo e configurar o endereço de retorno no portal de parceiros.</li><li>2. Solicitar somente as permissões de leitura necessárias.</li><li>3. O administrador da Uzemy autoriza a instalação pelo fluxo oficial.</li><li>4. O backend guarda o token com segurança e sincroniza uma amostra de pedidos.</li><li>5. Conferir dados, custos e devoluções com a operação antes de expandir.</li></ul><p><a href="https://tiendanube.github.io/api-documentation/authentication" target="_blank" rel="noopener noreferrer">Consultar a documentação oficial ↗</a></p>',
    payment: '<p>Nuvem Pago foi sugerido como hipótese de trabalho. Precisamos confirmar com o sócio qual serviço a loja usa e quais regras de taxa, parcelamento e liquidação se aplicam.</p><p>As taxas e os prazos exibidos na demonstração são fictícios e não foram obtidos da Nuvem Pago.</p>',
    meli: '<p>Planejar autorização da conta, leitura dos pedidos, identificação das comissões e conferência com os repasses. Os anúncios devem ser ligados ao SKU central antes de consolidar estoque.</p><p>O acesso real e os dados disponíveis serão validados na conta do piloto. Não há conexão ativa.</p>',
    shopee: '<p>Validar cadastro do aplicativo, permissões e autorização da loja. Identificar descontos do vendedor, comissões e custos adicionais em cada pedido.</p><p>O acesso real e os dados disponíveis serão validados na conta do piloto. Não há conexão ativa.</p>',
    shein: '<p>A integração depende de cadastro, análise do aplicativo e autorização no portal da SHEIN. A disponibilidade dos dados para as contas do piloto precisa ser confirmada.</p><p><a href="https://open.sheincorp.com/" target="_blank" rel="noopener noreferrer">Consultar o portal oficial ↗</a></p>'
  };
  openDialog(dialogHead(name, 'Preparação da integração · não conectado') + '<div class="setup-copy">' + (content[key] || '') + '</div><div class="dialog-note">Nenhuma senha ou token deve ser digitado neste protótipo. A autorização real será feita pelo fluxo oficial de cada plataforma.</div>');
}
function bindForms() {
  $('#order-search')?.addEventListener('input', e => { search = e.target.value; $('#order-rows').innerHTML = orderRows(); });
  $('#status-filter')?.addEventListener('change', e => { statusFilter = e.target.value; $('#order-rows').innerHTML = orderRows(); });
  $('#price-form')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const f = new FormData(event.target);
      const amount = priceFloor({ costCents: parseBRL(f.get('productCost')), shippingCents: parseBRL(f.get('shippingCost')), packagingCents: parseBRL(f.get('packagingCost')), feesBps: parseBRL(f.get('fees')), taxBps: parseBRL(f.get('taxes')), targetBps: parseBRL(f.get('target')) });
      $('#price-result .metric-number').textContent = brl(amount);
      $('#price-error').textContent = '';
    } catch (error) { $('#price-error').textContent = error.message; $('#price-result .metric-number').textContent = 'Revise os valores'; }
  });
  $('#expense-form')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const f = new FormData(event.target);
      const amountCents = parseBRL(f.get('amount'));
      const description = String(f.get('description')).trim();
      if (!description) throw new Error('Informe uma descrição.');
      if (!amountCents) throw new Error('A despesa precisa ser maior que zero.');
      state.expenses.push({ id: crypto.randomUUID(), description, amountCents, date: f.get('date'), category: f.get('category'), channel: f.get('channel') });
      const persisted = save(); render();
      if (persisted) toast('Despesa de exemplo registrada neste navegador.');
    } catch (error) { $('#expense-error').textContent = error.message; }
  });
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function exportOrders() {
  const rows = metrics().rows;
  const headings = ['pedido', 'data', 'canal', 'situacao', 'receita_liquida_brl', 'contribuicao_antes_anuncios_brl', 'custos_pendentes', 'origem'];
  const values = rows.map(r => [r.order.id, r.order.date, r.order.channel, statuses[r.order.status][0], moneyInput(r.revenue), r.contribution == null ? '' : moneyInput(r.contribution), r.missing.join(' | '), 'DEMONSTRACAO_FICTICIA']);
  const content = '\uFEFF' + [headings, ...values].map(row => row.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'controle-seller-pedidos-DEMONSTRACAO.csv';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(rows.length + ' pedidos de demonstração exportados.');
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, sku, key } = button.dataset;
  if (action === 'close') $('#detail-dialog').close();
  if (action === 'order') orderDialog(id);
  if (action === 'cost') costDialog(sku);
  if (action === 'setup') setupDialog(key);
  if (action === 'delete-expense') {
    state.expenses = state.expenses.filter(e => e.id !== id);
    const persisted = save(); render();
    if (persisted) toast('Despesa de exemplo excluída.');
  }
  if (action === 'reset') {
    openDialog(dialogHead('Restaurar a demonstração?') + '<p class="subtle">Os custos e as despesas alterados neste navegador serão substituídos pela base fictícia inicial.</p><div style="display:flex;gap:10px;margin-top:22px"><button class="button" data-action="confirm-reset">Restaurar dados de exemplo</button><button class="button secondary" data-action="close">Cancelar</button></div>');
  }
  if (action === 'confirm-reset') { state = makeSeed(); const persisted = save(); $('#detail-dialog').close(); render(); if (persisted) toast('Base de demonstração restaurada.'); }
});
$('#channel-filter').addEventListener('change', render);
$('#date-filter').addEventListener('change', render);
$('#export-button').addEventListener('click', exportOrders);
$('#menu-toggle').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open'); $('#menu-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', event => {
  if (window.innerWidth <= 650 && $('#sidebar').classList.contains('open') && !event.target.closest('#sidebar,#menu-toggle')) {
    $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
});
window.addEventListener('hashchange', () => {
  $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false');
  render(); $('#content').focus({ preventScroll: true }); window.scrollTo(0, 0);
});
render();
if (storageWarning) toast(storageWarning);
