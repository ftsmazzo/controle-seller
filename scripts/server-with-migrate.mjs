/**
 * Wrapper do server.js do Next standalone.
 * package.json tem "type": "module", então este entrypoint precisa ser ESM.
 * O EasyPanel força `node server.js` — tenta migrate e SEMPRE sobe o app.
 * A role controle_seller_app não tem DDL; sem DATABASE_ADMIN_URL o migrate
 * pode falhar e isso não pode derrubar o login.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const skip = process.env.SKIP_MIGRATIONS === '1';

if (!skip) {
  console.log(JSON.stringify({ event: 'migrate.start', source: 'server-with-migrate' }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.mts'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(JSON.stringify({
      event: 'migrate.failed_continue',
      source: 'server-with-migrate',
      status: result.status,
      message: 'Migrate falhou; app sobe mesmo assim. Sem DATABASE_ADMIN_URL a role da app não aplica DDL.',
    }));
  } else {
    console.log(JSON.stringify({ event: 'migrate.done', source: 'server-with-migrate' }));
  }
} else {
  console.log(JSON.stringify({ event: 'migrate.skipped', source: 'server-with-migrate' }));
}

const require = createRequire(import.meta.url);
require(path.join(root, 'server.next.js'));
