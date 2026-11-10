/**
 * Wrapper do server.js do Next standalone.
 * 1) migrate
 * 2) bootstrap admin (se BOOTSTRAP_ADMIN_* estiver no EasyPanel)
 * 3) sobe o Next
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function runNode(script, label) {
  console.log(JSON.stringify({ event: `${label}.start`, source: 'server-with-migrate' }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(JSON.stringify({
      event: `${label}.failed_continue`,
      source: 'server-with-migrate',
      status: result.status,
    }));
    return false;
  }
  console.log(JSON.stringify({ event: `${label}.done`, source: 'server-with-migrate' }));
  return true;
}

if (process.env.SKIP_MIGRATIONS !== '1') {
  runNode('scripts/migrate.mts', 'migrate');
} else {
  console.log(JSON.stringify({ event: 'migrate.skipped', source: 'server-with-migrate' }));
}

if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  runNode('scripts/bootstrap-admin.mts', 'bootstrap');
}

const require = createRequire(import.meta.url);
require(path.join(root, 'server.next.js'));
