// 🚀 Optimized server for Railway deployment - Performance enhanced
// Server configuration and setup
import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import os from "os";
import { performance } from "perf_hooks";
import crypto from "crypto";

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RAILWAY_PUBLIC_DOMAIN,
  // Multi-threading configuration
  MAX_CONCURRENT_CALLS,
  MAX_CALLS_PER_USER,
  WORKER_POOL_SIZE,
  QUEUE_CHECK_INTERVAL,
  RETRY_ATTEMPTS,
  RETRY_DELAY,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !ELEVENLABS_WEBHOOK_SECRET ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !RAILWAY_PUBLIC_DOMAIN
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Optimized Supabase client with connection pooling
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Optimized Fastify configuration
const fastify = Fastify({
  logger: false,
  rawBody: true,
  // Performance optimizations
  connectionTimeout: 30000,
  keepAliveTimeout: 30000,
  maxRequestsPerSocket: 100,
  // Disable request logging for better performance
  disableRequestLogging: true,
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Optimized metrics tracking - reduced frequency
let startTime = performance.now();
let totalCalls = 0;
let activeCalls = 0;
let failedCalls = 0;
let lastMetricsCheck = Date.now();

// Optimized queue configuration
const QUEUE_CONFIG = {
  maxConcurrentCalls: parseInt(MAX_CONCURRENT_CALLS) || 5,
  maxCallsPerUser: parseInt(MAX_CALLS_PER_USER) || 1,
  workerPoolSize: parseInt(WORKER_POOL_SIZE) || 3,
  queueCheckInterval: parseInt(QUEUE_CHECK_INTERVAL) || 15000, // Reduced to 15 seconds
  retryAttempts: parseInt(RETRY_ATTEMPTS) || 2, // Reduced retry attempts
  retryDelay: parseInt(RETRY_DELAY) || 3000, // Reduced retry delay
};

// Optimized tracking with WeakMap for better memory management
const globalActiveCalls = new Map();
const userActiveCalls = new Map();
const workerPool = new Set();

console.log("[Queue] Optimized configuration:", QUEUE_CONFIG);

// Optimized signature verification - reduced logging
function verifyElevenLabsSignature(rawBody, signature) {
  try {
    let timestamp = null;
    let actualSignature = null;

    if (signature.includes("t=") && signature.includes("v0=")) {
      const tMatch = signature.match(/t=(\d+)/);
      if (tMatch) timestamp = tMatch[1];

      const v0Match = signature.match(/v0=([a-f0-9]+)/);
      if (v0Match) actualSignature = v0Match[1];
    } else {
      return false;
    }

    if (!timestamp || !actualSignature) {
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
      .createHmac("sha256", ELEVENLABS_WEBHOOK_SECRET)
      .update(signedPayload, "utf8")
      .digest("hex");

    return expectedSignature === actualSignature;
  } catch (error) {
    console.error("[WEBHOOK] Error verifying signature:", error);
    return false;
  }
}

// Optimized queue subscription with reduced logging
const queueChannel = supabase
  .channel("server-queue")
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "call_queue",
    },
    async (payload) => {
      try {
        if (
          payload.eventType === "INSERT" &&
          payload.new.status === "pending"
        ) {
          // Immediate processing instead of setTimeout
          processAllPendingQueues();
        }
      } catch (error) {
        console.error("Error processing queue event:", error);
      }
    }
  )
  .subscribe();

// Optimized queue processing with reduced database queries
async function processAllPendingQueues() {
  try {
    // Check if we can process more calls
    if (globalActiveCalls.size >= QUEUE_CONFIG.maxConcurrentCalls) {
      return;
    }

    // Get all pending queue items with optimized query
    const { data: pendingQueues, error } = await supabase
      .from("call_queue")
      .select(
        `
        id,
        user_id,
        lead_id,
        queue_position,
        status,
        created_at,
        lead:leads (
          name,
          phone,
          email
        )
      `
      )
      .eq("status", "pending")
      .order("queue_position", { ascending: true })
      .limit(QUEUE_CONFIG.maxConcurrentCalls * 2);

    if (error) {
      console.error("[Queue] Error fetching pending queues:", error);
      return;
    }

    if (!pendingQueues || pendingQueues.length === 0) {
      return;
    }

    // Get user data in single query for all users
    const userIds = [...new Set(pendingQueues.map((item) => item.user_id))];
    const { data: usersData, error: usersError } = await supabase
      .from("users")
      .select(
        "id, available_minutes, email, first_name, last_name, assistant_name"
      )
      .in("id", userIds);

    if (usersError) {
      console.error("[Queue] Error fetching users data:", usersError);
      return;
    }

    // Create optimized user lookup map
    const usersMap = new Map(usersData?.map((user) => [user.id, user]) || []);

    // Filter eligible items efficiently
    const eligibleItems = [];
    const processedUsers = new Set();

    for (const item of pendingQueues) {
      const user = usersMap.get(item.user_id);

      if (!user || user.available_minutes <= 0) continue;
      if (userActiveCalls.has(item.user_id)) continue;
      if (processedUsers.has(item.user_id)) continue;

      eligibleItems.push(item);
      processedUsers.add(item.user_id);
    }

    if (eligibleItems.length === 0) return;

    // Process items concurrently with optimized batch size
    const itemsToProcess = eligibleItems.slice(
      0,
      QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size
    );

    // Process items concurrently without waiting for all to complete
    itemsToProcess.forEach(async (item) => {
      processQueueItemWithRetry(item).catch((error) => {
        console.error(`[Queue] Error processing item ${item.id}:`, error);
      });
    });
  } catch (error) {
    console.error("[Queue] Error in queue processing:", error);
  }
}

// Optimized queue item processing with reduced logging
async function processQueueItemWithRetry(queueItem, attempt = 1) {
  const workerId = `worker_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  try {
    // Add to worker pool
    workerPool.add(workerId);

    // Check if we can still process this item
    if (globalActiveCalls.size >= QUEUE_CONFIG.maxConcurrentCalls) {
      return false;
    }

    if (userActiveCalls.has(queueItem.user_id)) {
      return false;
    }

    // Update queue status to in_progress
    const { error: updateError } = await supabase
      .from("call_queue")
      .update({
        status: "in_progress",
        started_at: new Date().toISOString(),
      })
      .eq("id", queueItem.id);

    if (updateError) {
      console.error(
        `[Queue] Worker ${workerId} - Error updating queue status:`,
        updateError
      );
      throw updateError;
    }

    // Process the call
    const success = await processQueueItem(queueItem, workerId);

    if (!success) {
      // Retry logic with reduced attempts
      if (attempt < QUEUE_CONFIG.retryAttempts) {
        // Wait before retry
        await new Promise((resolve) =>
          setTimeout(resolve, QUEUE_CONFIG.retryDelay)
        );

        // Reset queue status to pending for retry
        await supabase
          .from("call_queue")
          .update({
            status: "pending",
            started_at: null,
          })
          .eq("id", queueItem.id);

        // Retry the call
        return processQueueItemWithRetry(queueItem, attempt + 1);
      } else {
        // Max retries reached, mark as failed
        await supabase
          .from("call_queue")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: `Failed after ${QUEUE_CONFIG.retryAttempts} attempts`,
          })
          .eq("id", queueItem.id);
      }
    }

    return success;
  } catch (error) {
    console.error(
      `[Queue] Worker ${workerId} - Error processing queue item:`,
      error
    );

    // Mark as failed on error
    try {
      await supabase
        .from("call_queue")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error.message,
        })
        .eq("id", queueItem.id);
    } catch (updateError) {
      console.error(
        `[Queue] Worker ${workerId} - Error updating failed status:`,
        updateError
      );
    }

    return false;
  } finally {
    // Remove from worker pool
    workerPool.delete(workerId);
  }
}

// Optimized queue processing interval - more frequent checks
const QUEUE_INTERVAL = QUEUE_CONFIG.queueCheckInterval;
console.log(
  `[Queue] Setting up optimized queue processing interval: ${QUEUE_INTERVAL}ms`
);

const queueInterval = setInterval(processAllPendingQueues, QUEUE_INTERVAL);

// Clean up interval on shutdown
process.on("SIGTERM", () => clearInterval(queueInterval));
process.on("SIGINT", () => clearInterval(queueInterval));

// Process queues on startup
console.log("[Queue] Starting optimized queue processing on startup");
processAllPendingQueues();

// Add this function at the top with other utility functions
async function cancelPendingCalls(userId, reason) {
  console.log("[Queue] Cancelling pending calls for user", { userId, reason });
  const { error } = await supabase
    .from("call_queue")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("user_id", userId)
    .eq("status", "pending");

  if (error) {
    console.error("[Queue] Error cancelling pending calls:", error);
    throw error;
  }
  console.log("[Queue] Successfully cancelled pending calls for user", {
    userId,
  });
}

async function processQueueItem(queueItem, workerId = "unknown") {
  try {
    totalCalls++;
    activeCalls++;

    // Check available minutes before proceeding
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("available_minutes, email, first_name, last_name, assistant_name")
      .eq("id", queueItem.user_id)
      .single();

    if (userError) {
      console.error(
        `[Queue] Worker ${workerId} - Error checking user minutes:`,
        userError
      );
      throw userError;
    }

    if (!userData || userData.available_minutes <= 0) {
      // Cancel all pending calls for this user
      await cancelPendingCalls(queueItem.user_id, "No hay minutos disponibles");

      // Update current queue item status
      await supabase
        .from("call_queue")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: "No hay minutos disponibles",
        })
        .eq("id", queueItem.id);

      return false;
    }

    // Mark user as having active call (global tracking)
    userActiveCalls.set(queueItem.user_id, true);

    // Create agent_name from first_name and last_name
    const agentName =
      `${userData.first_name || ""} ${userData.last_name || ""}`.trim() ||
      "Agente";

    const date = new Date();
    const diasSemana = [
      "Domingo",
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
    ];
    const dia_semana = diasSemana[date.getDay()];
    const fecha = `${String(date.getDate()).padStart(2, "0")}/${String(
      date.getMonth() + 1
    ).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;

    // Make the call with error handling
    let call;
    try {
      call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: queueItem.lead.phone,
        url: `https://${RAILWAY_PUBLIC_DOMAIN}/outbound-call-twiml?prompt=${encodeURIComponent(
          "Eres un asistente de ventas inmobiliarias."
        )}&first_message=${encodeURIComponent(
          "Hola, ¿cómo estás?"
        )}&client_name=${encodeURIComponent(
          queueItem.lead.name
        )}&client_phone=${encodeURIComponent(
          queueItem.lead.phone
        )}&client_email=${encodeURIComponent(
          queueItem.lead.email
        )}&client_id=${encodeURIComponent(
          queueItem.lead_id
        )}&fecha=${encodeURIComponent(fecha)}&dia_semana=${encodeURIComponent(
          dia_semana
        )}&agent_name=${encodeURIComponent(
          agentName
        )}&assistant_name=${encodeURIComponent(userData.assistant_name)}`,
        statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
      });
    } catch (twilioError) {
      console.error(
        `[Queue] Worker ${workerId} - Twilio call creation failed:`,
        {
          error: twilioError.message,
          code: twilioError.code,
          status: twilioError.status,
        }
      );

      // Update queue item with error
      await supabase
        .from("call_queue")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: `Twilio error: ${twilioError.message} (Code: ${twilioError.code})`,
        })
        .eq("id", queueItem.id);

      // Release user tracking
      userActiveCalls.delete(queueItem.user_id);
      activeCalls--;

      return false;
    }

    // Track the call globally
    globalActiveCalls.set(call.sid, {
      userId: queueItem.user_id,
      queueId: queueItem.id,
      workerId: workerId,
      startTime: new Date().toISOString(),
      leadName: queueItem.lead.name,
      leadPhone: queueItem.lead.phone,
    });

    // Register the call
    const { error: callError } = await supabase.from("calls").insert({
      lead_id: queueItem.lead_id,
      user_id: queueItem.user_id,
      call_sid: call.sid,
      status: "In Progress",
      result: "initiated",
      queue_id: queueItem.id,
      conversation_id: null,
    });

    if (callError) {
      console.error(
        `[Queue] Worker ${workerId} - Error registering call:`,
        callError
      );
      throw callError;
    }

    return true;
  } catch (error) {
    failedCalls++;
    activeCalls--;
    console.error(`[Queue] Worker ${workerId} - Error processing call:`, error);

    // Release user and global tracking in case of error
    userActiveCalls.delete(queueItem.user_id);

    // Update queue item with error
    try {
      await supabase
        .from("call_queue")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error.message,
        })
        .eq("id", queueItem.id);
    } catch (updateError) {
      console.error(
        `[Queue] Worker ${workerId} - Error updating queue item with error:`,
        updateError
      );
    }

    return false;
  }
}

