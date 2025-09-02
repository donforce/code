// Ejemplo de integración de WhatsApp en el servidor
const fastify = require("fastify");
const {
  handleWhatsAppMessage,
  getWhatsAppStats,
} = require("./whatsapp-handler.cjs");

const server = fastify({
  logger: true,
});

// Middleware para parsear body de Twilio
server.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  function (req, body, done) {
    try {
      const parsed = new URLSearchParams(body);
      const result = {};
      for (const [key, value] of parsed) {
        result[key] = value;
      }
      done(null, result);
    } catch (err) {
      err.statusCode = 400;
      done(err, null);
    }
  }
);

// Ruta para webhook de WhatsApp de Twilio
server.post("/webhook/whatsapp", async (request, reply) => {
  try {
    console.log("📱 [SERVER] Webhook de WhatsApp recibido");

    // Verificar que sea de Twilio (opcional pero recomendado)
    const twilioSignature = request.headers["x-twilio-signature"];
    const twilioUrl = request.protocol + "://" + request.hostname + request.url;

    // Aquí podrías verificar la firma de Twilio si tienes el webhook secret

    // Procesar el mensaje
    const result = await handleWhatsAppMessage(request, reply);

    // Twilio espera una respuesta TwiML o un status 200
    reply.header("Content-Type", "text/xml");
    return reply.send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <!-- La respuesta se envía de forma asíncrona -->
      </Response>
    `);
  } catch (error) {
    console.error("❌ [SERVER] Error en webhook de WhatsApp:", error);
    reply.status(500).send({ error: "Error interno del servidor" });
  }
});

// Ruta para obtener estadísticas de WhatsApp
server.get("/api/whatsapp/stats", async (request, reply) => {
  try {
    const stats = await getWhatsAppStats(request, reply);
    return stats;
  } catch (error) {
    console.error("❌ [SERVER] Error obteniendo estadísticas:", error);
    reply.status(500).send({ error: "Error obteniendo estadísticas" });
  }
});

// Ruta para cerrar conversación
server.post(
  "/api/whatsapp/conversations/:conversationId/close",
  async (request, reply) => {
    try {
      const { conversationId } = request.params;
      const result = await closeConversation(request, reply);
      return result;
    } catch (error) {
      console.error("❌ [SERVER] Error cerrando conversación:", error);
      reply.status(500).send({ error: "Error cerrando conversación" });
    }
  }
);

// Ruta para obtener historial de conversación
server.get(
  "/api/whatsapp/conversations/:conversationId/history",
  async (request, reply) => {
    try {
      const { conversationId } = request.params;
      const result = await getConversationHistory(request, reply);
      return result;
    } catch (error) {
      console.error("❌ [SERVER] Error obteniendo historial:", error);
      reply.status(500).send({ error: "Error obteniendo historial" });
    }
  }
);

// Ruta de health check
server.get("/health", async (request, reply) => {
  return { status: "OK", timestamp: new Date().toISOString() };
});

// Iniciar servidor
const start = async () => {
  try {
    await server.listen({ port: process.env.PORT || 3000, host: "0.0.0.0" });
    console.log(
      "🚀 [SERVER] Servidor iniciado en puerto",
      server.server.address().port
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

// Manejo de señales para cierre graceful
process.on("SIGINT", () => {
  console.log("🛑 [SERVER] Cerrando servidor...");
  server.close(() => {
    console.log("✅ [SERVER] Servidor cerrado");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("🛑 [SERVER] Cerrando servidor...");
  server.close(() => {
    console.log("✅ [SERVER] Servidor cerrado");
    process.exit(0);
  });
});
