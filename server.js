import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import Logger from "./lib/logger.js";
import { healthCheck } from "./health.js";

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function getSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.statusText}`);
  }
  const data = await response.json();
  return data.signed_url;
}

// Mapa para rastrear llamadas activas por usuario
const activeUserCalls = new Map();

// Función para procesar la siguiente llamada en cola
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

    // Realizar la llamada
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: lead.phone,
      url: `${
        process.env.PUBLIC_URL
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        "Eres un asistente de ventas inmobiliarias."
      )}&first_message=${encodeURIComponent(
        "Hola, ¿cómo estás?"
      )}&client_name=${encodeURIComponent(
        lead.name
      )}&client_phone=${encodeURIComponent(
        lead.phone
      )}&client_email=${encodeURIComponent(
        lead.email
      )}&client_id=${encodeURIComponent(queueItem.lead_id)}`,
      statusCallback: `${process.env.PUBLIC_URL}/twilio-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });

    // Registrar la llamada
    await supabase.from("calls").insert({
      lead_id: queueItem.lead_id,
      user_id: queueItem.user_id,
      call_sid: call.sid,
      status: "In Progress",
      result: "initiated",
    });

    return true;
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

// Función para procesar la cola de un usuario específico
async function processUserQueue(userId) {
  try {
    // Verificar si el usuario ya tiene una llamada activa
    if (activeUserCalls.get(userId)) {
      return;
    }

    // Obtener la siguiente llamada pendiente para este usuario
    const { data: nextCall } = await supabase
      .from("call_queue")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("queue_position", { ascending: true })
      .limit(1)
      .single();

    if (nextCall) {
      // Actualizar estado a in_progress
      await supabase
        .from("call_queue")
        .update({
          status: "in_progress",
          started_at: new Date().toISOString(),
        })
        .eq("id", nextCall.id);

      // Procesar la llamada
      const success = await processQueueItem(nextCall);

      if (!success) {
        // Si falla, marcar como fallida
        await supabase
          .from("call_queue")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: "Error al procesar la llamada",
          })
          .eq("id", nextCall.id);
      }
    }
  } catch (error) {
    console.error("Error procesando cola de usuario:", error);
  }
}

// Suscribirse a cambios en las llamadas
const callsChannel = supabase
  .channel("server-calls")
  .on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "calls",
      filter: "status=eq.'completed'",
    },
    async (payload) => {
      try {
        // Cuando una llamada se completa, buscar la entrada en la cola
        const { data: queueItem } = await supabase
          .from("call_queue")
          .select("*")
          .eq("status", "in_progress")
          .single();

        if (queueItem) {
          // Liberar al usuario
          activeUserCalls.delete(queueItem.user_id);

          // Marcar como completada
          await supabase
            .from("call_queue")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", queueItem.id);

          // Procesar siguiente llamada en la cola del usuario
          await processUserQueue(queueItem.user_id);
        }
      } catch (error) {
        console.error("Error procesando actualización de llamada:", error);
      }
    }
  )
  .subscribe();

// Suscribirse a cambios en los minutos disponibles
const minutesChannel = supabase
  .channel("server-minutes")
  .on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "users",
      filter: "available_minutes<=0",
    },
    async (payload) => {
      try {
        const userId = payload.new.id;
        // Liberar al usuario
        activeUserCalls.delete(userId);

        // Cancelar todas las llamadas pendientes del usuario
        await supabase
          .from("call_queue")
          .update({
            status: "cancelled",
            completed_at: new Date().toISOString(),
            error_message: "No hay minutos disponibles",
          })
          .eq("user_id", userId)
          .eq("status", "pending");
      } catch (error) {
        console.error("Error cancelando llamadas:", error);
      }
    }
  )
  .subscribe();

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
      await Logger.info("Llamada  finalizada", {
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

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
