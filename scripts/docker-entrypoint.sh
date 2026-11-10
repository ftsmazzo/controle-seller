#!/bin/sh
set -eu

# No EasyPanel o Implantar do app usa esta imagem.
# Migrations rodam aqui automaticamente; o worker sobrescreve o comando
# com `npm run worker` e não passa por este script.
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "{\"event\":\"migrate.start\",\"source\":\"app-entrypoint\"}"
  npm run migrate
  echo "{\"event\":\"migrate.done\",\"source\":\"app-entrypoint\"}"
fi

exec node server.js
