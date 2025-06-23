// 🚀 Enhanced logging for Railway deployment - Sun Jun 22 20:51:35 EDT 2025
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;
const activeUserCalls = new Map(); // Track active calls per user

// Add metrics tracking variables
let startTime = performance.now();
let totalCalls = 0;
let activeCalls = 0;
let failedCalls = 0;
let lastMetricsCheck = Date.now();

// Multi-threaded queue processing configuration
const QUEUE_CONFIG = {
  maxConcurrentCalls: parseInt(MAX_CONCURRENT_CALLS) || 5, // Maximum calls running simultaneously
  maxCallsPerUser: parseInt(MAX_CALLS_PER_USER) || 1, // Maximum calls per user (keep at 1 for now)
  workerPoolSize: parseInt(WORKER_POOL_SIZE) || 3, // Number of worker threads for processing
  queueCheckInterval: parseInt(QUEUE_CHECK_INTERVAL) || 30000, // 30 seconds
  retryAttempts: parseInt(RETRY_ATTEMPTS) || 3, // Number of retry attempts for failed calls
  retryDelay: parseInt(RETRY_DELAY) || 5000, // Delay between retries in milliseconds
};

// Track active calls globally
const globalActiveCalls = new Map(); // callSid -> callInfo
const userActiveCalls = new Map(); // userId -> callSid
const workerPool = new Set(); // Track active workers

console.log("[Queue] Multi-threaded configuration:", QUEUE_CONFIG);

// Function to verify ElevenLabs webhook signature
function verifyElevenLabsSignature(payload, signature) {
  try {
    console.log("[WEBHOOK] Verifying signature format:", signature);

    // ElevenLabs sends signature in format: t=timestamp,v0=signature
    // We need to extract the actual signature from the v0= part
    let actualSignature = signature;

    if (signature.includes("v0=")) {
      // Extract the signature from v0= part
      const v0Match = signature.match(/v0=([a-f0-9]+)/);
      if (v0Match) {
        actualSignature = v0Match[1];
        console.log(
          "[WEBHOOK] Extracted signature from v0= format:",
          actualSignature
        );
      } else {
        console.error("[WEBHOOK] Could not extract signature from v0= format");
        return false;
      }
    }

    // Generate expected signature
    const expectedSignature = crypto
      .createHmac("sha256", ELEVENLABS_WEBHOOK_SECRET)
      .update(payload, "utf8")
      .digest("hex");

    console.log("[WEBHOOK] Expected signature:", expectedSignature);
    console.log("[WEBHOOK] Actual signature:", actualSignature);
    console.log(
      "[WEBHOOK] Signatures match:",
      expectedSignature === actualSignature
    );

    // Use simple string comparison instead of timingSafeEqual to avoid buffer length issues
    return expectedSignature === actualSignature;
  } catch (error) {
    console.error("[WEBHOOK] Error verifying signature:", error);
    return false;
  }
}

// Subscribe to call queue changes
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
          console.log(
            "[Queue] New pending queue item detected, triggering multi-threaded processing"
          );
          // Trigger multi-threaded processing instead of single user processing
          setTimeout(() => {
            processAllPendingQueues();
          }, 1000);
        }
      } catch (error) {
        console.error("Error processing queue event:", error);
      }
    }
  )
  .subscribe();

