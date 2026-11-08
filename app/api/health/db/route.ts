import { NextResponse } from 'next/server';
import { databasePool } from '@/src/server/core.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await databasePool().query('SELECT 1');
    return NextResponse.json({ status: 'ok', service: 'database' });
  } catch {
    return NextResponse.json({ status: 'error', service: 'database' }, { status: 503 });
  }
}
