# Controle Seller — mesa de controle do negócio

Monólito modular em Next.js 16, React 19, TypeScript e PostgreSQL. Ajuda pequenos vendedores a entender o que vende, quanto sobra, onde perdem margem e qual decisão merece atenção. Inclui autenticação, multiempresa, RBAC, isolamento RLS, fila PostgreSQL, auditoria e conectores Nuvemshop e Meta Ads.

O motor financeiro existente permanece em `src/finance.mts`. O protótipo anterior continua acessível por `npm run legacy:preview`, mas não participa do build principal.

## Requisitos e início local

- Node.js 22+
- PostgreSQL 15+

```bash
cp .env.example .env
npm install
npm run migrate
npm run user:create -- admin@empresa.com "Nome do admin" "SenhaTemporaria123"
npm run dev
```

No primeiro login, a senha temporária precisa ser substituída. Depois, crie ou selecione uma empresa. Não use credenciais de produção em ambientes locais.

## Processos

- `npm run app`: aplicação compilada (porta 3000).
- `npm run worker`: worker independente baseado em `pg-boss`.
- `npm run migrate`: aplica migrações com checksum e configura `APP_DATABASE_ROLE`, quando informada.
- `npm run user:create -- <email> <nome> <senha>`: cria/redefine um usuário com troca obrigatória.
- `npm run typecheck`, `npm test`, `npm run build`: gates locais.

Use `DATABASE_ADMIN_URL` apenas no processo de migração. A aplicação usa
`DATABASE_URL` da role `APP_DATABASE_ROLE`; o worker usa
`WORKER_DATABASE_URL` da role separada `WORKER_DATABASE_ROLE`. Ambas são
criadas como `NOSUPERUSER NOBYPASSRLS`, mas somente a role do worker executa
seletores globais de jobs. A role de migração precisa de privilégios para
extensões, DDL e criação/alteração de roles.

## Segurança e tenancy

Sessões são tokens aleatórios, armazenados no cookie `HttpOnly`, `SameSite=Lax` e persistidos somente como SHA-256. Senhas usam scrypt com salt. Credenciais OAuth usam AES-256-GCM; `CREDENTIAL_KEYS` mantém o chaveiro JSON versionado e `ACTIVE_CREDENTIAL_KEY_VERSION` escolhe a chave usada nas novas cifras.

Todas as consultas de negócio usam uma transação que define `app.tenant_id` e `app.user_id` com `set_config(..., true)`, valida a membership e só então executa a operação. As tabelas de tenant têm RLS habilitada e forçada. Eventos financeiros, custos e auditoria rejeitam `UPDATE` e `DELETE`.

Rotação de chave: adicione a nova versão ao JSON, troque a versão ativa e regrave cada credencial por um job controlado; mantenha a chave antiga até concluir e verificar a rotação.

## Saúde e operação

- `GET /api/health/app`: processo HTTP vivo.
- `GET /api/health/db`: conexão de banco pronta.
- `GET /api/health/worker`: ao menos um heartbeat nos últimos 60 segundos.

No Docker/EasyPanel, o `server.js` da imagem do app é um wrapper que roda
`npm run migrate` e só então inicia o Next (`server.next.js`). Assim o
**Implantar do app** aplica DDL mesmo quando o EasyPanel força
`node server.js`. O worker usa `npm run worker` e cria as filas
`forecast.*` se ainda não existirem. Informe `DATABASE_ADMIN_URL` (ou
`DATABASE_URL` com DDL) nas variáveis do app. Emergência: `SKIP_MIGRATIONS=1`.
Faça backup do PostgreSQL antes de deploys com DDL.

As migrations são cumulativas e têm checksum: nunca edite uma já aplicada; crie uma nova. Logs não devem conter cookies, senhas, payloads OAuth ou chaves.

## Estrutura

- `app/`: páginas e rotas HTTP.
- `src/server/`: autenticação, criptografia, RBAC, transações e auditoria.
- `src/predictive/`: ensemble de previsão (sazonal + ridge + stacking).
- `src/integrations/`: contratos neutros de comércio e Ads.
- `src/worker.mts`: consumidor e heartbeat.
- `migrations/`: schema PostgreSQL e políticas.
- `database/`: proposta legada mantida apenas como referência.

## Produto decisório

O shell operacional oferece Visão geral, Previsões, Pedidos, Produtos/SKUs, Marketing,
Estoque, Recebimentos, Qualidade dos dados, Ações, Integrações e Configurações.
As consultas são executadas no servidor dentro do contexto RLS do tenant e
aceitam período, canal, status e busca. O ambiente não contém seeds de negócio:
quando uma fonte ou campo está ausente, a interface mostra estado vazio ou valor
não calculável.

