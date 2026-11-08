import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listPlatformAppStatuses, PLATFORM_PROVIDERS, upsertPlatformApp,
} from '@/src/integrations/platform-apps.mjs';
import {
  audit, ForbiddenError, guardMutation, inTransaction, readLimitedFormData,
} from '@/src/server/core.mjs';
import { publicUrl } from '@/src/server/http.mjs';
import { readSession } from '@/src/server/session.mjs';

const formSchema = z.object({
  provider: z.enum(PLATFORM_PROVIDERS),
  appId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(8).max(500),
  userAgent: z.string().trim().max(200).optional(),
  loginConfigId: z.string().trim().max(200).optional(),
  includeBusinessManagement: z.enum(['true', 'false']).optional(),
  scopes: z.string().trim().max(300).optional(),
  partnerId: z.string().trim().max(200).optional(),
  region: z.string().trim().max(10).optional(),
});

export async function GET() {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  return NextResponse.json({ data: await listPlatformAppStatuses() });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session?.activeTenantId || session.mustChangePassword) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  try { guardMutation(request, `platform-apps:${session.userId}`, 20); }
  catch { return NextResponse.json({ error: 'Solicitação inválida.' }, { status: 403 }); }

  try {
    const form = await readLimitedFormData(request);
    const parsed = formSchema.parse({
      provider: form.get('provider'),
      appId: form.get('appId'),
      clientSecret: form.get('clientSecret'),
      userAgent: form.get('userAgent') || undefined,
      loginConfigId: form.get('loginConfigId') || undefined,
      includeBusinessManagement: form.get('includeBusinessManagement') === 'on' ? 'true' : 'false',
      scopes: form.get('scopes') || undefined,
      partnerId: form.get('partnerId') || undefined,
      region: form.get('region') || undefined,
    });

    const settings: Record<string, unknown> = {};
    if (parsed.provider === 'nuvemshop') {
      if (!parsed.userAgent) throw new Error('Informe o User-Agent exigido pela Nuvemshop.');
      settings.userAgent = parsed.userAgent;
    }
    if (parsed.provider === 'meta') {
      if (!parsed.loginConfigId) throw new Error('Informe o Login Config ID do Meta.');
      settings.loginConfigId = parsed.loginConfigId;
      settings.includeBusinessManagement = parsed.includeBusinessManagement === 'true';
    }
    if (parsed.provider === 'shopify') {
      settings.scopes = parsed.scopes || 'read_products,read_orders';
    }
    if (parsed.provider === 'shopee') {
      if (!parsed.partnerId) throw new Error('Informe o Partner ID da Shopee.');
      settings.partnerId = parsed.partnerId;
      settings.region = parsed.region || 'BR';
    }

    await inTransaction(async client => {
      const membership = await client.query<{ role: string }>(
        `SELECT role FROM seller.memberships WHERE tenant_id=$1 AND user_id=$2`,
        [session.activeTenantId, session.userId],
      );
      if (membership.rows[0]?.role !== 'owner') {
        throw new ForbiddenError('Somente o owner pode configurar aplicativos da plataforma.');
      }
      await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`, [
        session.activeTenantId, session.userId,
      ]);
      await upsertPlatformApp({
        provider: parsed.provider,
        appId: parsed.appId,
        clientSecret: parsed.clientSecret,
        settings,
      }, session.userId, client);
      await audit(client, {
        tenantId: session.activeTenantId!, userId: session.userId, role: 'owner',
      }, 'platform_app.upserted', 'platform_oauth_app', parsed.provider, { provider: parsed.provider });
    });

    return NextResponse.redirect(publicUrl('/configuracoes?apps=saved', request), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao salvar aplicativo.';
    return NextResponse.redirect(
      publicUrl(`/configuracoes?apps=error&message=${encodeURIComponent(message)}`, request),
      303,
    );
  }
}
