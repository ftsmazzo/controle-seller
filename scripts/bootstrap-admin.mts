/**
 * Cria/redefine admin via env no EasyPanel (sem terminal/Postgres UI).
 *
 * BOOTSTRAP_ADMIN_EMAIL=
 * BOOTSTRAP_ADMIN_PASSWORD=  (min 12, maiúscula, minúscula e número)
 * BOOTSTRAP_ADMIN_NAME=Administrador
 *
 * Depois do primeiro login, remova essas variáveis.
 */
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
const name = String(process.env.BOOTSTRAP_ADMIN_NAME ?? 'Administrador').trim() || 'Administrador';
const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '');

if (!email || !password) {
  console.info(JSON.stringify({
    event: 'bootstrap.skipped',
    reason: 'BOOTSTRAP_ADMIN_EMAIL ou BOOTSTRAP_ADMIN_PASSWORD ausente',
  }));
  process.exit(0);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(JSON.stringify({ event: 'bootstrap.failed', message: 'BOOTSTRAP_ADMIN_EMAIL inválido' }));
  process.exit(1);
}
if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
  console.error(JSON.stringify({
    event: 'bootstrap.failed',
    message: 'BOOTSTRAP_ADMIN_PASSWORD precisa de 12+ chars, com maiúscula, minúscula e número',
  }));
  process.exit(1);
}

const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'bootstrap.failed', message: 'DATABASE_ADMIN_URL/DATABASE_URL ausente' }));
  process.exit(1);
}

const salt = randomBytes(16);
const derived = await scryptAsync(password, salt, 64);
const passwordHash = `scrypt$v1$${salt.toString('base64')}$${derived.toString('base64')}`;

const pool = new Pool({ connectionString, max: 1, application_name: 'controle-seller-bootstrap' });
try {
  const result = await pool.query<{ email: string }>(
    `INSERT INTO seller.users (email, name, password_hash, must_change_password)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (email) DO UPDATE SET
       name=excluded.name,
       password_hash=excluded.password_hash,
       must_change_password=true,
       disabled_at=NULL,
       updated_at=now()
     RETURNING email`,
    [email, name, passwordHash],
  );
  console.info(JSON.stringify({
    event: 'bootstrap.done',
    email: result.rows[0]?.email,
    message: 'Admin pronto. No primeiro login troque a senha. Remova BOOTSTRAP_ADMIN_* depois.',
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'bootstrap.failed',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
