import { databasePool, emailSchema, hashPassword, passwordSchema } from '../src/server/core.mjs';

const [emailInput, nameInput, passwordInput] = process.argv.slice(2);
const email = emailSchema.parse(emailInput);
const name = String(nameInput ?? '').trim();
if (name.length < 2) throw new Error('Informe o nome: npm run user:create -- email nome senha-temporaria');
const password = passwordSchema.parse(passwordInput);
const passwordHash = await hashPassword(password);
await databasePool().query(
  `INSERT INTO seller.users (email, name, password_hash, must_change_password)
   VALUES ($1,$2,$3,true)
   ON CONFLICT (email) DO UPDATE SET name=excluded.name, password_hash=excluded.password_hash,
     must_change_password=true, disabled_at=NULL, updated_at=now()`,
  [email, name, passwordHash],
);
console.info(`Usuário ${email} criado; a troca de senha será exigida no primeiro acesso.`);
await databasePool().end();