// Rest of your existing code...
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

// Your existing outbound-call endpoint
fastify.post("/outbound-call", async (request, reply) => {
  const {
    number,
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
    user_id,
  } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  if (!user_id) {
    return reply.code(400).send({ error: "User ID is required" });
  }

  // Get user configuration
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("first_name, last_name, assistant_name")
    .eq("id", user_id)
    .single();

  if (userError || !userData) {
    console.error("[API] Error fetching user data:", userError);
    return reply.code(400).send({ error: "User not found" });
  }

  // Create agent_name from first_name and last_name
  const agentName =
    `${userData.first_name || ""} ${userData.last_name || ""}`.trim() ||
    "Agente";

  const date = new Date();
  const diasSemana = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ];
  const dia_semana = diasSemana[date.getDay()];
  const fecha = `${String(date.getDate()).padStart(2, "0")}/${String(
    date.getMonth() + 1
  ).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${RAILWAY_PUBLIC_DOMAIN}/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(
        first_message
      )}&client_name=${encodeURIComponent(
        client_name
      )}&client_phone=${encodeURIComponent(
        client_phone
      )}&client_email=${encodeURIComponent(
        client_email
      )}&client_id=${encodeURIComponent(client_id)}&fecha=${encodeURIComponent(
        fecha
      )}&dia_semana=${encodeURIComponent(
        dia_semana
      )}&agent_name=${encodeURIComponent(
        agentName
      )}&assistant_name=${encodeURIComponent(userData.assistant_name)}`,
      statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

// Your existing outbound-call-twiml endpoint
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const {
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
    fecha,
    dia_semana,
    agent_name,
    assistant_name,
  } = request.query;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${RAILWAY_PUBLIC_DOMAIN}/outbound-media-stream">
          <Parameter name="prompt" value="${prompt}" />
          <Parameter name="first_message" value="${first_message}" />
          <Parameter name="client_name" value="${client_name}" />
          <Parameter name="client_phone" value="${client_phone}" />
          <Parameter name="client_email" value="${client_email}" />
          <Parameter name="client_id" value="${client_id}" />
          <Parameter name="fecha" value="${fecha}" />
          <Parameter name="dia_semana" value="${dia_semana}" />
          <Parameter name="agent_name" value="${agent_name}" />
          <Parameter name="assistant_name" value="${assistant_name}" />
        </Stream>
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Your existing WebSocket endpoint registration
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let lastUserTranscript = "";
      let userSpeakingTimer = null;
      let userSpeakingStartTime = null;

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            console.log(
              "[ElevenLabs] Initializing conversation with ULTRA-AGGRESSIVE interruptions"
            );

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  agent_id: ELEVENLABS_AGENT_ID,
                },
                keep_alive: true,
                interruption_settings: {
                  enabled: true,
                  sensitivity: "medium", // Back to default medium sensitivity
                  min_duration: 0.5, // Back to default 0.5 seconds
                  max_duration: 5.0, // Back to default 5 seconds
                  cooldown_period: 1.0, // Back to default 1 second
                },
              },
              dynamic_variables: {
                client_name: customParameters?.client_name || "Cliente",
                client_phone: customParameters?.client_phone || "",
                client_email: customParameters?.client_email || "",
                client_id: customParameters?.client_id || "",
                fecha: customParameters?.fecha || "",
                dia_semana: customParameters?.dia_semana || "",
                agent_name: customParameters?.agent_name || "Daniela",
                assistant_name:
                  customParameters?.assistant_name || "Asistente de Ventas",
              },
              usage: {
                no_ip_reason: "user_ip_not_collected",
              },
            };

            console.log(
              "🔧 [ElevenLabs] Initial config with ULTRA-AGGRESSIVE interruptions:"
            );
            console.log("🎯 Interruption Settings:");
            console.log("   • Enabled: true");
            console.log("   • Sensitivity: medium");
            console.log("   • Min Duration: 0.5s");
            console.log("   • Max Duration: 5.0s");
            console.log("   • Cooldown: 1.0s");
            console.log(JSON.stringify(initialConfig, null, 2));
            elevenLabsWs.send(JSON.stringify(initialConfig));

            elevenLabsWs.send(
              JSON.stringify({
                type: "audio",
                audio_event: {
                  audio_base_64: Buffer.from([0x00]).toString("base64"),
                },
              })
            );
          });

          elevenLabsWs.on("message", async (data) => {
            try {
              const message = JSON.parse(data);
              console.log(`[ElevenLabs] Event Type: ${message.type}`);
              // Only log critical events, skip ping messages
              if (message.type !== "ping") {
                console.log(`[ElevenLabs] Event: ${message.type}`);
              }

              switch (message.type) {
                case "conversation_initiation_metadata":
                  // Save conversation_id to database
                  if (
                    callSid &&
                    message.conversation_initiation_metadata_event
                      ?.conversation_id
                  ) {
                    const conversationId =
                      message.conversation_initiation_metadata_event
                        .conversation_id;

                    try {
                      const { error: updateError } = await supabase
                        .from("calls")
                        .update({
                          conversation_id: conversationId,
                          updated_at: new Date().toISOString(),
                        })
                        .eq("call_sid", callSid);

                      if (updateError) {
                        console.error(
                          "[ElevenLabs] Error saving conversation_id:",
                          updateError
                        );
                      }
                    } catch (dbError) {
                      console.error(
                        "[ElevenLabs] Error saving conversation_id to DB:",
                        dbError
                      );
                    }
                  }
                  break;

                case "audio":
                  if (streamSid) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload:
                          message.audio?.chunk ||
                          message.audio_event?.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                  break;

                case "agent_response":
                  console.log("🤖 [AGENT] Speaking");
                  break;

                case "user_speaking":
                  console.log(
                    `🎤 [USER] Speaking - Duration: ${speakingDuration}s, Should Interrupt: ${shouldInterrupt}`
                  );
                  const speakingDuration =
                    message.user_speaking_event?.duration || 0;
                  const shouldInterrupt =
                    message.user_speaking_event?.should_interrupt;

                  if (shouldInterrupt) {
                    console.log(
                      "🚨 [INTERRUPTION] ElevenLabs detected should_interrupt=true"
                    );
                  }
                  break;

                case "agent_interrupted":
                  console.log(
                    "🛑 [INTERRUPTION] Agent interrupted successfully"
                  );
                  console.log(
                    "📊 [INTERRUPTION] Details:",
                    JSON.stringify(message, null, 2)
                  );
                  break;

                case "interruption":
                  console.log("🚨 [INTERRUPTION] Interruption event received");
                  console.log(
                    "📊 [INTERRUPTION] Details:",
                    JSON.stringify(message, null, 2)
                  );
                  break;

                case "conversation_resumed":
                  console.log("🔄 [INTERRUPTION] Conversation resumed");
                  break;

                case "interruption_started":
                  console.log("🚨 [INTERRUPTION] Interruption started");
                  break;

                case "interruption_ended":
                  console.log("✅ [INTERRUPTION] Interruption ended");
                  break;

                case "user_transcript":
                  const transcript =
                    message.user_transcription_event?.user_transcript
                      ?.toLowerCase()
                      .trim() || "";

                  if (transcript === lastUserTranscript) {
                    break;
                  }

                  lastUserTranscript = transcript;

                  const normalized = transcript.replace(/[\s,]/g, "");
                  const isNumericSequence = /^\d{7,}$/.test(normalized);
                  const hasVoicemailPhrases = [
                    "deje su mensaje",
                    "después del tono",
                    "mensaje de voz",
                    "buzón de voz",
                    "el número que usted marcó",
                    "no está disponible",
                    "intente más tarde",
                    "ha sido desconectado",
                    "gracias por llamar",
                  ].some((phrase) => transcript.includes(phrase));

                  if (isNumericSequence || hasVoicemailPhrases) {
                    console.log("[System] Detected voicemail - hanging up");

                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      elevenLabsWs.close();
                    }

                    if (callSid) {
                      try {
                        await twilioClient
                          .calls(callSid)
                          .update({ status: "completed" });
                      } catch (err) {
                        console.error("[Twilio] Error ending call:", err);
                      }
                    }

                    if (ws.readyState === WebSocket.OPEN) {
                      ws.close();
                    }
                  }
                  break;

                case "conversation_summary":
                  console.log("📝 [SUMMARY] Conversation completed");

                  // Save transcript summary to database
                  if (callSid) {
                    try {
                      const { error: updateError } = await supabase
                        .from("calls")
                        .update({
                          transcript_summary:
                            message.conversation_summary_event
                              ?.conversation_summary,
                          conversation_duration:
                            message.conversation_summary_event
                              ?.conversation_duration,
                          turn_count:
                            message.conversation_summary_event?.turn_count,
                          updated_at: new Date().toISOString(),
                        })
                        .eq("call_sid", callSid);

                      if (updateError) {
                        console.error(
                          "[ElevenLabs] Error saving transcript summary:",
                          updateError
                        );
                      }
                    } catch (dbError) {
                      console.error(
                        "[ElevenLabs] Error saving transcript summary to DB:",
                        dbError
                      );
                    }
                  }
                  break;

                case "data_collection_results":
                  console.log("📊 [DATA] Collection results received");

                  // Save data collection results to database
                  if (callSid) {
                    try {
                      const { error: updateError } = await supabase
                        .from("calls")
                        .update({
                          data_collection_results:
                            message.data_collection_results_event
                              ?.collected_data,
                          data_collection_success:
                            message.data_collection_results_event?.success,
                          data_collection_error:
                            message.data_collection_results_event?.error,
                          updated_at: new Date().toISOString(),
                        })
                        .eq("call_sid", callSid);

                      if (updateError) {
                        console.error(
                          "[ElevenLabs] Error saving data collection results:",
                          updateError
                        );
                      }
                    } catch (dbError) {
                      console.error(
                        "[ElevenLabs] Error saving data collection results to DB:",
                        dbError
                      );
                    }
                  }
                  break;

                case "conversation_ended":
                  console.log("🔚 [END] Conversation ended");
                  break;

                default:
                  // Only log unknown message types, not ping
                  if (message.type !== "ping") {
                    console.log(`[ElevenLabs] Unknown event: ${message.type}`);
                  }
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", async () => {
            console.log("[ElevenLabs] Disconnected");

            if (callSid) {
              try {
                await twilioClient
                  .calls(callSid)
                  .update({ status: "completed" });
                console.log(
                  `[Twilio] Call ${callSid} ended due to ElevenLabs disconnection.`
                );
              } catch (err) {
                console.error("[Twilio] Error ending call:", err);
              }
            }

            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log("msg.event ", msg.event);
          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(
                  JSON.stringify({
                    type: "user_audio_chunk",
                    user_audio_chunk: Buffer.from(
                      msg.media.payload,
                      "base64"
                    ).toString("base64"),
                  })
                );
              }
              break;

            case "stop":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Your existing twilio-status endpoint with enhanced logging and error handling
fastify.post("/twilio-status", async (request, reply) => {
  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;
  const callErrorCode = request.body.ErrorCode;
  const callErrorMessage = request.body.ErrorMessage;

  console.log("=".repeat(80));
  console.log("📞 [TWILIO STATUS] Status update received from Twilio");
  console.log("=".repeat(80));
  console.log("📱 Call Details:");
  console.log(`   • Call SID: ${callSid}`);
  console.log(`   • Status: ${callStatus}`);
  console.log(`   • Duration: ${callDuration} seconds`);
  console.log(`   • Error Code: ${callErrorCode || "None"}`);
  console.log(`   • Error Message: ${callErrorMessage || "None"}`);
  console.log("📋 Full Twilio payload:", JSON.stringify(request.body, null, 2));
  console.log("=".repeat(80));

  try {
    // Get call info from global tracking
    const callInfo = globalActiveCalls.get(callSid);
    console.log("[Twilio] Global call info:", callInfo);

    // Determine the result based on Twilio status
    let result = "initiated";
    if (callStatus === "completed" && callDuration > 0) {
      result = "success";
    } else if (
      ["failed", "busy", "no-answer", "canceled"].includes(callStatus)
    ) {
      result = "failed";
    } else if (callErrorCode) {
      result = "failed";
    }

    console.log(
      `[Twilio] Determined result: ${result} based on status: ${callStatus}`
    );

    // Update call status with detailed error information
    const updateData = {
      duration: callDuration,
      status: callStatus,
      result: result,
      updated_at: new Date().toISOString(),
    };

    // Add error information if available
    if (callErrorCode || callErrorMessage) {
      updateData.error_code = callErrorCode;
      updateData.error_message = callErrorMessage;
      console.log(
        `[Twilio] Adding error info: ${callErrorCode} - ${callErrorMessage}`
      );
    }

    const { data: call, error: callError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("call_sid", callSid)
      .select("user_id, queue_id, lead_id")
      .single();

    if (callError) {
      console.error("[Twilio] Error updating call:", callError);
      throw callError;
    }

    console.log("[Twilio] Call updated successfully", { call });

    if (call?.user_id) {
      // Get current available minutes before update
      const { data: userData, error: fetchError } = await supabase
        .from("users")
        .select("available_minutes, email")
        .eq("id", call.user_id)
        .single();

      if (fetchError) {
        console.error("[Twilio] Error fetching user minutes:", fetchError);
      } else {
        console.log("[Twilio] Current user minutes before update:", {
          userId: call.user_id,
          userEmail: userData.email,
          availableMinutes: userData.available_minutes,
        });
      }

      // Get lead information
      const { data: leadData, error: leadError } = await supabase
        .from("leads")
        .select("name, phone, email")
        .eq("id", call.lead_id)
        .single();

      if (leadError) {
        console.error("[Twilio] Error fetching lead data:", leadError);
      } else {
        console.log("[Twilio] Lead information:", {
          leadId: call.lead_id,
          leadName: leadData.name,
          leadPhone: leadData.phone,
          leadEmail: leadData.email,
        });
      }

      // Initialize updatedUser variable
      let updatedUser = null;

      // Only deduct minutes if call was successful and has duration
      if (result === "success" && callDuration > 0) {
        console.log("[Twilio] Call was successful, deducting minutes");

        // Update user's available minutes
        const { error: userError } = await supabase.rpc("decrement_minutes", {
          uid: call.user_id,
          mins: callDuration,
        });

        if (userError) {
          console.error("[Twilio] Error updating user minutes:", userError);
        } else {
          // Get updated available minutes
          const { data: updatedUserData, error: updateFetchError } =
            await supabase
              .from("users")
              .select("available_minutes")
              .eq("id", call.user_id)
              .single();

          if (updateFetchError) {
            console.error(
              "[Twilio] Error fetching updated user minutes:",
              updateFetchError
            );
          } else {
            updatedUser = updatedUserData;
            console.log("[Twilio] User minutes updated successfully", {
              userId: call.user_id,
              previousMinutes: userData?.available_minutes || 0,
              deductedSeconds: callDuration,
              deductedMinutes: Math.round((callDuration / 60) * 100) / 100,
              newMinutes: updatedUser.available_minutes,
            });
          }
        }
      } else {
        console.log("[Twilio] Call was not successful, not deducting minutes", {
          result: result,
          duration: callDuration,
          status: callStatus,
        });
      }

      // Release the user's active call status (global tracking)
      userActiveCalls.delete(call.user_id);

      // Remove from global active calls
      globalActiveCalls.delete(callSid);

      // Update active calls count
      activeCalls--;

      // Update queue item status if exists
      if (call.queue_id) {
        const { error: queueError } = await supabase
          .from("call_queue")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", call.queue_id);

        if (queueError) {
          console.error("[Twilio] Error updating queue item:", queueError);
        } else {
          console.log("[Twilio] Queue item marked as completed", {
            queueId: call.queue_id,
          });
        }
      }

      // Trigger queue processing for next items (multi-threaded)
      setTimeout(() => {
        processAllPendingQueues();
      }, 1000);

      // Print comprehensive call summary
      console.log("=".repeat(80));
      console.log("📞 [CALL SUMMARY] Final Summary");
      console.log("=".repeat(80));
      console.log("📱 Call Details:");
      console.log(`   • Call SID: ${callSid}`);
      console.log(`   • Worker ID: ${callInfo?.workerId || "unknown"}`);
      console.log(`   • Status: ${callStatus}`);
      console.log(`   • Result: ${result}`);
      console.log(
        `   • Duration: ${callDuration} seconds (${
          Math.round((callDuration / 60) * 100) / 100
        } minutes)`
      );
      console.log(`   • Error Code: ${callErrorCode || "None"}`);
      console.log(`   • Error Message: ${callErrorMessage || "None"}`);
      console.log(`   • Completed at: ${new Date().toISOString()}`);
      console.log("");
      console.log("👤 User Details:");
      console.log(`   • User ID: ${call.user_id}`);
      console.log(`   • User Email: ${userData?.email || "N/A"}`);
      console.log(`   • Minutes Before: ${userData?.available_minutes || 0}`);
      console.log(
        `   • Minutes After: ${
          updatedUser?.available_minutes || userData?.available_minutes || 0
        }`
      );
      console.log(
        `   • Minutes Used: ${
          result === "success" ? Math.round((callDuration / 60) * 100) / 100 : 0
        }`
      );
      console.log("");
      console.log("🎯 Lead Details:");
      console.log(`   • Lead ID: ${call.lead_id}`);
      console.log(`   • Name: ${leadData?.name || "N/A"}`);
      console.log(`   • Phone: ${leadData?.phone || "N/A"}`);
      console.log(`   • Email: ${leadData?.email || "N/A"}`);
      console.log("");
      console.log("📋 Queue Details:");
      console.log(`   • Queue ID: ${call.queue_id || "N/A"}`);
      console.log(`   • Queue Status: completed`);
      console.log("");
      console.log("🔄 Global Status:");
      console.log(
        `   • Active Calls: ${globalActiveCalls.size}/${QUEUE_CONFIG.maxConcurrentCalls}`
      );
      console.log(
        `   • Active Workers: ${workerPool.size}/${QUEUE_CONFIG.workerPoolSize}`
      );
      console.log("");
      console.log("🔄 Next Steps:");
      console.log(`   • User released from active calls`);
      console.log(`   • Triggering multi-threaded queue processing`);
      console.log("=".repeat(80));
    }

    reply.code(200).send("OK");
  } catch (error) {
    console.error("[Twilio] Error in status callback:", error);
    console.log("=".repeat(80));
    console.log("❌ [CALL SUMMARY] Error occurred during call completion");
    console.log("=".repeat(80));
    reply.code(500).send("Error");
  }
});

// Add the metrics endpoint
fastify.get("/metrics", async (request, reply) => {
  try {
    // Basic server metrics
    const uptime = Math.floor((performance.now() - startTime) / 1000); // in seconds
    const memoryUsage = process.memoryUsage();
    const cpuUsage = os.loadavg();
    const freeMemory = os.freemem();
    const totalMemory = os.totalmem();

    // Get call queue metrics from database
    const { data: queueMetrics, error: queueError } = await supabase
      .from("call_queue")
      .select("status")
      .in("status", ["pending", "in_progress", "completed", "failed"])
      .then((result) => {
        const counts = {
          pending: 0,
          in_progress: 0,
          completed: 0,
          failed: 0,
        };
        result.data?.forEach((item) => {
          counts[item.status]++;
        });
        return counts;
      });

    if (queueError) {
      console.error("[Metrics] Error fetching queue metrics:", queueError);
    }

    // Get active users count
    const { count: activeUsers, error: userError } = await supabase
      .from("users")
      .select("id", { count: "exact" })
      .gt("available_minutes", 0);

    if (userError) {
      console.error("[Metrics] Error fetching user metrics:", userError);
    }

    // Calculate calls per minute
    const currentTime = Date.now();
    const timeElapsed = (currentTime - lastMetricsCheck) / 1000 / 60; // in minutes
    const callsPerMinute = timeElapsed > 0 ? totalCalls / timeElapsed : 0;

    // Reset counters
    lastMetricsCheck = currentTime;
    totalCalls = 0;

    const metrics = {
      server: {
        uptime,
        memory: {
          used: Math.round((memoryUsage.heapUsed / 1024 / 1024) * 100) / 100, // MB
          total: Math.round((totalMemory / 1024 / 1024) * 100) / 100, // MB
          free: Math.round((freeMemory / 1024 / 1024) * 100) / 100, // MB
          percentage: Math.round((1 - freeMemory / totalMemory) * 100),
        },
        cpu: {
          load1: cpuUsage[0],
          load5: cpuUsage[1],
          load15: cpuUsage[2],
        },
      },
      calls: {
        active: activeCalls,
        failed: failedCalls,
        perMinute: Math.round(callsPerMinute * 100) / 100,
      },
      queue: queueMetrics || {
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
      },
      users: {
        active: activeUsers || 0,
      },
    };

    reply.send(metrics);
  } catch (error) {
    console.error("[Metrics] Error generating metrics:", error);
    reply.code(500).send({ error: "Error generating metrics" });
  }
});

// Multi-threaded queue monitoring endpoint
fastify.get("/queue/status", async (request, reply) => {
  try {
    console.log("[Queue] Status endpoint called");

    // Get current queue status from database
    const { data: queueStatus, error: queueError } = await supabase
      .from("call_queue")
      .select("status, created_at, started_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (queueError) {
      console.error("[Queue] Error fetching queue status:", queueError);
    }

    // Get active calls details
    const activeCallsDetails = Array.from(globalActiveCalls.entries()).map(
      ([callSid, callInfo]) => ({
        callSid,
        ...callInfo,
        duration: Math.floor(
          (Date.now() - new Date(callInfo.startTime).getTime()) / 1000
        ),
      })
    );

    // Get user active calls
    const userActiveCallsDetails = Array.from(userActiveCalls.entries()).map(
      ([userId, callSid]) => ({
        userId,
        callSid,
      })
    );

    const status = {
      configuration: {
        maxConcurrentCalls: QUEUE_CONFIG.maxConcurrentCalls,
        maxCallsPerUser: QUEUE_CONFIG.maxCallsPerUser,
        workerPoolSize: QUEUE_CONFIG.workerPoolSize,
        queueCheckInterval: QUEUE_CONFIG.queueCheckInterval,
        retryAttempts: QUEUE_CONFIG.retryAttempts,
        retryDelay: QUEUE_CONFIG.retryDelay,
      },
      current: {
        activeCalls: globalActiveCalls.size,
        activeWorkers: workerPool.size,
        userActiveCalls: userActiveCalls.size,
        maxConcurrentCalls: QUEUE_CONFIG.maxConcurrentCalls,
        availableSlots:
          QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size,
      },
      performance: {
        totalCalls,
        activeCalls,
        failedCalls,
        callsPerMinute:
          Math.round(
            (totalCalls / Math.floor((Date.now() - startTime) / 1000 / 60)) *
              100
          ) / 100,
      },
      details: {
        activeCalls: activeCallsDetails,
        userActiveCalls: userActiveCallsDetails,
        recentQueueItems: queueStatus || [],
      },
      environment: {
        maxConcurrentCalls: MAX_CONCURRENT_CALLS || "5 (default)",
        maxCallsPerUser: MAX_CALLS_PER_USER || "1 (default)",
        workerPoolSize: WORKER_POOL_SIZE || "3 (default)",
        queueCheckInterval: QUEUE_CHECK_INTERVAL || "30000 (default)",
        retryAttempts: RETRY_ATTEMPTS || "3 (default)",
        retryDelay: RETRY_DELAY || "5000 (default)",
      },
    };

    reply.send({
      success: true,
      data: status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Queue] Error getting queue status:", error);
    reply.code(500).send({ error: "Error getting queue status" });
  }
});

// Endpoint to manually trigger queue processing
fastify.post("/queue/process", async (request, reply) => {
  try {
    console.log("[Queue] Manual queue processing triggered");

    // Trigger queue processing
    await processAllPendingQueues();

    reply.send({
      success: true,
      message: "Queue processing triggered successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Queue] Error triggering queue processing:", error);
    reply.code(500).send({ error: "Error triggering queue processing" });
  }
});

// Test endpoint for logging
fastify.get("/test-logs", async (request, reply) => {
  console.log("🔥🔥🔥 TEST LOGS ENDPOINT CALLED 🔥🔥🔥");
  console.log("🔥🔥🔥 TIMESTAMP:", new Date().toISOString());
  console.log("🔥🔥🔥 USER AGENT:", request.headers["user-agent"]);
  console.log("🔥🔥🔥 REMOTE ADDRESS:", request.ip);

  return reply.send({
    success: true,
    message: "Test logs endpoint called",
    timestamp: new Date().toISOString(),
    logs: "Check Railway logs for console.log messages",
  });
});

// API Integration endpoints
fastify.post("/api/integration/leads", async (request, reply) => {
  console.log("🔥🔥🔥 ENDPOINT CALLED - Integration leads endpoint 🔥🔥🔥");
  console.log("🔥🔥🔥 TIMESTAMP:", new Date().toISOString());
  console.log("🔥🔥🔥 REQUEST BODY:", JSON.stringify(request.body));

  try {
    console.log("[API] Integration leads endpoint called");
    console.log(
      "[API] Request headers:",
      JSON.stringify(request.headers, null, 2)
    );

    const apiKey =
      request.headers["x-api-key"] ||
      request.headers["authorization"]?.replace("Bearer ", "");

    if (!apiKey) {
      console.log("[API] No API key provided");
      return reply.code(401).send({ error: "API key requerida" });
    }

    console.log("[API] API key received:", apiKey);

    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (keyError || !keyData || !keyData.is_active) {
      console.log(
        "[API] Invalid API key:",
        keyError || "Key not found or inactive"
      );
      return reply.code(401).send({ error: "API key inválida" });
    }

    const userId = keyData.user_id;
    const body = request.body;

    console.log("[API] Request body:", JSON.stringify(body, null, 2));

    const {
      name,
      phone,
      email,
      auto_call = false,
      source = "api",
      notes,
    } = body;

    console.log(
      `[API] Parsed fields: name=${name}, phone=${phone}, email=${email}, auto_call=${auto_call}, source=${source}, notes=${notes}`
    );
    console.log(
      "[API] Parsed auto_call value:",
      auto_call,
      "Type:",
      typeof auto_call
    );

    if (!name || !phone || !email) {
      console.log("[API] Missing required fields");
      return reply.code(400).send({ error: "Campos requeridos faltantes" });
    }

    // Insert the lead
    console.log("[API] Inserting lead into DB...");
    const { data: newLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        user_id: userId,
        name,
        phone,
        email,
        auto_call,
        source,
        notes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("[API] Error inserting lead:", insertError);
      return reply.code(400).send({ error: insertError.message });
    }

    console.log("[API] Lead created successfully:", newLead.id);
    console.log("[API] Lead auto_call value from DB:", newLead.auto_call);

    // Handle auto_call functionality
    if (auto_call === true || auto_call === "true" || auto_call === 1) {
      console.log("[API] Auto_call is true, adding to call queue");

      try {
        // Get the next queue position for this user
        console.log("[API] Fetching last queue position for user:", userId);
        const { data: lastQueueItem, error: queueError } = await supabase
          .from("call_queue")
          .select("queue_position")
          .eq("user_id", userId)
          .order("queue_position", { ascending: false })
          .limit(1)
          .single();

        if (queueError) {
          console.error("[API] Error fetching last queue item:", queueError);
        }

        const nextPosition = (lastQueueItem?.queue_position || 0) + 1;

        console.log("[API] Next queue position:", nextPosition);

        // Add to call queue
        console.log("[API] Inserting into call_queue...");
        const { data: queueItem, error: insertQueueError } = await supabase
          .from("call_queue")
          .insert({
            user_id: userId,
            lead_id: newLead.id,
            queue_position: nextPosition,
            status: "pending",
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (insertQueueError) {
          console.error("[API] Error adding to call queue:", insertQueueError);
          return reply.code(500).send({
            error: "Lead creado pero error al agregar a cola de llamadas",
            lead: newLead,
          });
        }

        console.log("[API] Successfully added to call queue:", queueItem.id);

        // Trigger queue processing
        console.log("[API] Triggering processUserQueue for user:", userId);
        setTimeout(() => {
          processUserQueue(userId);
        }, 1000);

        return reply.send({
          success: true,
          data: newLead,
          queue_added: true,
          queue_id: queueItem.id,
        });
      } catch (queueError) {
        console.error("[API] Error in queue processing:", queueError);
        return reply.code(500).send({
          error: "Lead creado pero error al procesar cola de llamadas",
          lead: newLead,
        });
      }
    } else {
      console.log("[API] Auto_call is false, not adding to queue");
      return reply.send({
        success: true,
        data: newLead,
        queue_added: false,
      });
    }
  } catch (error) {
    console.error("[API] Error en API de leads:", error);
    return reply.code(500).send({ error: "Error interno del servidor" });
  }
});

// Endpoint to get call details including transcript and data collection
fastify.get("/api/calls/:callSid", async (request, reply) => {
  try {
    const { callSid } = request.params;
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers["authorization"]?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({ error: "API key requerida" });
    }

    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (keyError || !keyData || !keyData.is_active) {
      return reply.code(401).send({ error: "API key inválida" });
    }

    const { data: call, error: callError } = await supabase
      .from("calls")
      .select(
        `
        *,
        lead:leads (
          name,
          phone,
          email
        ),
        user:users (
          email
        )
      `
      )
      .eq("call_sid", callSid)
      .eq("user_id", keyData.user_id)
      .single();

    if (callError) {
      return reply.code(404).send({ error: "Call not found" });
    }

    return reply.send({
      success: true,
      data: {
        call_sid: call.call_sid,
        status: call.status,
        duration: call.duration,
        result: call.result,
        created_at: call.created_at,
        updated_at: call.updated_at,
        conversation_id: call.conversation_id,
        transcript_summary: call.transcript_summary,
        conversation_duration: call.conversation_duration,
        turn_count: call.turn_count,
        data_collection_results: call.data_collection_results,
        data_collection_success: call.data_collection_success,
        data_collection_error: call.data_collection_error,
        call_successful: call.call_successful,
        elevenlabs_analysis: call.elevenlabs_analysis,
        lead: call.lead,
        user: call.user,
      },
    });
  } catch (error) {
    console.error("[API] Error getting call details:", error);
    return reply.code(500).send({ error: "Error interno del servidor" });
  }
});

// ElevenLabs webhook endpoint
fastify.post("/webhook/elevenlabs", async (request, reply) => {
  try {
    console.log("=".repeat(80));
    console.log("🎯 [ELEVENLABS WEBHOOK] Received webhook from ElevenLabs");
    console.log("=".repeat(80));

    // Get the raw body for signature verification
    const rawBody = request.rawBody || JSON.stringify(request.body);
    const signature = request.headers["elevenlabs-signature"];

    console.log("🔐 [WEBHOOK] Signature verification:");
    console.log(`   • Received signature: ${signature}`);
    console.log(`   • Body length: ${rawBody.length} characters`);
    console.log(`   • Raw body preview: ${rawBody.substring(0, 100)}...`);

    // Verify the signature
    if (!signature) {
      console.error("[WEBHOOK] Error: Missing ElevenLabs-Signature header");
      return reply.code(401).send({ error: "Missing signature header" });
    }

    const isValidSignature = verifyElevenLabsSignature(rawBody, signature);

    if (!isValidSignature) {
      console.error("[WEBHOOK] Error: Invalid signature");
      return reply.code(401).send({ error: "Invalid signature" });
    }

    console.log("✅ [WEBHOOK] Signature verified successfully");
    console.log("📋 Webhook Data:", JSON.stringify(request.body, null, 2));

    const webhookData = request.body;

    // Extract key data from webhook
    const conversationId = webhookData.data?.conversation_id;
    const callSuccessful = webhookData.data?.analysis?.call_successful;
    const transcriptSummary = webhookData.data?.analysis?.transcript_summary;
    const analysis = webhookData.data?.analysis;
    const dataCollectionResults =
      webhookData.data?.analysis?.data_collection_results;

    console.log("🔍 [WEBHOOK] Extracted Data:");
    console.log(`   • Conversation ID: ${conversationId}`);
    console.log(`   • Call Successful: ${callSuccessful}`);
    console.log(`   • Has Transcript Summary: ${!!transcriptSummary}`);
    console.log(`   • Has Analysis: ${!!analysis}`);
    console.log(`   • Has Data Collection: ${!!dataCollectionResults}`);
    console.log(
      `   • Full webhook data:`,
      JSON.stringify(webhookData, null, 2)
    );

    if (!conversationId) {
      console.error("[WEBHOOK] Error: Missing conversation_id");
      console.error(
        "[WEBHOOK] Full webhook payload:",
        JSON.stringify(webhookData, null, 2)
      );
      return reply.code(400).send({ error: "Missing conversation_id" });
    }

    // Find the call record by conversation_id
    console.log(
      `[WEBHOOK] Searching for call with conversation_id: ${conversationId}`
    );
    const { data: call, error: callError } = await supabase
      .from("calls")
      .select("*")
      .eq("conversation_id", conversationId)
      .single();

    if (callError) {
      console.error(
        "[WEBHOOK] Error finding call by conversation_id:",
        callError
      );
      console.error("[WEBHOOK] Conversation ID searched:", conversationId);

      // Try to find any calls that might have this conversation_id
      const { data: allCalls, error: allCallsError } = await supabase
        .from("calls")
        .select("id, call_sid, conversation_id, created_at")
        .limit(10);

      if (!allCallsError) {
        console.log("[WEBHOOK] Recent calls in database:", allCalls);
      }

      return reply
        .code(404)
        .send({ error: "Call not found for conversation_id" });
    }

    console.log("[WEBHOOK] Found call:", call.call_sid);
    console.log("[WEBHOOK] Call details:", JSON.stringify(call, null, 2));

    // Update call record with webhook data
    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (transcriptSummary) {
      updateData.transcript_summary = transcriptSummary;
      console.log(
        "[WEBHOOK] Added transcript_summary:",
        transcriptSummary.substring(0, 100) + "..."
      );
    }

    if (analysis) {
      updateData.elevenlabs_analysis = analysis;
      console.log("[WEBHOOK] Added analysis data");
    }

    if (dataCollectionResults) {
      updateData.data_collection_results = dataCollectionResults;
      console.log("[WEBHOOK] Added data_collection_results");
    }

    if (callSuccessful !== undefined) {
      updateData.call_successful = callSuccessful;
      console.log("[WEBHOOK] Added call_successful:", callSuccessful);
    }

    console.log(
      "[WEBHOOK] Final update data:",
      JSON.stringify(updateData, null, 2)
    );

    // Update the call record
    const { error: updateError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("conversation_id", conversationId);

    if (updateError) {
      console.error("[WEBHOOK] Error updating call:", updateError);
      console.error(
        "[WEBHOOK] Update data that failed:",
        JSON.stringify(updateData, null, 2)
      );
      return reply.code(500).send({ error: "Failed to update call" });
    }

    console.log("✅ [WEBHOOK] Call updated successfully");
    console.log("=".repeat(80));

    return reply.send({
      success: true,
      message: "Webhook processed successfully",
      conversation_id: conversationId,
      call_sid: call.call_sid,
    });
  } catch (error) {
    console.error("[WEBHOOK] Error processing webhook:", error);
    console.log("=".repeat(80));
    return reply.code(500).send({ error: "Internal server error" });
  }
});

// Endpoint to update user agent configuration
fastify.put("/api/user/agent-config", async (request, reply) => {
  try {
    console.log("[API] Update agent config endpoint called");
    console.log("[API] Request body:", JSON.stringify(request.body, null, 2));

    const apiKey =
      request.headers["x-api-key"] ||
      request.headers["authorization"]?.replace("Bearer ", "");

    if (!apiKey) {
      console.log("[API] No API key provided");
      return reply.code(401).send({ error: "API key requerida" });
    }

    console.log("[API] API key received:", apiKey);

    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (keyError || !keyData || !keyData.is_active) {
      console.log(
        "[API] Invalid API key:",
        keyError || "Key not found or inactive"
      );
      return reply.code(401).send({ error: "API key inválida" });
    }

    const userId = keyData.user_id;
    const { assistant_name } = request.body;

    console.log(
      `[API] Updating assistant config for user ${userId}: assistant_name=${assistant_name}`
    );

    if (!assistant_name) {
      return reply.code(400).send({
        error: "El campo assistant_name es requerido",
      });
    }

    // Update user configuration
    const { data: updatedUser, error: updateError } = await supabase
      .from("users")
      .update({
        assistant_name: assistant_name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select("first_name, last_name, assistant_name")
      .single();

    if (updateError) {
      console.error("[API] Error updating user assistant config:", updateError);
      return reply
        .code(500)
        .send({ error: "Error actualizando configuración" });
    }

    console.log("[API] Assistant config updated successfully:", updatedUser);

    // Create agent_name from first_name and last_name
    const agentName =
      `${updatedUser.first_name || ""} ${updatedUser.last_name || ""}`.trim() ||
      "Agente";

    return reply.send({
      success: true,
      data: {
        agent_name: agentName,
        assistant_name: updatedUser.assistant_name,
      },
      message: "Configuración de asistente actualizada exitosamente",
    });
  } catch (error) {
    console.error("[API] Error updating assistant config:", error);
    return reply.code(500).send({ error: "Error interno del servidor" });
  }
});

// Endpoint to get user agent configuration
fastify.get("/api/user/agent-config", async (request, reply) => {
  try {
    console.log("[API] Get agent config endpoint called");

    const apiKey =
      request.headers["x-api-key"] ||
      request.headers["authorization"]?.replace("Bearer ", "");

    if (!apiKey) {
      console.log("[API] No API key provided");
      return reply.code(401).send({ error: "API key requerida" });
    }

    console.log("[API] API key received:", apiKey);

    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (keyError || !keyData || !keyData.is_active) {
      console.log(
        "[API] Invalid API key:",
        keyError || "Key not found or inactive"
      );
      return reply.code(401).send({ error: "API key inválida" });
    }

    const userId = keyData.user_id;

    console.log(`[API] Getting agent config for user ${userId}`);

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("first_name, last_name, assistant_name")
      .eq("id", userId)
      .single();

    if (userError) {
      console.error("[API] Error fetching user agent config:", userError);
      return reply.code(500).send({ error: "Error obteniendo configuración" });
    }

    console.log("[API] Agent config retrieved successfully:", userData);

    // Create agent_name from first_name and last_name
    const agentName =
      `${userData.first_name || ""} ${userData.last_name || ""}`.trim() ||
      "Agente";

    return reply.send({
      success: true,
      data: {
        agent_name: agentName,
        assistant_name: userData.assistant_name,
      },
    });
  } catch (error) {
    console.error("[API] Error getting agent config:", error);
    return reply.code(500).send({ error: "Error interno del servidor" });
  }
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log("🚀 SERVER STARTED - Railway deployment successful!");
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[Server] Railway domain: ${RAILWAY_PUBLIC_DOMAIN}`);
  console.log("=".repeat(80));
});
// 🚀 Force Railway deployment - Sun Jun 22 21:04:44 EDT 2025

// Optimized cleanup function with reduced frequency
async function cleanupStuckCalls() {
  try {
    // Get all calls marked as "In Progress"
    const { data: stuckCalls, error: callsError } = await supabase
      .from("calls")
      .select("*")
      .eq("status", "In Progress");

    if (callsError) {
      console.error("[CLEANUP] Error getting stuck calls:", callsError);
      return;
    }

    if (!stuckCalls || stuckCalls.length === 0) {
      return;
    }

    for (const call of stuckCalls) {
      try {
        // Check real status in Twilio
        const twilioCall = await twilioClient.calls(call.call_sid).fetch();

        // If call is actually completed in Twilio but marked as "In Progress" in DB
        if (
          ["completed", "failed", "busy", "no-answer", "canceled"].includes(
            twilioCall.status
          )
        ) {
          // Determine result based on Twilio status
          let result = "initiated";
          if (twilioCall.status === "completed" && twilioCall.duration > 0) {
            result = "success";
          } else if (
            ["failed", "busy", "no-answer", "canceled"].includes(
              twilioCall.status
            )
          ) {
            result = "failed";
          }

          // Update call status in database
          const updateData = {
            status: twilioCall.status,
            duration: twilioCall.duration || 0,
            result: result,
            updated_at: new Date().toISOString(),
          };

          // Add error information if available
          if (twilioCall.errorCode || twilioCall.errorMessage) {
            updateData.error_code = twilioCall.errorCode;
            updateData.error_message = twilioCall.errorMessage;
          }

          await supabase
            .from("calls")
            .update(updateData)
            .eq("call_sid", call.call_sid);

          // Remove from global tracking
          globalActiveCalls.delete(call.call_sid);
          userActiveCalls.delete(call.user_id);
          activeCalls--;

          // Update associated queue item
          if (call.queue_id) {
            await supabase
              .from("call_queue")
              .update({
                status: "completed",
                completed_at: new Date().toISOString(),
              })
              .eq("id", call.queue_id);
          }
        } else if (twilioCall.status === "in-progress") {
          // Check if call has been running too long (more than 15 minutes)
          const callStartTime = new Date(call.created_at);
          const now = new Date();
          const durationMinutes = (now - callStartTime) / (1000 * 60);

          if (durationMinutes > 15) {
            try {
              // Hang up the call
              await twilioClient
                .calls(call.call_sid)
                .update({ status: "completed" });

              // Update database
              await supabase
                .from("calls")
                .update({
                  status: "completed",
                  duration: Math.round(durationMinutes * 60),
                  result: "failed",
                  error_code: "TIMEOUT",
                  error_message: "Call hung up due to timeout (15+ minutes)",
                  updated_at: new Date().toISOString(),
                })
                .eq("call_sid", call.call_sid);

              // Remove from global tracking
              globalActiveCalls.delete(call.call_sid);
              userActiveCalls.delete(call.user_id);
              activeCalls--;
            } catch (hangupError) {
              console.error(
                `[CLEANUP] Error hanging up call ${call.call_sid}:`,
                hangupError
              );
            }
          }
        }
      } catch (twilioError) {
        // If we can't verify in Twilio, mark as failed
        await supabase
          .from("calls")
          .update({
            status: "failed",
            result: "failed",
            error_code: "TWILIO_ERROR",
            error_message: `Error checking call status: ${twilioError.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("call_sid", call.call_sid);

        // Remove from global tracking
        globalActiveCalls.delete(call.call_sid);
        userActiveCalls.delete(call.user_id);
        activeCalls--;
      }
    }

    // Clean up stuck queue items
    const { data: stuckQueue } = await supabase
      .from("call_queue")
      .select("*")
      .eq("status", "in_progress");

    if (stuckQueue && stuckQueue.length > 0) {
      for (const queueItem of stuckQueue) {
        const { data: associatedCall } = await supabase
          .from("calls")
          .select("status")
          .eq("queue_id", queueItem.id)
          .single();

        if (!associatedCall || associatedCall.status !== "In Progress") {
          await supabase
            .from("call_queue")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", queueItem.id);
        }
      }
    }
  } catch (error) {
    console.error("[CLEANUP] Error during cleanup:", error);
  }
}

// Run cleanup every 10 minutes instead of 5
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
console.log(
  `[CLEANUP] Setting up cleanup every ${CLEANUP_INTERVAL / 1000} seconds`
);

const cleanupInterval = setInterval(cleanupStuckCalls, CLEANUP_INTERVAL);

// Clean up interval on shutdown
process.on("SIGTERM", () => {
  clearInterval(cleanupInterval);
  clearInterval(queueInterval);
});
process.on("SIGINT", () => {
  clearInterval(cleanupInterval);
  clearInterval(queueInterval);
});

// Run initial cleanup on startup
console.log("[CLEANUP] Running initial cleanup on startup");
setTimeout(cleanupStuckCalls, 30000); // Run after 30 seconds instead of 10

// Endpoint to manually trigger cleanup
fastify.post("/queue/cleanup", async (request, reply) => {
  try {
    console.log("[Queue] Manual cleanup triggered");

    // Run cleanup immediately
    await cleanupStuckCalls();

    reply.send({
      success: true,
      message: "Cleanup completed successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Queue] Error during manual cleanup:", error);
    reply.code(500).send({ error: "Error during cleanup" });
  }
});