// Process all pending queues
async function processAllPendingQueues() {
  try {
    console.log("[Queue] Starting multi-threaded queue processing");
    console.log(
      `[Queue] Active calls: ${globalActiveCalls.size}/${QUEUE_CONFIG.maxConcurrentCalls}`
    );
    console.log(
      `[Queue] Available workers: ${
        QUEUE_CONFIG.workerPoolSize - workerPool.size
      }`
    );

    // Check if we can process more calls
    if (globalActiveCalls.size >= QUEUE_CONFIG.maxConcurrentCalls) {
      console.log(
        "[Queue] Maximum concurrent calls reached, skipping processing"
      );
      return;
    }

    // Get all pending queue items
    const { data: pendingQueues, error } = await supabase
      .from("call_queue")
      .select(
        `
        *,
        lead:leads (
          name,
          phone,
          email
        ),
        user:auth.users (
          available_minutes,
          email,
          first_name,
          last_name,
          assistant_name
        )
      `
      )
      .eq("status", "pending")
      .order("queue_position", { ascending: true })
      .limit(QUEUE_CONFIG.maxConcurrentCalls * 2); // Get more items than we can process

    if (error) {
      console.error("[Queue] Error fetching pending queues:", error);
      throw error;
    }

    console.log(
      `[Queue] Found ${pendingQueues?.length || 0} pending queue items`
    );

    if (!pendingQueues || pendingQueues.length === 0) {
      console.log("[Queue] No pending queues to process");
      return;
    }

    // Filter and prioritize queue items
    const eligibleItems = pendingQueues.filter((item) => {
      // Check if user has available minutes
      if (!item.user || item.user.available_minutes <= 0) {
        console.log(
          `[Queue] User ${item.user_id} has no available minutes, skipping`
        );
        return false;
      }

      // Check if user already has an active call
      if (userActiveCalls.has(item.user_id)) {
        console.log(
          `[Queue] User ${item.user_id} already has active call, skipping`
        );
        return false;
      }

      return true;
    });

    console.log(`[Queue] ${eligibleItems.length} eligible items found`);

    // Process eligible items in parallel (up to max concurrent calls)
    const itemsToProcess = eligibleItems.slice(
      0,
      QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size
    );

    if (itemsToProcess.length === 0) {
      console.log("[Queue] No items to process after filtering");
      return;
    }

    console.log(
      `[Queue] Processing ${itemsToProcess.length} items in parallel`
    );

    // Process items concurrently
    const processingPromises = itemsToProcess.map(async (item) => {
      return processQueueItemWithRetry(item);
    });

    // Wait for all processing to complete
    const results = await Promise.allSettled(processingPromises);

    // Log results
    const successful = results.filter(
      (r) => r.status === "fulfilled" && r.value
    ).length;
    const failed = results.filter(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value)
    ).length;

    console.log(
      `[Queue] Processing complete: ${successful} successful, ${failed} failed`
    );
  } catch (error) {
    console.error("[Queue] Error in multi-threaded queue processing:", error);
  }
}

