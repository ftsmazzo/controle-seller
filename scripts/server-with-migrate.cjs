'use strict';

/**
 * Wrapper do server.js do Next standalone.
 * O EasyPanel costuma forçar o comando `node server.js` e ignora o CMD do Dockerfile.
 * Assim a migration roda sempre no Implantar do app, sem serviço separado.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = __dirname;
const skip = process.env.SKIP_MIGRATIONS === '1';

if (!skip) {
  console.log(JSON.stringify({ event: 'migrate.start', source: 'server-with-migrate' }));
  const result = spawnSync('npm', ['run', 'migrate'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(JSON.stringify({
      event: 'migrate.failed',
      source: 'server-with-migrate',
      status: result.status,
      error: result.error ? String(result.error) : undefined,
    }));
    process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify({ event: 'migrate.done', source: 'server-with-migrate' }));
} else {
  console.log(JSON.stringify({ event: 'migrate.skipped', source: 'server-with-migrate' }));
}

require(path.join(root, 'server.next.js'));
