#!/usr/bin/env node

/**
 * Script para configurar la limpieza automática de grabaciones
 *
 * Este script puede ser ejecutado por un cron job externo (ej: GitHub Actions, cron job del servidor)
 * para limpiar automáticamente las grabaciones antiguas cada hora.
 */

const { createClient } = require("@supabase/supabase-js");

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "❌ Error: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runCleanup() {
  try {
    console.log(
      "🧹 [Cleanup Script] Iniciando limpieza automática de grabaciones..."
    );

    // Ejecutar la función de limpieza en Supabase
    const { data, error } = await supabase.rpc("cleanup_old_recordings");

    if (error) {
      console.error("❌ [Cleanup Script] Error ejecutando limpieza:", error);
      process.exit(1);
    }

    // Obtener estadísticas después de la limpieza
    const { data: stats, error: statsError } = await supabase.rpc(
      "get_recording_stats"
    );

    if (statsError) {
      console.error(
        "❌ [Cleanup Script] Error obteniendo estadísticas:",
        statsError
      );
    } else {
      console.log("📊 [Cleanup Script] Estadísticas actuales:", stats);
    }

    console.log(
      "✅ [Cleanup Script] Limpieza automática completada exitosamente"
    );

    // Log del evento
    await supabase.from("logs").insert({
      level: "info",
      message: "Limpieza automática de grabaciones ejecutada",
      source: "cleanup_script",
      metadata: {
        script: "setup_recording_cleanup.js",
        timestamp: new Date().toISOString(),
        statistics: stats,
      },
    });
  } catch (error) {
    console.error("❌ [Cleanup Script] Error inesperado:", error);

    // Log del error
    try {
      await supabase.from("logs").insert({
        level: "error",
        message: "Error en limpieza automática de grabaciones",
        source: "cleanup_script",
        metadata: {
          script: "setup_recording_cleanup.js",
          error: error.message,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (logError) {
      console.error("❌ [Cleanup Script] Error logging error:", logError);
    }

    process.exit(1);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  runCleanup();
}

module.exports = { runCleanup };