// Enhanced queue item processing with retry logic
async function processQueueItemWithRetry(queueItem, attempt = 1) {
  const workerId = `worker_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  try {
    console.log(
      `[Queue] Worker ${workerId} starting to process queue item ${queueItem.id} (attempt ${attempt})`
    );

    // Add to worker pool
    workerPool.add(workerId);

    // Check if we can still process this item
    if (globalActiveCalls.size >= QUEUE_CONFIG.maxConcurrentCalls) {
      console.log(
        `[Queue] Worker ${workerId} - Maximum concurrent calls reached, aborting`
      );
      return false;
    }

    if (userActiveCalls.has(queueItem.user_id)) {
      console.log(
        `[Queue] Worker ${workerId} - User ${queueItem.user_id} already has active call, aborting`
      );
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

    console.log(
      `[Queue] Worker ${workerId} - Updated queue item status to in_progress`
    );

    // Process the call
    const success = await processQueueItem(queueItem, workerId);

    if (!success) {
      console.error(`[Queue] Worker ${workerId} - Failed to process call`);

      // Retry logic
      if (attempt < QUEUE_CONFIG.retryAttempts) {
        console.log(
          `[Queue] Worker ${workerId} - Retrying in ${
            QUEUE_CONFIG.retryDelay
          }ms (attempt ${attempt + 1}/${QUEUE_CONFIG.retryAttempts})`
        );

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
        const { error: failedError } = await supabase
          .from("call_queue")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: `Failed after ${QUEUE_CONFIG.retryAttempts} attempts`,
          })
          .eq("id", queueItem.id);

        if (failedError) {
          console.error(
            `[Queue] Worker ${workerId} - Error updating failed status:`,
            failedError
          );
        }
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

// Process queues using dynamic interval from configuration
const QUEUE_INTERVAL = QUEUE_CONFIG.queueCheckInterval;
console.log(
  `[Queue] Setting up multi-threaded queue processing interval: ${QUEUE_INTERVAL}ms`
);

const queueInterval = setInterval(processAllPendingQueues, QUEUE_INTERVAL);
// Asegurarnos de que el intervalo se limpia si la aplicación se detiene
process.on("SIGTERM", () => clearInterval(queueInterval));
process.on("SIGINT", () => clearInterval(queueInterval));

// Process queues on startup
console.log("[Queue] Starting multi-threaded queue processing on startup");
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

    console.log("=".repeat(80));
    console.log(`📞 [CALL START] Worker ${workerId} - Starting new call`);
    console.log("=".repeat(80));

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
      console.log(
        `[Queue] Worker ${workerId} - No available minutes for user`,
        {
          userId: queueItem.user_id,
          userEmail: userData?.email,
          availableMinutes: userData?.available_minutes || 0,
        }
      );

      // Cancel all pending calls for this user
      await cancelPendingCalls(queueItem.user_id, "No hay minutos disponibles");

      // Update current queue item status
      const { error: updateError } = await supabase
        .from("call_queue")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: "No hay minutos disponibles",
        })
        .eq("id", queueItem.id);

      if (updateError) {
        console.error(
          `[Queue] Worker ${workerId} - Error updating queue item:`,
          updateError
        );
      }

      return false;
    }

    // Mark user as having active call (global tracking)
    userActiveCalls.set(queueItem.user_id, true);

    // Create agent_name from first_name and last_name
    const agentName =
      `${userData.first_name || ""} ${userData.last_name || ""}`.trim() ||
      "Agente";

    console.log(`[Queue] Worker ${workerId} - Initiating call`, {
      userId: queueItem.user_id,
      userEmail: userData.email,
      leadId: queueItem.lead_id,
      queueId: queueItem.id,
      availableMinutes: userData.available_minutes,
      agentName: agentName,
      assistantName: userData.assistant_name,
    });

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

    // Make the call
    const call = await twilioClient.calls.create({
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

    console.log(`[Queue] Worker ${workerId} - Call initiated successfully`, {
      callSid: call.sid,
      queueId: queueItem.id,
    });

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
      conversation_id: null, // Will be updated when ElevenLabs sends conversation_id
    });

    if (callError) {
      console.error(
        `[Queue] Worker ${workerId} - Error registering call:`,
        callError
      );
      throw callError;
    }

    // Print call start summary
    console.log("📱 Call Details:");
    console.log(`   • Call SID: ${call.sid}`);
    console.log(`   • Worker ID: ${workerId}`);
    console.log(`   • Status: In Progress`);
    console.log(`   • Started at: ${new Date().toISOString()}`);
    console.log("");
    console.log("👤 User Details:");
    console.log(`   • User ID: ${queueItem.user_id}`);
    console.log(`   • User Email: ${userData.email}`);
    console.log(`   • Available Minutes: ${userData.available_minutes}`);
    console.log("");
    console.log("🎯 Lead Details:");
    console.log(`   • Lead ID: ${queueItem.lead_id}`);
    console.log(`   • Name: ${queueItem.lead.name}`);
    console.log(`   • Phone: ${queueItem.lead.phone}`);
    console.log(`   • Email: ${queueItem.lead.email}`);
    console.log("");
    console.log("📋 Queue Details:");
    console.log(`   • Queue ID: ${queueItem.id}`);
    console.log(`   • Queue Status: in_progress`);
    console.log("");
    console.log("🔄 Global Status:");
    console.log(
      `   • Active Calls: ${globalActiveCalls.size}/${QUEUE_CONFIG.maxConcurrentCalls}`
    );
    console.log(
      `   • Active Workers: ${workerPool.size}/${QUEUE_CONFIG.workerPoolSize}`
    );
    console.log("=".repeat(80));

    return true;
  } catch (error) {
    failedCalls++;
    activeCalls--;
    console.error(`[Queue] Worker ${workerId} - Error processing call:`, error);
    console.log("=".repeat(80));
    console.log(
      `❌ [CALL START] Worker ${workerId} - Error occurred during call initiation`
    );
    console.log("=".repeat(80));

    // Release user and global tracking in case of error
    userActiveCalls.delete(queueItem.user_id);

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

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            console.log(
              "[ElevenLabs] Initializing conversation with interruption settings enabled"
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
                  sensitivity: "medium",
                  min_duration: 0.5,
                  max_duration: 3.0,
                  cooldown_period: 1.0,
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

            console.log("initialConfig ", JSON.stringify(initialConfig));
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

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log(
                    "[ElevenLabs] Received initiation metadata",
                    JSON.stringify(message, null, 2)
                  );

                  // Save conversation_id to database
                  if (
                    callSid &&
                    message.conversation_initiation_metadata_event
                      ?.conversation_id
                  ) {
                    const conversationId =
                      message.conversation_initiation_metadata_event
                        .conversation_id;
                    console.log(
                      "[ElevenLabs] Saving conversation_id:",
                      conversationId
                    );
                    console.log("[ElevenLabs] Call SID:", callSid);
                    console.log(
                      "[ElevenLabs] Full metadata event:",
                      JSON.stringify(
                        message.conversation_initiation_metadata_event,
                        null,
                        2
                      )
                    );

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
                        console.error(
                          "[ElevenLabs] Call SID that failed:",
                          callSid
                        );
                        console.error(
                          "[ElevenLabs] Conversation ID that failed:",
                          conversationId
                        );

                        // Try to find the call record
                        const { data: callRecord, error: findError } =
                          await supabase
                            .from("calls")
                            .select("id, call_sid, created_at")
                            .eq("call_sid", callSid)
                            .single();

                        if (findError) {
                          console.error(
                            "[ElevenLabs] Call record not found:",
                            findError
                          );
                        } else {
                          console.log(
                            "[ElevenLabs] Found call record:",
                            callRecord
                          );
                        }
                      } else {
                        console.log(
                          "[ElevenLabs] Conversation_id saved to database successfully"
                        );
                        console.log("[ElevenLabs] Call SID:", callSid);
                        console.log(
                          "[ElevenLabs] Conversation ID:",
                          conversationId
                        );
                      }
                    } catch (dbError) {
                      console.error(
                        "[ElevenLabs] Error saving conversation_id to DB:",
                        dbError
                      );
                    }
                  } else {
                    console.log("[ElevenLabs] Cannot save conversation_id:");
                    console.log("   • Call SID exists:", !!callSid);
                    console.log(
                      "   • Conversation ID exists:",
                      !!message.conversation_initiation_metadata_event
                        ?.conversation_id
                    );
                    console.log(
                      "   • Full message:",
                      JSON.stringify(message, null, 2)
                    );
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
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_speaking":
                  console.log(
                    `[ElevenLabs] User speaking detected - duration: ${
                      message.user_speaking_event?.duration || "N/A"
                    }s`
                  );
                  if (message.user_speaking_event?.should_interrupt) {
                    console.log(
                      "[ElevenLabs] Interruption triggered - user speaking"
                    );
                  }
                  break;

                case "agent_interrupted":
                  console.log(
                    `[ElevenLabs] Agent interrupted - reason: ${
                      message.agent_interrupted_event?.reason || "unknown"
                    }`
                  );
                  break;

                case "conversation_resumed":
                  console.log(
                    "[ElevenLabs] Conversation resumed after interruption"
                  );
                  break;

                case "user_transcript":
                  const transcript =
                    message.user_transcription_event?.user_transcript
                      ?.toLowerCase()
                      .trim() || "";

                  console.log(`[Twilio] User transcript: ${transcript}`);

                  if (transcript === lastUserTranscript) {
                    console.log(
                      "[System] Repeated transcript detected, ignoring..."
                    );
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
                    console.log(
                      "[System] Detected voicemail or machine response. Hanging up..."
                    );

                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      elevenLabsWs.close();
                    }

                    if (callSid) {
                      try {
                        await twilioClient
                          .calls(callSid)
                          .update({ status: "completed" });
                        console.log(
                          `[Twilio] Call ${callSid} terminated due to invalid transcript.`
                        );
                      } catch (err) {
                        console.error(
                          "[Twilio] Error ending call after detection:",
                          err
                        );
                      }
                    }

                    if (ws.readyState === WebSocket.OPEN) {
                      ws.close();
                    }

                    break;
                  }

                  break;

                case "conversation_summary":
                  console.log("=".repeat(80));
                  console.log(
                    "📝 [TRANSCRIPT SUMMARY] Conversation Summary Received"
                  );
                  console.log("=".repeat(80));
                  console.log("📋 Summary Details:");
                  console.log(`   • Call SID: ${callSid}`);
                  console.log(
                    `   • Lead: ${customParameters?.client_name || "N/A"}`
                  );
                  console.log(
                    `   • Phone: ${customParameters?.client_phone || "N/A"}`
                  );
                  console.log("");
                  console.log("📄 Transcript Summary:");
                  console.log(
                    `   • Summary: ${
                      message.conversation_summary_event
                        ?.conversation_summary || "N/A"
                    }`
                  );
                  console.log(
                    `   • Duration: ${
                      message.conversation_summary_event
                        ?.conversation_duration || "N/A"
                    }`
                  );
                  console.log(
                    `   • Turn Count: ${
                      message.conversation_summary_event?.turn_count || "N/A"
                    }`
                  );
                  console.log("=".repeat(80));

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
                      } else {
                        console.log(
                          "[ElevenLabs] Transcript summary saved to database"
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
                  console.log("=".repeat(80));
                  console.log(
                    "📊 [DATA COLLECTION] Data Collection Results Received"
                  );
                  console.log("=".repeat(80));
                  console.log("📋 Collection Details:");
                  console.log(`   • Call SID: ${callSid}`);
                  console.log(
                    `   • Lead: ${customParameters?.client_name || "N/A"}`
                  );
                  console.log(
                    `   • Phone: ${customParameters?.client_phone || "N/A"}`
                  );
                  console.log("");
                  console.log("📊 Collected Data:");
                  if (message.data_collection_results_event?.collected_data) {
                    const collectedData =
                      message.data_collection_results_event.collected_data;
                    Object.keys(collectedData).forEach((key) => {
                      console.log(`   • ${key}: ${collectedData[key]}`);
                    });
                  } else {
                    console.log("   • No data collected");
                  }
                  console.log("");
                  console.log("📈 Collection Status:");
                  console.log(
                    `   • Success: ${
                      message.data_collection_results_event?.success || "N/A"
                    }`
                  );
                  console.log(
                    `   • Error: ${
                      message.data_collection_results_event?.error || "None"
                    }`
                  );
                  console.log("=".repeat(80));

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
                      } else {
                        console.log(
                          "[ElevenLabs] Data collection results saved to database"
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
                  console.log("=".repeat(80));
                  console.log("🔚 [CONVERSATION ENDED] Conversation Summary");
                  console.log("=".repeat(80));
                  console.log("📋 End Details:");
                  console.log(`   • Call SID: ${callSid}`);
                  console.log(
                    `   • Lead: ${customParameters?.client_name || "N/A"}`
                  );
                  console.log(
                    `   • Phone: ${customParameters?.client_phone || "N/A"}`
                  );
                  console.log(
                    `   • Reason: ${
                      message.conversation_ended_event?.reason || "N/A"
                    }`
                  );
                  console.log(
                    `   • Duration: ${
                      message.conversation_ended_event?.conversation_duration ||
                      "N/A"
                    }`
                  );
                  console.log("=".repeat(80));
                  break;

                default:
                  if (message.type !== "ping") {
                    console.log(
                      `[ElevenLabs] Unhandled message type: ${message.type}`
                    );
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

            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
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

// Your existing twilio-status endpoint with queue management
fastify.post("/twilio-status", async (request, reply) => {
  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;

  console.log("=".repeat(80));
  console.log("📞 [CALL SUMMARY] Call completed - Starting summary");
  console.log("=".repeat(80));
  console.log("[Twilio] Status update received", {
    callSid,
    callStatus,
    callDuration,
  });

  try {
    // Get call info from global tracking
    const callInfo = globalActiveCalls.get(callSid);
    console.log("[Twilio] Global call info:", callInfo);

    // Update call status
    const { data: call, error: callError } = await supabase
      .from("calls")
      .update({
        duration: callDuration,
        status: callStatus,
      })
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

      // Update user's available minutes (callDuration is already in seconds)
      const { error: userError } = await supabase.rpc("decrement_minutes", {
        uid: call.user_id,
        mins: callDuration, // Pass the duration directly in seconds
      });

      let updatedUser = null;
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
      console.log(
        `   • Duration: ${callDuration} seconds (${
          Math.round((callDuration / 60) * 100) / 100
        } minutes)`
      );
      console.log(`   • Completed at: ${new Date().toISOString()}`);
      console.log("");
      console.log("👤 User Details:");
      console.log(`   • User ID: ${call.user_id}`);
      console.log(`   • User Email: ${userData?.email || "N/A"}`);
      console.log(`   • Minutes Before: ${userData?.available_minutes || 0}`);
      console.log(`   • Minutes After: ${updatedUser?.available_minutes || 0}`);
      console.log(
        `   • Minutes Used: ${Math.round((callDuration / 60) * 100) / 100}`
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
        user:auth.users (
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
    const rawBody = JSON.stringify(request.body);
    const signature = request.headers["elevenlabs-signature"];

    console.log("🔐 [WEBHOOK] Signature verification:");
    console.log(`   • Received signature: ${signature}`);
    console.log(`   • Body length: ${rawBody.length} characters`);

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