A contribuição só é total quando todos os pedidos do período têm custo vigente.
Taxas, frete pago, impostos, embalagem e cashback não são presumidos. Custos
manuais são versões append-only com vigência; uma correção é uma nova versão,
preservando a memória histórica. O simulador de preço roda apenas no navegador e
não altera o catálogo.

O motor `src/decision-product.mts` gera recomendações determinísticas para
margem negativa, custo ausente, estoque crítico, campanha consumindo margem,
sincronização atrasada, token revogado e divergência. A persistência armazena
regra, evidências, período, cobertura, confiança e ação sugerida. Nenhuma ação é
automática.

Marketing separa ROAS declarado pela plataforma da receita e margem associadas a
pedidos reais com evidência. O modelo `evidence-last-touch-v1`, janela de 28 dias,
é observacional e não prova causalidade ou incrementalidade. Exports CSV incluem
proteção contra formula injection.

### Dashboard preditiva (`/previsoes`)

Módulo de ensemble learning para receita diária da loja (horizontes 30/60/90),
usando série de pedidos pagos + spend de Meta Ads (`ad_insight_facts`). Combina
média móvel sazonal, ridge de vendas e ridge sensível a ads via stacking
ponderado pelo erro de validação. A UI mostra previsto vs realizado, faixa
P10–P90, breakdown por canal, drivers e what-if de investimento diário em ads.

APIs: `GET/POST /api/forecast`, `POST /api/forecast/what-if`. Persistência em
`seller.daily_store_metrics`, `forecast_runs`, `forecast_points` e
`forecast_evals` (migração `008_predictive_dashboard.sql`). O worker processa a
fila `forecast.compute` semanalmente e sob demanda.

### Aplicar o marco

```bash
npm run migrate
npm test
npm run typecheck
npm run build
```

A migration `004_decision_product.sql` é incremental; não altere migrations já
aplicadas.

## Nuvemshop

Configure `APP_PUBLIC_URL`, `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_SECRET` e
`NUVEMSHOP_USER_AGENT` antes de conectar. O aplicativo deve declarar os scopes
`read_products,read_orders` e apontar o callback para
`/api/integrations/nuvemshop/callback`. O endpoint público de eventos é
`/api/webhooks/nuvemshop`.

O conector usa a API `2025-03`, cifra o token com o chaveiro de credenciais,
faz backfill e reconciliação com overlap de 10 minutos e processa webhooks por
inbox idempotente. Produtos, variantes e pedidos mantêm payload bruto, hash e
datas de origem. O worker precisa estar ativo para consumir `nuvemshop.sync`.

## Meta Ads

Configure `META_APP_ID`, `META_APP_SECRET` e `META_LOGIN_CONFIG_ID`. No painel
Meta, cadastre exatamente
`$APP_PUBLIC_URL/api/integrations/meta/callback`, associe uma configuração de
Facebook Login for Business e conceda `ads_read`. Deixe
`META_INCLUDE_BUSINESS_MANAGEMENT=false`; `business_management` não é solicitado
pelo conector e só deve ser habilitado em uma configuração aprovada que
realmente o exija.

O conector usa Graph/Marketing API `v27.0`, inclui `appsecret_proof` em cada
requisição autenticada, cifra tokens, importa apenas contas retornadas por
`/me/adaccounts` e reconcilia campanhas, conjuntos, anúncios e insights diários.
O job diário reabre 28 dias (hoje mais 27 dias anteriores) para absorver
correções da Meta. O backfill inicial cobre 90 dias. Valores monetários são
gravados em centavos, com moeda e fuso da conta.

`actions` e `action_values` permanecem conversões declaradas da plataforma,
separadas de pedidos. A UI agrupa dinheiro por moeda e mostra ROAS declarado apenas no nível campanha para
não somar os mesmos fatos entre campanha, conjunto e anúncio. Receita e margem
atribuídas usam somente pedidos reais pagos e evidência explícita capturada no
pedido (`utm_*`, `fbclid`/`fbc` ou identificadores externos). O modelo
`evidence-last-touch-v1` e sua janela de 28 dias são versionados. Essas métricas
são observacionais e não demonstram causalidade ou incrementalidade.

O worker consome `meta.sync`, registra `sync_runs`, tenta novamente com backoff
e envia falhas esgotadas para `meta.dead-letter` e `seller.dead_letters`.
Nunca registre URLs, headers ou corpos OAuth: eles podem conter token,
`appsecret_proof`, código ou segredo do aplicativo.

## Limites deste marco

Não há cobrança de assinatura, recuperação de senha por e-mail, interface de
convite/edição de membros nem conciliação bancária sem conector de pagamentos.
Os testes dos conectores usam fixtures/mocks e não fazem chamadas reais; OAuth,
RLS, migration e filas ainda devem ser validados em PostgreSQL e apps sandbox
reais no pipeline de integração.
