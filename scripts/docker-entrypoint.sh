#!/bin/sh
set -eu

# Preferencial: node server.js já é o wrapper ESM com migrate.
# Este script permanece para quem apontar o comando do EasyPanel para ele.
exec node server.js
