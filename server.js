import Logger from "./logger.js";
import { healthCheck } from "./health.js";

// ... existing code ...

// Add logging to processQueueItem function
async function processQueueItem(queueItem) {
  try {
    // Verificar si el usuario ya tiene una llamada activa
    if (activeUserCalls.get(queueItem.user_id)) {
      await Logger.warning("Usuario ya tiene una llamada activa", {
        userId: queueItem.user_id,
        source: "queue_system",
        metadata: { queueItemId: queueItem.id },
      });
      return false;
    }

    // Verificar minutos disponibles
    const { data: user } = await supabase
      .from("users")
      .select("available_minutes")
      .eq("id", queueItem.user_id)
      .single();

    if (!user || user.available_minutes <= 0) {
      await Logger.warning("No hay minutos disponibles", {
        userId: queueItem.user_id,
        source: "queue_system",
        metadata: { availableMinutes: user?.available_minutes || 0 },
      });

      // Cancelar llamadas pendientes si no hay minutos
      await supabase
        .from("call_queue")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: "No hay minutos disponibles",
        })
        .eq("user_id", queueItem.user_id)
        .eq("status", "pending");
      return false;
    }

    // Obtener información del lead
    const { data: lead } = await supabase
      .from("leads")
      .select("name, phone, email")
      .eq("id", queueItem.lead_id)
      .single();

    if (!lead) {
      await Logger.error("Lead no encontrado", {
        userId: queueItem.user_id,
        source: "queue_system",
        metadata: { leadId: queueItem.lead_id },
      });
      throw new Error("Lead no encontrado");
    }

    // Marcar al usuario como con llamada activa
    activeUserCalls.set(queueItem.user_id, true);

    await Logger.info("Iniciando llamada", {
      userId: queueItem.user_id,
      source: "call_system",
      leadId: queueItem.lead_id,
      metadata: { lead },
    });

    // ... rest of the existing code ...
  } catch (error) {
    await Logger.error("Error procesando llamada", {
      userId: queueItem.user_id,
      source: "queue_system",
      metadata: {
        error: error.message,
        queueItemId: queueItem.id,
        leadId: queueItem.lead_id,
      },
    });
    console.error("Error procesando llamada:", error);
    activeUserCalls.delete(queueItem.user_id);
    return false;
  }
}

// Add logging to twilio-status endpoint
fastify.post("/twilio-status", async (request, reply) => {
  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;

  try {
    const { data: callRecord } = await supabase
      .from("calls")
      .select("user_id, lead_id")
      .eq("call_sid", callSid)
      .single();

    if (callRecord?.user_id) {
      await Logger.info("Llamada finalizada", {
        userId: callRecord.user_id,
        source: "call_system",
        callSid,
        leadId: callRecord.lead_id,
        metadata: {
          duration: callDuration,
          status: callStatus,
        },
      });

      // Liberar al usuario
      activeUserCalls.delete(callRecord.user_id);

      // Resta minutos disponibles
      await supabase.rpc("decrement_minutes", {
        uid: callRecord.user_id,
        mins: callDuration,
      });
    }

    await supabase
      .from("calls")
      .update({
        duration: callDuration,
        status: callStatus,
      })
      .eq("call_sid", callSid);

    reply.code(200).send("OK");
  } catch (error) {
    await Logger.error("Error actualizando estado de llamada", {
      callSid,
      source: "call_system",
      metadata: {
        error: error.message,
        duration: callDuration,
        status: callStatus,
      },
    });
    console.error("Error updating call duration or minutes:", error);
    reply.code(500).send("Error");
  }
});

// Endpoint de salud
fastify.get("/health", async (request, reply) => {
  const health = await healthCheck();

  if (health.status === "error") {
    reply.code(500).send(health);
  } else {
    reply.send(health);
  }
});

// ... rest of the existing code ...
