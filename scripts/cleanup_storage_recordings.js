#!/usr/bin/env node

/**
 * Script para limpiar grabaciones físicas en Supabase Storage y actualizar la base de datos
 * Elimina archivos de grabaciones con más de 7 días (1 semana) y limpia los campos recording_storage_url y recording_storage_path
 * Ejecutar como cron job diario (ej: a la 1am)
 */

import { createClient } from "@supabase/supabase-js";

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucketName = process.env.SUPABASE_STORAGE_BUCKET || "recordings"; // Cambia si tu bucket tiene otro nombre

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "❌ Error: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function cleanupStorageRecordings() {
  try {
    console.log(
      "🧹 [Storage Cleanup] Iniciando limpieza de grabaciones físicas en Storage..."
    );

    // 1. Buscar grabaciones viejas (más de 7 días) con archivo en Storage
    const { data: calls, error } = await supabase
      .from("calls")
      .select("id, recording_storage_url, recording_storage_path, created_at")
      .not("recording_storage_url", "is", null)
      .not("recording_storage_path", "is", null)
      .lt(
        "created_at",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      );

    if (error) {
      console.error("❌ [Storage Cleanup] Error obteniendo llamadas:", error);
      process.exit(1);
    }

    if (!calls || calls.length === 0) {
      console.log(
        "✅ [Storage Cleanup] No hay grabaciones viejas para limpiar."
      );
      return;
    }

    for (const call of calls) {
      if (call.recording_storage_path) {
        // 2. Eliminar archivo de Storage
        const { error: storageError } = await supabase.storage
          .from(bucketName)
          .remove([call.recording_storage_path]);
        if (storageError) {
          console.error(
            `❌ [Storage Cleanup] Error eliminando archivo para llamada ${call.id}:`,
            storageError
          );
          continue;
        } else {
          console.log(
            `🗑️ [Storage Cleanup] Archivo eliminado para llamada ${call.id}`
          );
        }
      }

      // 3. Limpiar solo los campos recording_storage_url y recording_storage_path
      const { error: updateError } = await supabase
        .from("calls")
        .update({
          recording_storage_url: null,
          recording_storage_path: null,
        })
        .eq("id", call.id);

      if (updateError) {
        console.error(
          `❌ [Storage Cleanup] Error actualizando llamada ${call.id}:`,
          updateError
        );
      } else {
        console.log(
          `✅ [Storage Cleanup] Campos limpiados para llamada ${call.id}`
        );
      }
    }

    console.log(
      "✅ [Storage Cleanup] Limpieza de grabaciones físicas completada."
    );
  } catch (err) {
    console.error("❌ [Storage Cleanup] Error inesperado:", err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupStorageRecordings();
}
