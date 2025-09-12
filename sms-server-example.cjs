// Ejemplo de servidor para el sistema de SMS
// Basado en el patrón de whatsapp-server-example.cjs

const Fastify = require("fastify");
const { handleSMSMessage } = require("./sms-handler.cjs");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Configuración de Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const fastify = Fastify({
  logger: true,
});

// Registrar plugin para parsear form data
fastify.register(require("@fastify/formbody"));

// Middleware para logging de requests
fastify.addHook("onRequest", (request, reply, done) => {
  if (request.url === "/webhook/sms") {
    console.log("🔧 [MIDDLEWARE] Request recibido en SMS webhook");
    console.log(
      "🔧 [MIDDLEWARE] Content-Type:",
      request.headers["content-type"]
    );
  }
  done();
});

// Ruta principal del webhook de SMS
fastify.post("/webhook/sms", async (request, reply) => {
  console.log("🚀 [SERVER] Webhook SMS recibido");
  return await handleSMSMessage(supabase, request, reply);
});

// Endpoint para obtener estadísticas
fastify.get("/api/sms/stats", async (request, reply) => {
  try {
    const { data: stats, error } = await supabase.rpc("get_sms_stats");

    if (error) {
      console.error("❌ [API] Error obteniendo estadísticas:", error);
      return reply.code(500).send({
        success: false,
        message: "Error obteniendo estadísticas",
        error: error.message,
      });
    }

    return reply.send({
      success: true,
      stats: stats[0] || {
        total_conversations: 0,
        active_conversations: 0,
        total_messages: 0,
        messages_24h: 0,
        messages_7d: 0,
        avg_messages_per_conversation: 0,
      },
    });
  } catch (error) {
    console.error("❌ [API] Error en endpoint de estadísticas:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});

// Endpoint para cerrar conversación
fastify.post("/api/sms/conversations/:id/close", async (request, reply) => {
  try {
    const { id } = request.params;

    const { error } = await supabase
      .from("sms_conversations")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      console.error("❌ [API] Error cerrando conversación:", error);
      return reply.code(500).send({
        success: false,
        message: "Error cerrando conversación",
        error: error.message,
      });
    }

    console.log("🔒 [API] Conversación cerrada:", id);
    return reply.send({
      success: true,
      message: "Conversación cerrada exitosamente",
    });
  } catch (error) {
    console.error("❌ [API] Error en endpoint de cerrar conversación:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});

// Endpoint para obtener historial de conversación
fastify.get("/api/sms/conversations/:id/history", async (request, reply) => {
  try {
    const { id } = request.params;

    const { data: messages, error } = await supabase
      .from("sms_messages")
      .select("*")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("❌ [API] Error obteniendo historial:", error);
      return reply.code(500).send({
        success: false,
        message: "Error obteniendo historial",
        error: error.message,
      });
    }

    return reply.send({
      success: true,
      conversation_id: id,
      messages: messages || [],
      total_messages: messages ? messages.length : 0,
    });
  } catch (error) {
    console.error("❌ [API] Error en endpoint de historial:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});

// Endpoint para obtener métricas de engagement
fastify.get("/api/sms/engagement", async (request, reply) => {
  try {
    const { userId } = request.query;

    const { data: metrics, error } = await supabase.rpc(
      "get_sms_engagement_metrics",
      { user_id_param: userId || null }
    );

    if (error) {
      console.error("❌ [API] Error obteniendo métricas:", error);
      return reply.code(500).send({
        success: false,
        message: "Error obteniendo métricas",
        error: error.message,
      });
    }

    return reply.send({
      success: true,
      metrics: metrics[0] || {
        total_users: 0,
        active_users_24h: 0,
        active_users_7d: 0,
        avg_response_time_minutes: 0,
        total_ai_responses: 0,
        avg_messages_per_user: 0,
      },
    });
  } catch (error) {
    console.error("❌ [API] Error en endpoint de métricas:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});

// Endpoint para limpiar conversaciones antiguas
fastify.post("/api/sms/cleanup", async (request, reply) => {
  try {
    const { days = 30 } = request.body;

    const { data: deletedCount, error } = await supabase.rpc(
      "cleanup_old_sms_conversations",
      { days_to_keep: days }
    );

    if (error) {
      console.error("❌ [API] Error en limpieza:", error);
      return reply.code(500).send({
        success: false,
        message: "Error ejecutando limpieza",
        error: error.message,
      });
    }

    console.log(
      "🧹 [API] Limpieza completada:",
      deletedCount,
      "conversaciones eliminadas"
    );
    return reply.send({
      success: true,
      message: "Limpieza completada",
      deleted_count: deletedCount,
    });
  } catch (error) {
    console.error("❌ [API] Error en endpoint de limpieza:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
});

// Endpoint de health check
fastify.get("/health", async (request, reply) => {
  return reply.send({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "sms-server",
    version: "1.0.0",
  });
});

// Función para iniciar el servidor
async function start() {
  try {
    const port = process.env.PORT || 8000;
    const host = process.env.HOST || "0.0.0.0";

    await fastify.listen({ port, host });

    console.log("🚀 [SERVER] Servidor SMS iniciado exitosamente");
    console.log(`📡 [SERVER] Escuchando en http://${host}:${port}`);
    console.log("📱 [SERVER] Webhook SMS: POST /webhook/sms");
    console.log("📊 [SERVER] Estadísticas: GET /api/sms/stats");
    console.log(
      "🔒 [SERVER] Cerrar conversación: POST /api/sms/conversations/:id/close"
    );
    console.log(
      "📜 [SERVER] Historial: GET /api/sms/conversations/:id/history"
    );
    console.log("📈 [SERVER] Métricas: GET /api/sms/engagement");
    console.log("🧹 [SERVER] Limpieza: POST /api/sms/cleanup");
    console.log("❤️ [SERVER] Health check: GET /health");
  } catch (err) {
    console.error("❌ [SERVER] Error iniciando servidor:", err);
    process.exit(1);
  }
}

// Manejo de señales para shutdown graceful
process.on("SIGINT", async () => {
  console.log("🛑 [SERVER] Recibida señal SIGINT, cerrando servidor...");
  try {
    await fastify.close();
    console.log("✅ [SERVER] Servidor cerrado exitosamente");
    process.exit(0);
  } catch (err) {
    console.error("❌ [SERVER] Error cerrando servidor:", err);
    process.exit(1);
  }
});

process.on("SIGTERM", async () => {
  console.log("🛑 [SERVER] Recibida señal SIGTERM, cerrando servidor...");
  try {
    await fastify.close();
    console.log("✅ [SERVER] Servidor cerrado exitosamente");
    process.exit(0);
  } catch (err) {
    console.error("❌ [SERVER] Error cerrando servidor:", err);
    process.exit(1);
  }
});

// Iniciar el servidor
start();
