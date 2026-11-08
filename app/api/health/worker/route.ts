import { NextResponse } from 'next/server';
import { databasePool } from '@/src/server/core.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const result = await databasePool().query<{ healthy: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM seller.worker_heartbeats
       WHERE heartbeat_at > now() - interval '60 seconds') healthy`,
    );
    const healthy = result.rows[0]?.healthy === true;
    return NextResponse.json(
      { status: healthy ? 'ok' : 'stale' },
      { status: healthy ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ status: 'error' }, { status: 503 });
  }
}
