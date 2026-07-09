#!/usr/bin/env bash
# Levanta (o reusa) un Postgres local en Docker para desarrollo, en el puerto
# 5433 con volumen persistente. La app se conecta vía DATABASE_URL (ver run-dev.sh).
# No usar en producción: la clave es de desarrollo.
set -e

NAME="encuestum-db"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker start "$NAME" >/dev/null
  echo "Contenedor '$NAME' ya existe: iniciado."
else
  docker run -d --name "$NAME" \
    -e POSTGRES_USER=encuestum \
    -e POSTGRES_PASSWORD=encuestum_dev \
    -e POSTGRES_DB=encuestum \
    -p 5433:5432 \
    -v encuestum_pgdata:/var/lib/postgresql/data \
    postgres:16-alpine >/dev/null
  echo "Contenedor '$NAME' creado."
fi

echo "DATABASE_URL=postgresql://encuestum:encuestum_dev@localhost:5433/encuestum"
