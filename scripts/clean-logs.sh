#!/bin/bash

# Script para limpiar logs antiguos
echo "Iniciando limpieza de logs..."

# Ejecutar la función de limpieza en la base de datos
psql $DATABASE_URL -c "SELECT clean_old_logs();"

echo "Limpieza de logs completada." 