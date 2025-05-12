import { supabase } from "./supabaseClient.js";

export async function healthCheck() {
  try {
    // Verificar conexión con Supabase
    const { data: supabaseHealth, error: supabaseError } = await supabase
      .from("health_check")
      .select("count")
      .single();

    if (supabaseError) {
      return {
        status: "error",
        supabase: "error",
        message: "Error connecting to Supabase",
        error: supabaseError.message,
      };
    }

    // Verificar estado de la cola
    const { data: queueStats, error: queueError } = await supabase
      .from("call_queue")
      .select("status", { count: "exact" })
      .in("status", ["pending", "in_progress"]);

    if (queueError) {
      return {
        status: "error",
        queue: "error",
        message: "Error checking queue status",
        error: queueError.message,
      };
    }

    // Verificar memoria y CPU
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      supabase: "connected",
      queue: {
        active_calls: queueStats?.length || 0,
        status: "operational",
      },
      system: {
        memory: {
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + "MB",
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + "MB",
          external: Math.round(memoryUsage.external / 1024 / 1024) + "MB",
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system,
        },
      },
    };
  } catch (error) {
    return {
      status: "error",
      message: "Health check failed",
      error: error.message,
    };
  }
}
