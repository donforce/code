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
import { sendCallCompletionData } from "./webhook-handlers.js";

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
  // Google Calendar configuration
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  // OpenAI configuration
  OPENAI_API_KEY,
  // Stripe configuration
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
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
  !RAILWAY_PUBLIC_DOMAIN ||
  !GOOGLE_CLIENT_ID ||
  !GOOGLE_CLIENT_SECRET ||
  !OPENAI_API_KEY ||
  !STRIPE_SECRET_KEY ||
  !STRIPE_WEBHOOK_SECRET
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
  // Performance optimizations
  connectionTimeout: 30000,
  keepAliveTimeout: 30000,
  maxRequestsPerSocket: 100,
  // Disable request logging for better performance
  disableRequestLogging: true,
  // Configure body parsing for Stripe webhooks
  bodyLimit: 1048576, // 1MB
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Register content type parser for Stripe webhooks to preserve raw body
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    if (req.url === "/webhook/stripe") {
      // For Stripe webhooks, preserve the raw buffer
      req.rawBody = body;
      done(null, body);
    } else {
      // For other routes, parse as JSON
      try {
        const parsed = JSON.parse(body.toString());
        done(null, parsed);
      } catch (err) {
        done(err);
      }
    }
  }
);

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
  maxCallsPerUser: parseInt(MAX_CALLS_PER_USER) || 3, // Cambiado de 1 a 3 para permitir múltiples workers
  workerPoolSize: parseInt(WORKER_POOL_SIZE) || 10,
  queueCheckInterval: parseInt(QUEUE_CHECK_INTERVAL) || 5000,
  retryAttempts: parseInt(RETRY_ATTEMPTS) || 3,
  retryDelay: parseInt(RETRY_DELAY) || 30000,
};

// Optimized tracking with WeakMap for better memory management
const globalActiveCalls = new Map();
const userActiveCalls = new Map(); // Map<userId, number> - Count of active calls per user
const workerPool = new Set();
const processingQueueItems = new Set(); // Track items being processed to prevent duplicates

const elevenLabsConnections = new Map(); // Map<callSid, WebSocket> - Aislamiento de WebSockets por llamada// Function to translate Twilio error codes to Spanish
function translateTwilioError(twilioError) {
  const errorCode = twilioError?.code;
  const errorMessage =
    twilioError?.error || twilioError?.message || "Error desconocido";

  // Mapeo de códigos de error de Twilio a mensajes en español
  const errorTranslations = {
    // Errores de números de teléfono
    21211: "El número de teléfono que intentas llamar no es válido",
    21214: "El número de teléfono no es válido para el país especificado",
    13224: "El número de teléfono no es válido",
    21215: "El número de teléfono no es válido para el tipo de llamada",
    21216: "El número de teléfono no es válido para la región especificada",
    21217: "El número de teléfono no es válido para el tipo de servicio",
    21218: "El número de teléfono no es válido para el tipo de llamada",
    21219: "El número de teléfono no es válido para el tipo de servicio",
    21220: "El número de teléfono no es válido para el tipo de llamada",

    // Errores de autenticación
    20003: "Error de autenticación: credenciales inválidas",
    20008: "Error de autenticación: token inválido",
    20012: "Error de autenticación: cuenta suspendida",
    20013: "Error de autenticación: cuenta cancelada",
    20014: "Error de autenticación: cuenta cerrada",
    20015: "Error de autenticación: cuenta no encontrada",
    20016: "Error de autenticación: cuenta no activa",
    20017: "Error de autenticación: cuenta no verificada",
    20018: "Error de autenticación: cuenta no autorizada",
    20019: "Error de autenticación: cuenta no habilitada",
    20020: "Error de autenticación: cuenta no configurada",
    20021: "Error de autenticación: cuenta no disponible",
    20022: "Error de autenticación: cuenta no válida",
    20023: "Error de autenticación: cuenta no permitida",
    20024: "Error de autenticación: cuenta no aceptada",
    20025: "Error de autenticación: cuenta no aprobada",
    20026: "Error de autenticación: cuenta no confirmada",
    20027: "Error de autenticación: cuenta no validada",
    20028: "Error de autenticación: cuenta no verificada",
    20029: "Error de autenticación: cuenta no habilitada",
    20030: "Error de autenticación: cuenta no configurada",

    // Errores de permisos
    20404: "No tienes permisos para realizar esta acción",
    20405: "No tienes permisos para acceder a este recurso",
    20406: "No tienes permisos para modificar este recurso",
    20407: "No tienes permisos para eliminar este recurso",
    20408: "No tienes permisos para crear este recurso",
    20409: "No tienes permisos para ver este recurso",
    20410: "No tienes permisos para usar este servicio",
    20411: "No tienes permisos para usar esta función",
    20412: "No tienes permisos para usar esta característica",
    20413: "No tienes permisos para usar esta opción",
    20414: "No tienes permisos para usar este método",
    20415: "No tienes permisos para usar este endpoint",
    20416: "No tienes permisos para usar esta API",
    20417: "No tienes permisos para usar este recurso",
    20418: "No tienes permisos para usar este servicio",
    20419: "No tienes permisos para usar esta función",
    20420: "No tienes permisos para usar esta característica",

    // Errores de límites y cuotas
    30000: "Has excedido el límite de llamadas permitidas",
    30001: "Has excedido el límite de mensajes permitidos",
    30002: "Has excedido el límite de recursos permitidos",
    30003: "Has excedido el límite de solicitudes permitidas",
    30004: "Has excedido el límite de tiempo permitido",
    30005: "Has excedido el límite de datos permitidos",
    30006: "Has excedido el límite de ancho de banda permitido",
    30007: "Has excedido el límite de conexiones permitidas",
    30008: "Has excedido el límite de sesiones permitidas",
    30009: "Has excedido el límite de usuarios permitidos",
    30010: "Has excedido el límite de dispositivos permitidos",
    30011: "Has excedido el límite de aplicaciones permitidas",
    30012: "Has excedido el límite de servicios permitidos",
    30013: "Has excedido el límite de funciones permitidas",
    30014: "Has excedido el límite de características permitidas",
    30015: "Has excedido el límite de opciones permitidas",
    30016: "Has excedido el límite de métodos permitidos",
    30017: "Has excedido el límite de endpoints permitidos",
    30018: "Has excedido el límite de APIs permitidas",
    30019: "Has excedido el límite de recursos permitidos",
    30020: "Has excedido el límite de servicios permitidos",

    // Errores de red y conectividad
    40000: "Error de red: no se pudo conectar con el servicio",
    40001: "Error de red: conexión perdida",
    40002: "Error de red: timeout de conexión",
    40003: "Error de red: conexión rechazada",
    40004: "Error de red: conexión cerrada",
    40005: "Error de red: conexión interrumpida",
    40006: "Error de red: conexión no disponible",
    40007: "Error de red: conexión no válida",
    40008: "Error de red: conexión no permitida",
    40009: "Error de red: conexión no aceptada",
    40010: "Error de red: conexión no aprobada",
    40011: "Error de red: conexión no confirmada",
    40012: "Error de red: conexión no validada",
    40013: "Error de red: conexión no verificada",
    40014: "Error de red: conexión no habilitada",
    40015: "Error de red: conexión no configurada",
    40016: "Error de red: conexión no disponible",
    40017: "Error de red: conexión no válida",
    40018: "Error de red: conexión no permitida",
    40019: "Error de red: conexión no aceptada",
    40020: "Error de red: conexión no aprobada",

    // Errores de servidor
    50000: "Error interno del servidor",
    50001: "Error interno del servidor: servicio no disponible",
    50002: "Error interno del servidor: servicio sobrecargado",
    50003: "Error interno del servidor: servicio en mantenimiento",
    50004: "Error interno del servidor: servicio no configurado",
    50005: "Error interno del servidor: servicio no inicializado",
    50006: "Error interno del servidor: servicio no disponible",
    50007: "Error interno del servidor: servicio no válido",
    50008: "Error interno del servidor: servicio no permitido",
    50009: "Error interno del servidor: servicio no aceptado",
    50010: "Error interno del servidor: servicio no aprobado",
    50011: "Error interno del servidor: servicio no confirmado",
    50012: "Error interno del servidor: servicio no validado",
    50013: "Error interno del servidor: servicio no verificado",
    50014: "Error interno del servidor: servicio no habilitado",
    50015: "Error interno del servidor: servicio no configurado",
    50016: "Error interno del servidor: servicio no disponible",
    50017: "Error interno del servidor: servicio no válido",
    50018: "Error interno del servidor: servicio no permitido",
    50019: "Error interno del servidor: servicio no aceptado",
    50020: "Error interno del servidor: servicio no aprobado",

    // Errores de parámetros
    60000: "Parámetro requerido faltante",
    60001: "Parámetro inválido",
    60002: "Parámetro no válido para el tipo de servicio",
    60003: "Parámetro no válido para la región especificada",
    60004: "Parámetro no válido para el país especificado",
    60005: "Parámetro no válido para el tipo de llamada",
    60006: "Parámetro no válido para el tipo de mensaje",
    60007: "Parámetro no válido para el tipo de recurso",
    60008: "Parámetro no válido para el tipo de función",
    60009: "Parámetro no válido para el tipo de característica",
    60010: "Parámetro no válido para el tipo de opción",
    60011: "Parámetro no válido para el tipo de método",
    60012: "Parámetro no válido para el tipo de endpoint",
    60013: "Parámetro no válido para el tipo de API",
    60014: "Parámetro no válido para el tipo de servicio",
    60015: "Parámetro no válido para el tipo de función",
    60016: "Parámetro no válido para el tipo de característica",
    60017: "Parámetro no válido para el tipo de opción",
    60018: "Parámetro no válido para el tipo de método",
    60019: "Parámetro no válido para el tipo de endpoint",
    60020: "Parámetro no válido para el tipo de API",
  };

  const translatedMessage = errorTranslations[errorCode] || errorMessage;

  return {
    code: errorCode,
    message: translatedMessage,
    originalMessage: errorMessage,
    translated: translatedMessage,
  };
}

// Function to mark/unmark leads with invalid phone numbers
async function markLeadInvalidPhone(
  leadId,
  isInvalid,
  context = "twilio_error"
) {
  try {
    console.log(
      `[LEAD] Marking lead ${leadId} as ${
        isInvalid ? "invalid" : "valid"
      } phone (${context})`
    );

    const { error } = await supabase
      .from("leads")
      .update({
        invalid_phone: isInvalid,
        invalid_phone_marked_at: isInvalid ? new Date().toISOString() : null,
        invalid_phone_context: isInvalid ? context : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (error) {
      console.error(
        `[LEAD] Error marking lead ${leadId} as invalid phone:`,
        error
      );
      return false;
    }

    console.log(
      `[LEAD] Successfully marked lead ${leadId} as ${
        isInvalid ? "invalid" : "valid"
      } phone`
    );
    return true;
  } catch (error) {
    console.error(
      `[LEAD] Exception marking lead ${leadId} as invalid phone:`,
      error
    );
    return false;
  }
}

// Function to handle Twilio error and mark lead if necessary
async function handleTwilioError(
  twilioError,
  leadId = null,
  context = "unknown"
) {
  const translatedError = translateTwilioError(twilioError);

  // Check if it's a phone number validation error (code 21211, 21214, or 13224)
  if (
    (twilioError.code === 21211 ||
      twilioError.code === 21214 ||
      twilioError.code === 13224) &&
    leadId
  ) {
    console.log(
      `[TWILIO] Phone number validation error detected for lead ${leadId}, marking as invalid`
    );
    await markLeadInvalidPhone(
      leadId,
      true,
      `twilio_error_${twilioError.code}`
    );
  }

  return translatedError;
}

// Optimized signature verification - minimal logging
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

// Optimized queue subscription with minimal logging
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

// Mutex para evitar procesamiento simultáneo
let isProcessingQueue = false;

// Optimized queue processing with minimal logging
async function processAllPendingQueues() {
  // Mutex: evitar procesamiento simultáneo
  if (isProcessingQueue) {
    console.log("[Queue] ⏸️ Already processing queue, skipping");
    return;
  }

  isProcessingQueue = true;

  try {
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
        .limit(QUEUE_CONFIG.maxConcurrentCalls * 3);

      if (error) {
        console.error("[Queue] ❌ Error fetching pending queues:", error);
        return;
      }

      if (!pendingQueues || pendingQueues.length === 0) {
        return;
      }

      // Filter out items already being processed
      const availableItems = pendingQueues.filter(
        (item) => !processingQueueItems.has(item.id)
      );

      if (availableItems.length === 0) {
        return;
      }

      // Get user data in single query for all users
      const userIds = [...new Set(availableItems.map((item) => item.user_id))];

      const { data: usersData, error: usersError } = await supabase
        .from("users")
        .select(
          "id, available_minutes, email, first_name, last_name, assistant_name"
        )
        .in("id", userIds);

      if (usersError) {
        console.error("[Queue] ❌ Error fetching users data:", usersError);
        return;
      }

      // Create optimized user lookup map
      const usersMap = new Map(usersData?.map((user) => [user.id, user]) || []);

      // Group items by user and validate minutes
      const userQueues = new Map();

      for (const item of availableItems) {
        const user = usersMap.get(item.user_id);

        if (!user || user.available_minutes < 60) {
          continue; // Skip users with less than 60 minutes
        }

        if (!userQueues.has(item.user_id)) {
          userQueues.set(item.user_id, []);
        }
        userQueues.get(item.user_id).push(item);
      }

      // Calculate available slots
      const availableSlots =
        QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size;

      if (availableSlots <= 0) {
        return;
      }

      // Sort users by priority: users with active calls get priority, then by queue length
      const userPriority = [];

      for (const [userId, items] of userQueues) {
        const hasActiveCalls = (userActiveCalls.get(userId) || 0) > 0;
        const queueLength = items.length;
        const user = usersMap.get(userId);

        userPriority.push({
          userId,
          items,
          hasActiveCalls,
          queueLength,
          availableMinutes: user.available_minutes,
          priority: hasActiveCalls ? 1 : 2,
        });
      }

      // Sort by priority (active users first), then by queue length (longer queues first)
      userPriority.sort((a, b) => {
        if (a.hasActiveCalls !== b.hasActiveCalls) {
          return a.hasActiveCalls ? -1 : 1;
        }
        return b.queueLength - a.queueLength;
      });

      // Distribute slots among users (mixed rotation - Option B)
      const itemsToProcess = [];
      const userSlotCount = new Map(); // Track how many slots each user is using

      for (const userData of userPriority) {
        if (itemsToProcess.length >= availableSlots) {
          break; // No more slots available
        }

        // Calculate how many slots this user can use
        const currentUserSlots = userSlotCount.get(userData.userId) || 0;
        const userActiveCallCount = userActiveCalls.get(userData.userId) || 0;

        // User can use up to maxCallsPerUser, but needs 60 minutes per additional call
        const maxSlotsForUser = Math.min(
          QUEUE_CONFIG.maxCallsPerUser - userActiveCallCount - currentUserSlots,
          Math.floor(userData.availableMinutes / 60), // 60 minutes per call
          availableSlots - itemsToProcess.length // Available slots remaining
        );

        if (maxSlotsForUser <= 0) {
          continue;
        }

        // Take items for this user
        const userItems = userData.items.slice(0, maxSlotsForUser);

        for (const item of userItems) {
          itemsToProcess.push(item);
          userSlotCount.set(
            userData.userId,
            (userSlotCount.get(userData.userId) || 0) + 1
          );

          if (itemsToProcess.length >= availableSlots) {
            break;
          }
        }
      }

      if (itemsToProcess.length === 0) {
        return;
      }

      // Log the distribution
      const userDistribution = {};
      for (const [userId, slotCount] of userSlotCount) {
        const user = usersMap.get(userId);
        userDistribution[user.email] = {
          slots: slotCount,
          queueLength: userQueues.get(userId).length,
          availableMinutes: user.available_minutes,
        };
      }

      console.log(
        `[Queue] Processing ${itemsToProcess.length} items with mixed rotation:`,
        userDistribution
      );

      // Process items concurrently
      itemsToProcess.forEach(async (item) => {
        // Mark item as being processed to prevent duplicates
        processingQueueItems.add(item.id);

        processQueueItemWithRetry(item)
          .catch((error) => {
            console.error(
              `[Queue] ❌ Error processing item ${item.id}:`,
              error
            );
          })
          .finally(() => {
            // Remove from processing set when done
            processingQueueItems.delete(item.id);
          });
      });
    } catch (error) {
      console.error("[Queue] ❌ Error in queue processing:", error);
    }
  } finally {
    // Liberar el mutex
    isProcessingQueue = false;
  }
}

// Optimized queue item processing with minimal logging
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

    if (
      (userActiveCalls.get(queueItem.user_id) || 0) >=
      QUEUE_CONFIG.maxCallsPerUser
    ) {
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

// Función para verificar disponibilidad del calendario de Google
async function checkGoogleCalendarAvailability(userId) {
  try {
    console.log(
      `[Calendar] Verificando disponibilidad del calendario para usuario: ${userId}`
    );

    // Obtener configuración del calendario del usuario
    const { data: calendarSettings, error: settingsError } = await supabase
      .from("user_calendar_settings")
      .select(
        "access_token, refresh_token, calendar_enabled, calendar_timezone"
      )
      .eq("user_id", userId)
      .single();

    if (settingsError) {
      console.log(
        `[Calendar] No se encontró configuración de calendario para usuario ${userId}:`,
        settingsError.message
      );
      return { available: false, reason: "No calendar configuration found" };
    }

    if (!calendarSettings?.calendar_enabled) {
      console.log(`[Calendar] Calendario no habilitado para usuario ${userId}`);
      return { available: false, reason: "Calendar not enabled" };
    }

    if (!calendarSettings?.access_token) {
      console.log(`[Calendar] No hay token de acceso para usuario ${userId}`);
      return { available: false, reason: "No access token" };
    }

    // Verificar si el token actual es válido
    try {
      const tokenInfoResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${calendarSettings.access_token}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!tokenInfoResponse.ok) {
        console.log(
          `[Calendar] Token expirado para usuario ${userId}, intentando renovar...`
        );

        // Intentar renovar el token usando import dinámico
        const { google } = await import("googleapis");
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
          access_token: calendarSettings.access_token,
          refresh_token: calendarSettings.refresh_token,
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        if (!credentials.access_token) {
          console.log(
            `[Calendar] No se pudo renovar el token para usuario ${userId}`
          );
          return { available: false, reason: "Token renewal failed" };
        }

        // Actualizar el token en la base de datos
        await supabase
          .from("user_calendar_settings")
          .update({
            access_token: credentials.access_token,
            refresh_token:
              credentials.refresh_token || calendarSettings.refresh_token,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);

        console.log(
          `[Calendar] Token renovado exitosamente para usuario ${userId}`
        );
        calendarSettings.access_token = credentials.access_token;
      } else {
        console.log(`[Calendar] Token válido para usuario ${userId}`);
      }
    } catch (tokenError) {
      console.error(
        `[Calendar] Error verificando/renovando token para usuario ${userId}:`,
        tokenError.message
      );
      return { available: false, reason: "Token verification failed" };
    }

    // Verificar acceso a Google Calendar API
    try {
      const { google } = await import("googleapis");
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );

      oauth2Client.setCredentials({
        access_token: calendarSettings.access_token,
      });

      const calendar = google.calendar({ version: "v3", auth: oauth2Client });

      // Intentar obtener la lista de calendarios para verificar acceso
      const calendarsResponse = await calendar.calendarList.list();

      if (
        calendarsResponse.data.items &&
        calendarsResponse.data.items.length > 0
      ) {
        console.log(
          `[Calendar] Calendario disponible para usuario ${userId}, ${calendarsResponse.data.items.length} calendarios encontrados`
        );
        return {
          available: true,
          calendars: calendarsResponse.data.items.length,
          timezone: calendarSettings.calendar_timezone,
        };
      } else {
        console.log(
          `[Calendar] No se encontraron calendarios para usuario ${userId}`
        );
        return { available: false, reason: "No calendars found" };
      }
    } catch (calendarError) {
      console.error(
        `[Calendar] Error accediendo a Google Calendar para usuario ${userId}:`,
        calendarError.message
      );
      return { available: false, reason: "Calendar API access failed" };
    }
  } catch (error) {
    console.error(
      `[Calendar] Error general verificando calendario para usuario ${userId}:`,
      error.message
    );
    return { available: false, reason: "General error" };
  }
}

// Función para calcular horarios libres entre eventos
function calculateFreeSlots(busySlots, timezone) {
  const freeSlots = [];
  const workStart = 8; // 8:00 AM
  const workEnd = 18; // 6:00 PM

  if (busySlots.length === 0) {
    // Día completamente libre
    return [
      {
        start: `${workStart.toString().padStart(2, "0")}:00`,
        end: `${workEnd.toString().padStart(2, "0")}:00`,
        description: "Día completamente libre",
      },
    ];
  }

  // Ordenar eventos por hora de inicio
  const sortedSlots = busySlots
    .filter((slot) => !slot.isAllDay) // Excluir eventos de todo el día
    .sort((a, b) => {
      const timeA = parseInt(a.start.split(":")[0]);
      const timeB = parseInt(b.start.split(":")[0]);
      return timeA - timeB;
    });

  let currentTime = workStart;

  for (const slot of sortedSlots) {
    const slotStart = parseInt(slot.start.split(":")[0]);
    const slotEnd = parseInt(slot.end.split(":")[0]);

    // Si hay tiempo libre antes del evento
    if (slotStart > currentTime) {
      freeSlots.push({
        start: `${currentTime.toString().padStart(2, "0")}:00`,
        end: `${slotStart.toString().padStart(2, "0")}:00`,
        description: `Libre antes de "${slot.title}"`,
      });
    }

    currentTime = Math.max(currentTime, slotEnd);
  }

  // Si hay tiempo libre después del último evento
  if (currentTime < workEnd) {
    freeSlots.push({
      start: `${currentTime.toString().padStart(2, "0")}:00`,
      end: `${workEnd.toString().padStart(2, "0")}:00`,
      description: "Libre después del último evento",
    });
  }

  return freeSlots;
}

// Función para obtener resumen de disponibilidad del calendario para las próximas 2 semanas
async function getCalendarAvailabilitySummary(userId) {
  try {
    console.log(
      "[Calendar][SUMMARY] ===== INICIO DE RESUMEN DE DISPONIBILIDAD ====="
    );
    console.log(`[Calendar][SUMMARY] Usuario: ${userId}`);

    // Obtener configuración del calendario del usuario
    const { data: calendarSettings, error: settingsError } = await supabase
      .from("user_calendar_settings")
      .select(
        "access_token, refresh_token, calendar_enabled, calendar_timezone"
      )
      .eq("user_id", userId)
      .single();

    if (settingsError) {
      console.log(
        `[Calendar][SUMMARY] ❌ Error obteniendo configuración: ${settingsError.message}`
      );
      return null;
    }
    if (!calendarSettings) {
      console.log(
        `[Calendar][SUMMARY] ❌ No hay configuración de calendario para el usuario.`
      );
      return null;
    }
    console.log(
      `[Calendar][SUMMARY] Configuración encontrada:`,
      calendarSettings
    );

    if (!calendarSettings.calendar_enabled) {
      console.log(
        `[Calendar][SUMMARY] ⚠️ Calendario no habilitado para usuario ${userId}`
      );
      return null;
    }
    if (!calendarSettings.access_token) {
      console.log(
        `[Calendar][SUMMARY] ❌ No hay token de acceso para usuario ${userId}`
      );
      return null;
    }

    // Verificar y renovar token si es necesario
    try {
      console.log(
        `[Calendar][SUMMARY] Verificando validez del token de acceso...`
      );
      const tokenInfoResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${calendarSettings.access_token}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!tokenInfoResponse.ok) {
        console.log(
          `[Calendar][SUMMARY] ⚠️ Token expirado, intentando renovar...`
        );
        const { google } = await import("googleapis");
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({
          access_token: calendarSettings.access_token,
          refresh_token: calendarSettings.refresh_token,
        });
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (credentials.access_token) {
          await supabase
            .from("user_calendar_settings")
            .update({
              access_token: credentials.access_token,
              refresh_token:
                credentials.refresh_token || calendarSettings.refresh_token,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
          calendarSettings.access_token = credentials.access_token;
          console.log(`[Calendar][SUMMARY] ✅ Token renovado correctamente.`);
        } else {
          console.log(`[Calendar][SUMMARY] ❌ No se pudo renovar el token.`);
          return null;
        }
      } else {
        const tokenInfo = await tokenInfoResponse.json();
        console.log(`[Calendar][SUMMARY] ✅ Token válido. Info:`, tokenInfo);
      }
    } catch (tokenError) {
      console.error(
        `[Calendar][SUMMARY] ❌ Error verificando/renovando token:`,
        tokenError.message
      );
      return null;
    }

    // Obtener eventos del calendario para las próximas 2 semanas
    try {
      const { google } = await import("googleapis");
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials({
        access_token: calendarSettings.access_token,
      });
      const calendar = google.calendar({ version: "v3", auth: oauth2Client });
      const now = new Date();
      const twoWeeksFromNow = new Date(
        now.getTime() + 14 * 24 * 60 * 60 * 1000
      );
      const eventsResponse = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: twoWeeksFromNow.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      const events = eventsResponse.data.items || [];
      console.log(
        `[Calendar][SUMMARY] Total de eventos encontrados: ${events.length}`
      );

      // Procesar eventos y crear resumen detallado
      const summary = {
        userId: userId,
        timezone: calendarSettings.calendar_timezone,
        period: {
          start: now.toISOString(),
          end: twoWeeksFromNow.toISOString(),
          days: 14,
        },
        totalEvents: events.length,
        eventsByDay: {},
        availabilityByDay: {},
        busyHours: {},
        freeDays: [],
        busyDays: [],
      };

      const daysWithEvents = new Set();

      // Procesar eventos y crear horarios ocupados
      events.forEach((event) => {
        const start = new Date(event.start.dateTime || event.start.date);
        const end = new Date(event.end.dateTime || event.end.date);
        const dayKey = start.toISOString().split("T")[0];

        if (!summary.eventsByDay[dayKey]) {
          summary.eventsByDay[dayKey] = [];
        }

        summary.eventsByDay[dayKey].push({
          title: event.summary || "Sin título",
          start: start.toISOString(),
          end: end.toISOString(),
          startTime: start.toLocaleTimeString("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: calendarSettings.calendar_timezone,
          }),
          endTime: end.toLocaleTimeString("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: calendarSettings.calendar_timezone,
          }),
          duration: Math.round((end - start) / (1000 * 60)),
          isAllDay: !event.start.dateTime,
        });

        daysWithEvents.add(dayKey);
      });

      // Crear disponibilidad detallada por día
      for (let i = 0; i < 14; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() + i);
        const dayKey = date.toISOString().split("T")[0];
        const dayName = date.toLocaleDateString("es-ES", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          timeZone: calendarSettings.calendar_timezone,
        });

        if (daysWithEvents.has(dayKey)) {
          summary.busyDays.push(dayKey);

          // Crear horarios de disponibilidad para días ocupados
          const dayEvents = summary.eventsByDay[dayKey] || [];
          const busySlots = dayEvents.map((event) => ({
            start: event.startTime,
            end: event.endTime,
            title: event.title,
            isAllDay: event.isAllDay,
          }));

          summary.availabilityByDay[dayKey] = {
            date: dayKey,
            dayName: dayName,
            isFree: false,
            busySlots: busySlots,
            totalBusyTime: dayEvents.reduce(
              (total, event) => total + event.duration,
              0
            ),
            freeSlots: calculateFreeSlots(
              busySlots,
              calendarSettings.calendar_timezone
            ),
          };
        } else {
          summary.freeDays.push(dayKey);

          // Día completamente libre
          summary.availabilityByDay[dayKey] = {
            date: dayKey,
            dayName: dayName,
            isFree: true,
            busySlots: [],
            totalBusyTime: 0,
            freeSlots: [
              {
                start: "08:00",
                end: "18:00",
                description: "Día completamente libre",
              },
            ],
          };
        }
      }

      console.log(
        `[Calendar][SUMMARY] ${summary.freeDays.length} días libres, ${summary.busyDays.length} días ocupados`
      );

      return summary;
    } catch (calendarError) {
      console.error(
        `[Calendar][SUMMARY] ❌ Error obteniendo eventos:`,
        calendarError.message
      );
      return null;
    }
  } catch (error) {
    console.error(
      `[Calendar][SUMMARY] ❌ Error general obteniendo resumen:`,
      error.message
    );
    return null;
  }
}

async function processQueueItem(queueItem, workerId = "unknown") {
  try {
    totalCalls++;
    activeCalls++;

    // Check available minutes before proceeding
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select(
        "available_minutes, email, first_name, last_name, assistant_name, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token"
      )
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

    // Verificar disponibilidad del calendario solo para logging (no bloquea la llamada)
    console.log(
      `[Queue] Worker ${workerId} - Verificando disponibilidad del calendario (solo informativo)...`
    );
    const calendarSummary = await getCalendarAvailabilitySummary(
      queueItem.user_id
    );

    let availabilityJson = null;
    let defaultText = "Disponible todos los dias";
    let finalText = "Disponible todos los dias";
    let calendarTimezone = "America/New_York"; // Default timezone

    if (!calendarSummary) {
      console.log(
        `[Queue] Worker ${workerId} - ⚠️ No se pudo obtener resumen del calendario (pero continuando con la llamada)`
      );

      // Crear JSON por defecto indicando disponibilidad todos los días
      const now = new Date();
      const defaultDays = [];
      const defaultTextParts = [];

      for (let i = 0; i < 15; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() + i);
        const dayKey = date.toISOString().split("T")[0];
        const dayName = date.toLocaleDateString("es-ES", {
          weekday: "long",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });

        defaultDays.push({
          day: dayName,
          isFree: true,
          busyTime: 0,
          freeSlots: [
            {
              start: "08:00",
              end: "18:00",
              description: "Día completamente libre",
            },
          ],
        });

        defaultTextParts.push(
          `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} de 8AM a 6PM`
        );
      }

      defaultText = `Los días y horarios disponibles son ${defaultTextParts.join(
        "."
      )}.`;

      console.log("📅 [Calendar] Disponibilidad por defecto en texto:");
      console.log(defaultText);

      availabilityJson = {
        workerId: workerId,
        summary: {
          timezone: calendarTimezone,
          totalEvents: 0,
          freeDays: 15,
          busyDays: 0,
          period: `${now.toLocaleDateString()} - ${new Date(
            now.getTime() + 14 * 24 * 60 * 60 * 1000
          ).toLocaleDateString()}`,
        },
        period: "15 días completos",
        availability: defaultDays,
      };
    } else {
      console.log(
        `[Queue] Worker ${workerId} - ✅ Resumen del calendario obtenido:`,
        {
          timezone: calendarSummary.timezone,
          totalEvents: calendarSummary.totalEvents,
          freeDays: calendarSummary.freeDays.length,
          busyDays: calendarSummary.busyDays.length,
          period: `${new Date(
            calendarSummary.period.start
          ).toLocaleDateString()} - ${new Date(
            calendarSummary.period.end
          ).toLocaleDateString()}`,
        }
      );

      // Obtener el timezone del calendario
      calendarTimezone = calendarSummary.timezone || "America/New_York";

      // Mostrar disponibilidad detallada para los próximos 15 días
      const allDays = Object.keys(calendarSummary.availabilityByDay).sort();

      // Generar texto legible con los días y horarios disponibles
      const availabilityText = allDays
        .map((dayKey) => {
          const dayInfo = calendarSummary.availabilityByDay[dayKey];

          if (dayInfo.isFree) {
            // Día completamente libre
            const date = new Date(dayKey);
            const dayName = date.toLocaleDateString("es-ES", {
              weekday: "long",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            });
            return `${
              dayName.charAt(0).toUpperCase() + dayName.slice(1)
            } de 8AM a 6PM`;
          } else {
            // Día con horarios específicos
            const date = new Date(dayKey);
            const dayName = date.toLocaleDateString("es-ES", {
              weekday: "long",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            });

            const timeSlots = dayInfo.freeSlots
              .map((slot) => {
                const start = slot.start;
                const end = slot.end;
                return `de ${start} a ${end}`;
              })
              .join(" y ");

            return `${
              dayName.charAt(0).toUpperCase() + dayName.slice(1)
            } ${timeSlots}`;
          }
        })
        .join(", ");

      finalText = `Los días y horarios disponibles son ${availabilityText}.`;

      console.log("📅 [Calendar] Disponibilidad en texto:");
      console.log(finalText);

      // Mantener el JSON para ElevenLabs pero no imprimirlo
      availabilityJson = {
        workerId: workerId,
        summary: {
          timezone: calendarTimezone,
          totalEvents: calendarSummary.totalEvents,
          freeDays: calendarSummary.freeDays.length,
          busyDays: calendarSummary.busyDays.length,
          period: `${new Date(
            calendarSummary.period.start
          ).toLocaleDateString()} - ${new Date(
            calendarSummary.period.end
          ).toLocaleDateString()}`,
        },
        period: "15 días completos",
        availability: allDays.map((dayKey) => {
          const dayInfo = calendarSummary.availabilityByDay[dayKey];
          return {
            day: dayInfo.dayName,
            isFree: dayInfo.isFree,
            busyTime: dayInfo.isFree ? 0 : dayInfo.totalBusyTime,
            freeSlots: dayInfo.isFree
              ? []
              : dayInfo.freeSlots.map((slot) => ({
                  start: slot.start,
                  end: slot.end,
                  description: slot.description,
                })),
          };
        }),
      };
    }

    // Mark user as having active call (global tracking)
    userActiveCalls.set(
      queueItem.user_id,
      (userActiveCalls.get(queueItem.user_id) || 0) + 1
    );

    // Create agent_firstname from first_name and agent_name from full name
    const agentFirstName = userData.first_name || "Agente";
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
      // Usar el texto de disponibilidad que ya se generó correctamente
      let availabilityText = "Disponible todos los dias";

      if (availabilityJson) {
        if (availabilityJson.summary.totalEvents === 0) {
          // Usar el texto por defecto que ya se generó correctamente
          availabilityText = defaultText || "Disponible todos los dias";
        } else {
          // Usar el texto final que ya se generó correctamente
          availabilityText = finalText || "Disponible todos los dias";
        }
      }

      // Determine which phone number and Twilio client to use
      let fromPhoneNumber = TWILIO_PHONE_NUMBER; // Default
      let twilioClientToUse = twilioClient; // Default

      if (
        userData.twilio_phone_number &&
        userData.twilio_subaccount_sid &&
        userData.twilio_auth_token
      ) {
        // User has their own Twilio number, use it
        fromPhoneNumber = userData.twilio_phone_number;
        twilioClientToUse = new Twilio(
          userData.twilio_subaccount_sid,
          userData.twilio_auth_token
        );

        console.log(
          `[Queue] Worker ${workerId} - Using user's Twilio number:`,
          {
            userId: queueItem.user_id,
            fromNumber: fromPhoneNumber,
            subaccountSid: userData.twilio_subaccount_sid,
          }
        );
      } else {
        console.log(
          `[Queue] Worker ${workerId} - Using default Twilio number:`,
          fromPhoneNumber
        );
      }

      const availabilityParam = encodeURIComponent(availabilityText);
      const timezoneParam = encodeURIComponent(calendarTimezone);
      const clientPhoneParam = encodeURIComponent(queueItem.lead.phone);
      const clientEmailParam = encodeURIComponent(queueItem.lead.email);

      // Obtener la voz seleccionada del usuario
      let selectedVoiceId = null;
      console.log(
        `🔊 [VOICE] Starting voice selection for user: ${queueItem.user_id}`
      );

      try {
        const { data: voiceSettingsData, error: voiceSettingsError } =
          await supabase
            .from("user_voice_settings")
            .select(
              `
              voice_id,
              elevenlabs_voices!user_voice_settings_voice_id_fkey(
                voice_id
              )
            `
            )
            .eq("user_id", queueItem.user_id)
            .eq("is_active", true)
            .single();

        if (!voiceSettingsError && voiceSettingsData) {
          selectedVoiceId = voiceSettingsData.elevenlabs_voices?.voice_id;
          console.log(`🔊 [VOICE] ✅ User selected voice: ${selectedVoiceId}`);
        } else {
          console.log(
            `🔊 [VOICE] ❌ No voice selected for user, using default. Error: ${
              voiceSettingsError?.message || "No data found"
            }`
          );
        }
      } catch (voiceError) {
        console.log(
          `🔊 [VOICE] ❌ Error getting user voice (using default): ${voiceError.message}`
        );
      }

      const voiceParam = selectedVoiceId
        ? `&user_voice_id=${encodeURIComponent(selectedVoiceId)}`
        : "";

      console.log(`🔊 [VOICE] Final voice parameter: "${voiceParam}"`);
      console.log(`🔊 [VOICE] Selected voice ID: "${selectedVoiceId}"`);

      // Obtener preguntas personalizadas del usuario para custom_llm_extra_body
      let customLlmPrompt = null;
      try {
        const { data: questionsData, error: questionsError } = await supabase
          .from("agent_questions")
          .select("question_text, question_type, is_required, order_index")
          .eq("is_active", true)
          .order("order_index", { ascending: true });

        if (!questionsError && questionsData && questionsData.length > 0) {
          const questionsList = questionsData
            .map((q, index) => `${index + 1}. ${q.question_text}`)
            .join("\n");

          customLlmPrompt = `Durante el paso 1 (Descubrir Interés y Necesidades), asegúrate de hacer las siguientes preguntas siempre teniendo en cuenta la respuesta a cada una cuando formules la proxima pregunta:
${questionsList}

No avances al paso 2 hasta obtener una respuesta clara para cada pregunta. Varía las preguntas para evitar repetición y mantén un tono profesional y cálido.`;

          console.log(
            `🤖 [CUSTOM_LLM] ✅ Custom prompt built with ${questionsData.length} questions`
          );
        } else {
          console.log(
            `🤖 [CUSTOM_LLM] ❌ No custom questions found. Error: ${
              questionsError?.message || "No questions data"
            }`
          );
        }
      } catch (questionsError) {
        console.log(
          `🤖 [CUSTOM_LLM] ❌ Error getting custom questions: ${questionsError.message}`
        );
      }

      const customLlmParam = customLlmPrompt
        ? `&custom_llm_prompt=${encodeURIComponent(customLlmPrompt)}`
        : "";

      console.log(
        ` [CUSTOM_LLM] Final custom LLM parameter: "${
          customLlmParam ? "Present" : "Not present"
        }"`
      );

      call = await twilioClientToUse.calls.create({
        from: fromPhoneNumber,
        to: queueItem.lead.phone,
        url: `https://${RAILWAY_PUBLIC_DOMAIN}/outbound-call-twiml?prompt=${encodeURIComponent(
          "Eres un asistente de ventas inmobiliarias."
        )}&first_message=${encodeURIComponent(
          "Hola, ¿cómo estás?"
        )}&client_name=${encodeURIComponent(
          queueItem.lead.name
        )}&client_phone=${clientPhoneParam}&client_email=${clientEmailParam}&client_id=${encodeURIComponent(
          queueItem.lead_id
        )}&fecha=${encodeURIComponent(fecha)}&dia_semana=${encodeURIComponent(
          dia_semana
        )}&agent_firstname=${encodeURIComponent(
          agentFirstName
        )}&agent_name=${encodeURIComponent(
          agentName
        )}&assistant_name=${encodeURIComponent(
          userData.assistant_name
        )}&calendar_availability=${availabilityParam}&calendar_timezone=${timezoneParam}${voiceParam}${customLlmParam}`,
        statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
        record: true,
        recordingStatusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-recording-status`,
        recordingStatusCallbackMethod: "POST",
        recordingChannels: "dual",
        recordingStatusCallbackEvent: ["completed"],
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

      // Handle Twilio error and mark lead if necessary
      const translatedError = await handleTwilioError(
        twilioError,
        queueItem.lead_id,
        "queue_processing"
      );

      console.log(`[Queue] Worker ${workerId} - Translated error:`, {
        original: twilioError.message,
        translated: translatedError.message,
        code: translatedError.code,
      });

      // Determine the appropriate result based on error type
      let result = "failed";
      if (
        twilioError.code === "21211" ||
        twilioError.code === "21214" ||
        twilioError.code === "13224" ||
        translatedError.message.toLowerCase().includes("invalid phone")
      ) {
        result = "invalid_phone";
      }

      // Register the call with the correct result
      const { error: callError } = await supabase.from("calls").insert({
        lead_id: queueItem.lead_id,
        user_id: queueItem.user_id,
        call_sid: null, // No call SID since call creation failed
        status: "failed",
        result: result,
        error_code: translatedError.code,
        error_message: translatedError.message,
        error_details: JSON.stringify({
          originalMessage: translatedError.originalMessage,
          translated: translatedError.translated,
          twilioCode: twilioError.code,
          twilioStatus: twilioError.status,
          context: "queue_processing",
        }),
        queue_id: queueItem.id,
        conversation_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      if (callError) {
        console.error(
          `[Queue] Worker ${workerId} - Error registering failed call:`,
          callError
        );
      }

      // Update queue item with translated error
      await supabase
        .from("call_queue")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: translatedError.message,
          error_code: translatedError.code,
          error_details: JSON.stringify({
            originalMessage: translatedError.originalMessage,
            translated: translatedError.translated,
            twilioCode: twilioError.code,
            twilioStatus: twilioError.status,
          }),
        })
        .eq("id", queueItem.id);

      // Release user tracking
      const currentCount = userActiveCalls.get(queueItem.user_id) || 0;
      if (currentCount <= 1) {
        userActiveCalls.delete(queueItem.user_id);
      } else {
        userActiveCalls.set(queueItem.user_id, currentCount - 1);
      }
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
    const currentCount = userActiveCalls.get(queueItem.user_id) || 0;
    if (currentCount <= 1) {
      userActiveCalls.delete(queueItem.user_id);
    } else {
      userActiveCalls.set(queueItem.user_id, currentCount - 1);
    }

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

  // Get user configuration including Twilio phone number
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select(
      "first_name, last_name, assistant_name, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token, automated_calls_consent, terms_accepted_at, privacy_accepted_at, is_active, available_minutes, is_admin"
    )
    .eq("id", user_id)
    .single();

  if (userError || !userData) {
    console.error("[API] Error fetching user data:", userError);

    // Verificar si la cuenta está activa
    if (!userData.is_active) {
      console.error("[API] User account is disabled:", { userId: user_id });
      return reply.code(403).send({ error: "User account is disabled" });
    }

    // Verificar consentimiento legal básico (términos y privacidad)
    if (!userData.terms_accepted_at || !userData.privacy_accepted_at) {
      console.error("[API] User missing basic legal consent:", {
        userId,
        terms: userData.terms_accepted_at,
        privacy: userData.privacy_accepted_at,
      });
      return reply.code(403).send({
        error:
          "Legal consent required. Please accept terms and privacy policy.",
      });
    }

    // Verificar consentimiento para llamadas automatizadas
    if (!userData.automated_calls_consent) {
      console.error("[API] User missing automated calls consent:", {
        userId,
        automated_calls_consent: userData.automated_calls_consent,
      });
      return reply.code(403).send({
        error:
          "Automated calls consent required. Please accept automated calls consent.",
      });
    }

    // Verificar si tiene minutos disponibles (a menos que sea admin)
    if (
      !userData.is_admin &&
      (!userData.available_minutes || userData.available_minutes <= 0)
    ) {
      console.error("[API] User has no available minutes:", {
        userId,
        available_minutes: userData.available_minutes,
      });
      return reply.code(403).send({ error: "No available minutes" });
    }
    return reply.code(400).send({ error: "User not found" });
  }

  // Determine which phone number and Twilio client to use
  let fromPhoneNumber = TWILIO_PHONE_NUMBER; // Default
  let twilioClientToUse = twilioClient; // Default

  if (
    userData.twilio_phone_number &&
    userData.twilio_subaccount_sid &&
    userData.twilio_auth_token
  ) {
    // User has their own Twilio number, use it
    fromPhoneNumber = userData.twilio_phone_number;
    twilioClientToUse = new Twilio(
      userData.twilio_subaccount_sid,
      userData.twilio_auth_token
    );

    console.log("[API] Using user's Twilio number:", {
      userId: user_id,
      fromNumber: fromPhoneNumber,
      subaccountSid: userData.twilio_subaccount_sid,
    });
  } else {
    console.log("[API] Using default Twilio number:", fromPhoneNumber);
  }

  // Create agent_name from first_name and last_name
  const agentFirstName = userData.first_name || "Agente";
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
    const call = await twilioClientToUse.calls.create({
      from: fromPhoneNumber,
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
      )}&agent_firstname=${encodeURIComponent(
        agentFirstName
      )}&agent_name=${encodeURIComponent(
        agentName
      )}&assistant_name=${encodeURIComponent(userData.assistant_name)}`,
      statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
      record: true,
      recordingStatusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-recording-status`,
      recordingStatusCallbackMethod: "POST",
      recordingChannels: "dual",
      recordingStatusCallbackEvent: ["completed"],
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);

    // Check if it's a Twilio error and translate it
    if (error.code && (error.code >= 20000 || error.code <= 60000)) {
      const translatedError = await handleTwilioError(
        error,
        client_id,
        "outbound_call"
      );

      console.log("[API] Translated Twilio error:", {
        original: error.message,
        translated: translatedError.message,
        code: translatedError.code,
      });

      reply.code(400).send({
        success: false,
        error: translatedError.message,
        error_code: translatedError.code,
        original_error: error.message,
      });
    } else {
      reply.code(500).send({
        success: false,
        error: "Error interno del servidor al iniciar la llamada",
      });
    }
  }
});

// Your existing outbound-call-twiml endpoint
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const {
    custom_llm_prompt,
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
    fecha,
    dia_semana,
    agent_firstname,
    agent_name,
    assistant_name,
    calendar_availability,
    calendar_timezone,
    user_voice_id,
  } = request.query;

  console.log(`🔊 [TWiML] Received user_voice_id: "${user_voice_id}"`);

  // Función para escapar caracteres especiales en XML
  const escapeXml = (str) => {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${RAILWAY_PUBLIC_DOMAIN}/outbound-media-stream" interruptible="true">
          <Parameter name="interruptionAllowed" value="true"/>
          <Parameter name="prompt" value="${escapeXml(prompt)}" />
          <Parameter name="first_message" value="${escapeXml(first_message)}" />
          <Parameter name="client_name" value="${escapeXml(client_name)}" />
          <Parameter name="client_phone" value="${escapeXml(client_phone)}" />
          <Parameter name="client_email" value="${escapeXml(client_email)}" />
          <Parameter name="client_id" value="${escapeXml(client_id)}" />
          <Parameter name="fecha" value="${escapeXml(fecha)}" />
          <Parameter name="dia_semana" value="${escapeXml(dia_semana)}" />
          <Parameter name="agent_firstname" value="${escapeXml(
            agent_firstname
          )}" />
          <Parameter name="agent_name" value="${escapeXml(agent_name)}" />
          <Parameter name="assistant_name" value="${escapeXml(
            assistant_name
          )}" />
          <Parameter name="calendar_availability" value="${escapeXml(
            calendar_availability || "Disponible todos los dias"
          )}" />
          <Parameter name="calendar_timezone" value="${escapeXml(
            calendar_timezone || "America/New_York"
          )}" />
          <Parameter name="user_voice_id" value="${escapeXml(user_voice_id)}" />
          <Parameter name="custom_llm_prompt" value="${escapeXml(
            custom_llm_prompt || ""
          )}" />
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
      //let elevenLabsWs = null;
      let customParameters = null;
      let lastUserTranscript = "";
      let sentAudioChunks = new Set(); // Para evitar audio duplicado
      let audioChunkCounter = 0; // Contador para limpiar el Set periódicamente
      let interrupted = false; // Variable para controlar interrupciones
      let isVoicemailDetectionMode = false; // Variable para evitar clear durante detección de buzón de voz
      let lastAudioTime = Date.now(); // Para detectar silencios largos
      let silenceThreshold = 15000; // 15 segundos de silencio para considerar buzón de voz
      let audioBuffer = []; // Buffer para acumular audio antes de enviar
      let bufferSize = 5; // Número de chunks a acumular antes de enviar (aumentado de 3 a 5 para mayor estabilidad)
      let bufferTimeout = null; // Timeout para enviar buffer parcial

      // 🆕 NUEVAS VARIABLES PARA MEJORAR DETECCIÓN DE DUPLICADOS
      let lastAudioHash = null; // Hash del último chunk de audio enviado
      let consecutiveDuplicates = 0; // Contador de duplicados consecutivos
      let maxConsecutiveDuplicates = 3; // Máximo de duplicados consecutivos permitidos
      let audioSequenceId = 0; // ID secuencial para tracking de chunks
      let lastProcessedSequence = -1; // Último sequence ID procesado
      let audioChunkTimestamps = new Map(); // Timestamps de chunks para detectar duplicados temporales
      let duplicateDetectionWindow = 1000; // Ventana de 1 segundo para detectar duplicados

      ws.on("error", console.error);

      // 🆕 FUNCIÓN PARA GENERAR HASH DE AUDIO
      const generateAudioHash = (audioChunk) => {
        // Crear un hash simple del chunk de audio para detectar duplicados
        let hash = 0;
        for (let i = 0; i < Math.min(audioChunk.length, 100); i++) {
          const char = audioChunk.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convertir a 32-bit integer
        }
        return hash.toString();
      };

      // 🆕 FUNCIÓN PARA VERIFICAR SI UN CHUNK ES DUPLICADO
      const isDuplicateAudioChunk = (audioChunk) => {
        const now = Date.now();
        const audioHash = generateAudioHash(audioChunk);

        // Verificar si ya existe en el Set
        if (sentAudioChunks.has(audioChunk)) {
          return true;
        }

        // Verificar si el hash es igual al anterior
        if (lastAudioHash === audioHash) {
          consecutiveDuplicates++;
          if (consecutiveDuplicates > maxConsecutiveDuplicates) {
            console.log(
              `[Audio] Too many consecutive duplicates (${consecutiveDuplicates}), skipping`
            );
            return true;
          }
        } else {
          consecutiveDuplicates = 0;
        }

        // Verificar duplicados temporales (mismo audio en ventana de tiempo)
        const existingTimestamp = audioChunkTimestamps.get(audioHash);
        if (
          existingTimestamp &&
          now - existingTimestamp < duplicateDetectionWindow
        ) {
          console.log(`[Audio] Temporal duplicate detected, skipping`);
          return true;
        }

        // Actualizar tracking
        lastAudioHash = audioHash;
        audioChunkTimestamps.set(audioHash, now);

        // Limpiar timestamps antiguos
        for (const [hash, timestamp] of audioChunkTimestamps.entries()) {
          if (now - timestamp > duplicateDetectionWindow) {
            audioChunkTimestamps.delete(hash);
          }
        }

        return false;
      };

      // 🆕 FUNCIÓN PARA LIMPIAR ESTADO DE AUDIO
      const clearAudioState = () => {
        sentAudioChunks.clear();
        audioChunkCounter = 0;
        audioBuffer = [];
        lastAudioHash = null;
        consecutiveDuplicates = 0;
        audioSequenceId = 0;
        lastProcessedSequence = -1;
        audioChunkTimestamps.clear();

        if (bufferTimeout) {
          clearTimeout(bufferTimeout);
          bufferTimeout = null;
        }

        console.log("[Audio] Audio state cleared");
      };

      // Función para detectar silencios largos
      const checkForLongSilence = () => {
        const now = Date.now();
        const silenceDuration = now - lastAudioTime;

        if (silenceDuration > silenceThreshold && !isVoicemailDetectionMode) {
          console.log(
            `🔇 [SILENCE] Long silence detected: ${silenceDuration}ms - possible voicemail`
          );
          isVoicemailDetectionMode = true;

          // Terminar la llamada por silencio prolongado
          if (callSid) {
            supabase
              .from("calls")
              .update({
                status: "completed",
                result: "voicemail",
                end_reason: "voicemail_detected_by_silence",
                connection_status: "no_connection",
                connection_failure_reason: "voicemail_detected",
                updated_at: new Date().toISOString(),
              })
              .eq("call_sid", callSid)
              .then(() => {
                console.log(
                  "[System] Call marked as voicemail due to long silence"
                );
              })
              .catch((err) => {
                console.error(
                  "[System] Error updating call status for silence:",
                  err
                );
              });
          }

          if (
            elevenLabsConnections.get(callSid)?.readyState === WebSocket.OPEN
          ) {
            elevenLabsConnections.get(callSid)?.close();
          }

          if (callSid) {
            twilioClient
              .calls(callSid)
              .update({ status: "completed" })
              .catch((err) => {
                console.error(
                  "[Twilio] Error ending call due to silence:",
                  err
                );
              });
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }
      };

      // Verificar silencios cada 2 segundos
      const silenceCheckInterval = setInterval(checkForLongSilence, 5000);

      const sendClearToTwilio = (streamSid) => {
        if (streamSid) {
          const clearMsg = JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          });
          console.log(
            "🛑 [CLEAR] Sending clear event to Twilio to stop current audio"
          );
          ws.send(clearMsg);
        }
      };

      const sendAudioBuffer = () => {
        if (
          audioBuffer.length > 0 &&
          elevenLabsConnections.get(callSid)?.readyState === WebSocket.OPEN
        ) {
          // Enviar todos los chunks del buffer
          audioBuffer.forEach((chunk) => {
            elevenLabsConnections.get(callSid)?.send(
              JSON.stringify({
                type: "user_audio_chunk",
                user_audio_chunk: chunk,
              })
            );
          });

          console.log(
            `[Audio] Sent ${audioBuffer.length} buffered chunks to ElevenLabs`
          );

          // Limpiar buffer
          audioBuffer = [];
          bufferTimeout = null;
        }
      };

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          // 🆕 AISLAMIENTO DE WEBSOCKETS POR LLAMADA
          if (elevenLabsConnections.has(callSid)) {
            const existingWs = elevenLabsConnections.get(callSid);
            if (existingWs.readyState === WebSocket.OPEN) {
              existingWs.close();
            }
            elevenLabsConnections.delete(callSid);
          }

          const newWs = new WebSocket(signedUrl);
          elevenLabsConnections.set(callSid, newWs);

          newWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  agent_id: ELEVENLABS_AGENT_ID,
                },
                tts: {
                  voice_id:
                    customParameters?.user_voice_id ||
                    customParameters?.voice_id ||
                    "",
                },
                keep_alive: true,

                interruption_settings: {
                  enabled: true,
                  sensitivity: "low", // 🆕 CAMBIADO: Baja sensibilidad para reducir falsos positivos
                  min_duration: 1.0, // 🆕 AUMENTADO: 1 segundo mínimo para evitar interrupciones muy cortas
                  max_duration: 3.0, // 🆕 AUMENTADO: 3 segundos máximo para mayor estabilidad
                  cooldown_period: 1.5, // 🆕 AUMENTADO: 1.5 segundos de cooldown para más estabilidad
                },
              },
              dynamic_variables: {
                client_name: customParameters?.client_name || "Cliente",
                client_phone: customParameters?.client_phone || "",
                client_email: customParameters?.client_email || "",
                client_id: customParameters?.client_id || "",
                fecha: customParameters?.fecha || "",
                dia_semana: customParameters?.dia_semana || "",
                agent_firstname: customParameters?.agent_firstname || "Agente",
                agent_name: customParameters?.agent_name || "Daniela",
                assistant_name:
                  customParameters?.assistant_name || "Asistente de Ventas",
                calendar_availability:
                  customParameters?.calendar_availability ||
                  "Disponible todos los dias",
                calendar_timezone:
                  customParameters?.calendar_timezone || "America/New_York",
                preguntas: customParameters?.custom_llm_prompt || "",
              },
              usage: {
                no_ip_reason: "user_ip_not_collected",
              },
            };

            console.log(
              `🔊 [ElevenLabs] Full config sent to ElevenLabs:`,
              JSON.stringify(initialConfig, null, 2)
            );

            // Verificar que el WebSocket esté abierto antes de enviar
            if (newWs.readyState === WebSocket.OPEN) {
              newWs.send(JSON.stringify(initialConfig));

              // No enviar audio inicial vacío para evitar duplicados
            } else {
              console.error(
                "[ElevenLabs] WebSocket not ready, state:",
                newWs.readyState
              );
            }

            newWs.on("message", async (data) => {
              try {
                const message = JSON.parse(data);

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
                      const audioPayload =
                        message.audio?.chunk ||
                        message.audio_event?.audio_base_64;
                      // �� LOG PARA VERIFICAR CAMPO isFinalChunk DE ELEVENLABS
                      if (message.audio?.isFinalChunk !== undefined) {
                        console.log(`[ElevenLabs Audio] isFinalChunk detected: ${message.audio.isFinalChunk}`);
                      }

                      // Verificar si este audio ya fue enviado
                      if (!isDuplicateAudioChunk(audioPayload)) {
                        sentAudioChunks.add(audioPayload);
                        audioChunkCounter++;

                        // Log agent audio being sent to Twilio
                        console.log(
                          `🔊 [AGENT] Sending audio chunk #${audioChunkCounter} to Twilio`
                        );

                        // Limpiar el Set cada 100 chunks para evitar problemas de memoria
                        if (audioChunkCounter > 100) {
                          sentAudioChunks.clear();
                          audioChunkCounter = 0;
                          console.log(
                            "[ElevenLabs Audio] Cleaned audio chunks cache"
                          );
                        }

                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: audioPayload,
                          },
                        };
                        ws.send(JSON.stringify(audioData));

                        // Actualizar timestamp de audio para control de silencios
                        lastAudioTime = Date.now();
                      } else {
                        console.log(
                          "[ElevenLabs Audio] Skipping duplicate audio chunk"
                        );
                      }
                    }
                    break;

                  case "audio_chunk":
                    if (!interrupted) {
                      wsClient.send(message.audio);
                    }
                    break;

                  case "message_response":
                    interrupted = false;
                    break;

                  case "agent_response":
                    console.log("🤖 [AGENT] Speaking");
                    // Log agent response details if available
                    if (message.agent_response_event) {
                      console.log(
                        "📝 [AGENT] Response details:",
                        JSON.stringify(message.agent_response_event, null, 2)
                      );

                      // Log the actual text the agent is speaking
                      if (message.agent_response_event.text) {
                        console.log(
                          "🗣️ [AGENT] Text being spoken:",
                          message.agent_response_event.text
                        );
                      }

                      // Log the speech text if available
                      if (message.agent_response_event.speech_text) {
                        console.log(
                          "🎯 [AGENT] Speech text:",
                          message.agent_response_event.speech_text
                        );
                      }
                    }
                    break;

                  case "user_speaking":
                    const speakingDuration =
                      message.user_speaking_event?.duration || 0;
                    const shouldInterrupt =
                      message.user_speaking_event?.should_interrupt;

                    console.log(
                      `🎤 [USER] Speaking - Duration: ${speakingDuration}s, Should Interrupt: ${shouldInterrupt}`
                    );

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
                    interrupted = true;
                    break;

                  case "interruption_detected":
                    console.log(
                      "🚨 [INTERRUPTION] Interruption event received"
                    );
                    interrupted = true;
                    break;

                  case "interruption":
                    console.log(
                      "🚨 [INTERRUPTION] Interruption event received"
                    );
                    interrupted = true;
                    // 🆕 MEJORADO: Limpiar estado completo durante interrupciones
                    clearAudioState();
                    // Solo enviar clear si no estamos en modo de detección de buzón de voz
                    if (!isVoicemailDetectionMode) {
                      sendClearToTwilio(streamSid);
                      interrupted = false;
                      // Resetear el buffer
                    }
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
                    interrupted = false;
                    const transcript =
                      message.user_transcription_event?.user_transcript
                        ?.toLowerCase()
                        .trim() || "";

                    if (transcript === lastUserTranscript) {
                      break;
                    }

                    lastUserTranscript = transcript;

                    // Log user transcript in real-time
                    if (transcript) {
                      console.log("🎤 [USER] Said:", transcript);
                    }

                    // Agregar un pequeño delay para evitar procesar transcripts muy tempranos
                    // que pueden ser falsos positivos de buzón de voz
                    setTimeout(async () => {
                      const normalized = transcript.replace(/[\s,]/g, "");
                      const isNumericSequence = /^\d{7,}$/.test(normalized);

                      // Normalizar el transcript para mejor detección
                      const normalizedTranscript = transcript
                        .toLowerCase()
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, ""); // Remover acentos

                      const hasVoicemailPhrases = [
                        // Spanish phrases - más variaciones
                        "deje su mensaje",
                        "deja tu mensaje",
                        "deje un mensaje",
                        "deja un mensaje",
                        "después del tono",
                        "despues del tono",
                        "después de la señal",
                        "despues de la señal",
                        "mensaje de voz",
                        "buzón de voz",
                        "buzon de voz",
                        "el número que usted marcó",
                        "el numero que usted marco",
                        "el número que marcó",
                        "el numero que marco",
                        "no está disponible",
                        "no esta disponible",
                        "intente más tarde",
                        "intente mas tarde",
                        "pulse cualquier tecla",
                        "presione cualquier tecla",
                        "ha sido desconectado",
                        "a sido desconectado",
                        "está desconectado",
                        "esta desconectado",
                        "no contesta",
                        "no responde",
                        "no disponible",
                        "fuera de servicio",
                        "temporalmente no disponible",
                        "temporalmente indisponible",
                        "deje su recado",
                        "deja tu recado",
                        "grabadora",
                        "contestador",
                        "contestador automático",
                        "contestador automatico",
                        "presiona la tecla numeral",
                        "si sabes la extensión",
                        "si conoces la extensión",
                        "si conoce la extensión",
                        "si sabe la extensión",
                        "si conoces la extension",
                        "si conoce la extension",
                        "si sabe la extension",

                        // English phrases
                        "leave a message",
                        "leave your message",
                        "after the tone",
                        "after the beep",
                        "voice message",
                        "voicemail",
                        "voice mail",
                        "the number you dialed",
                        "the number you called",
                        "is not available",
                        "try again later",
                        "has been disconnected",
                        "please leave a message",
                        "at the tone",
                        "answering machine",
                        "answering service",
                        "out of service",
                        "temporarily unavailable",
                        "not answering",
                        "not responding",
                        "not available",
                        "disconnected",
                        "unavailable",
                        "if you know the extension",
                        "if you know the extension number",
                        "if you have the extension",
                        "if you know the extension please",
                        "if you know the extension number please",
                      ].some((phrase) => {
                        const normalizedPhrase = phrase
                          .toLowerCase()
                          .normalize("NFD")
                          .replace(/[\u0300-\u036f]/g, "");
                        return normalizedTranscript.includes(normalizedPhrase);
                      });

                      // Enhanced numeric sequence detection
                      const hasNumericSequence =
                        /^\d{7,}$/.test(normalized) ||
                        /\b\d{7,}\b/.test(transcript) ||
                        /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(transcript) ||
                        /\d{4}[-.\s]?\d{3}[-.\s]?\d{3}/.test(transcript) ||
                        /\d{3}[-.\s]?\d{4}[-.\s]?\d{4}/.test(transcript);

                      // Detect when system is saying the phone number being called
                      const phoneNumberPattern =
                        customParameters?.client_phone?.replace(/[^\d]/g, "") ||
                        "";
                      const hasPhoneNumberSequence =
                        phoneNumberPattern &&
                        phoneNumberPattern.split("").some(
                          (digit) =>
                            transcript.includes(digit) &&
                            transcript.split(digit).length > 2 // Appears multiple times
                        );

                      // Check for consecutive number sequences that might be the phone number
                      const consecutiveNumbers = transcript.match(/\d+/g) || [];
                      const hasConsecutivePhoneNumbers =
                        phoneNumberPattern &&
                        consecutiveNumbers.some(
                          (num) =>
                            num.length >= 3 && phoneNumberPattern.includes(num)
                        );

                      if (
                        hasNumericSequence ||
                        hasVoicemailPhrases ||
                        hasPhoneNumberSequence ||
                        hasConsecutivePhoneNumbers
                      ) {
                        console.log("[System] Detected voicemail - hanging up");
                        console.log("[System] Detection details:", {
                          transcript: transcript,
                          normalizedTranscript: normalizedTranscript,
                          hasNumericSequence,
                          hasVoicemailPhrases,
                          hasPhoneNumberSequence,
                          hasConsecutivePhoneNumbers,
                          phoneNumberPattern,
                        });

                        // Marcar que estamos en modo de detección de buzón de voz
                        isVoicemailDetectionMode = true;

                        // Update call status before hanging up
                        if (callSid) {
                          try {
                            await supabase
                              .from("calls")
                              .update({
                                status: "completed",
                                result: "voicemail",
                                end_reason: "voicemail_detected_by_transcript",
                                connection_status: "no_connection",
                                connection_failure_reason: "voicemail_detected",
                                updated_at: new Date().toISOString(),
                              })
                              .eq("call_sid", callSid);
                          } catch (err) {
                            console.error(
                              "[System] Error updating call status:",
                              err
                            );
                          }
                        }

                        if (
                          elevenLabsConnections.get(callSid)?.readyState ===
                          WebSocket.OPEN
                        ) {
                          elevenLabsConnections.get(callSid)?.close();
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
                    }, 1000); // Delay de 1 segundo para evitar falsos positivos
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

                    // Save conversation end details to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "conversation_ended",
                            end_reason: "elevenlabs_conversation_ended",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving conversation end:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - conversation ended`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving conversation end to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "conversation_timeout":
                    console.log(
                      "⏰ [TIMEOUT] Conversation timed out - no user response"
                    );

                    // Save timeout details to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "timeout",
                            end_reason: "elevenlabs_timeout_no_response",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving timeout:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - timeout`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving timeout to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "conversation_failed":
                    console.log("❌ [FAILED] Conversation failed");

                    // Save failure details to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "failed",
                            result: "conversation_failed",
                            end_reason: "elevenlabs_conversation_failed",
                            error_message:
                              message.conversation_failed_event?.error ||
                              "Conversation failed",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving conversation failure:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as failed - conversation failed`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving conversation failure to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "no_user_response":
                    console.log("🤐 [NO_RESPONSE] No user response detected");

                    // Save no response details to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "no_response",
                            end_reason: "elevenlabs_no_user_response",
                            connection_status: "no_connection",
                            connection_failure_reason: "no_user_response",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving no response:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - no user response`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving no response to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "voicemail_detected":
                    console.log("📞 [VOICEMAIL] Voicemail detected");

                    // Save voicemail detection to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "voicemail",
                            end_reason: "elevenlabs_voicemail_detected",
                            connection_status: "no_connection",
                            connection_failure_reason: "voicemail_detected",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving voicemail detection:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - voicemail detected`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving voicemail detection to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "call_not_answered":
                    console.log("📞 [NOT_ANSWERED] Call not answered");

                    // Save not answered to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "not_answered",
                            end_reason: "elevenlabs_call_not_answered",
                            connection_status: "no_connection",
                            connection_failure_reason: "call_not_answered",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving not answered:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - call not answered`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving not answered to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  case "call_ended_early":
                    console.log("📞 [ENDED_EARLY] Call ended early");

                    // Save early end to database
                    if (callSid) {
                      try {
                        const { error: updateError } = await supabase
                          .from("calls")
                          .update({
                            status: "completed",
                            result: "ended_early",
                            end_reason: "elevenlabs_call_ended_early",
                            connection_status: "no_connection",
                            connection_failure_reason: "call_ended_early",
                            updated_at: new Date().toISOString(),
                          })
                          .eq("call_sid", callSid);

                        if (updateError) {
                          console.error(
                            "[ElevenLabs] Error saving early end:",
                            updateError
                          );
                        } else {
                          console.log(
                            `[ElevenLabs] Call ${callSid} marked as completed - call ended early`
                          );
                        }
                      } catch (dbError) {
                        console.error(
                          "[ElevenLabs] Error saving early end to DB:",
                          dbError
                        );
                      }
                    }
                    break;

                  default:
                    // Only log unknown message types, not ping
                    if (message.type !== "ping") {
                      console.log(
                        `[ElevenLabs] Unknown event: ${message.type}`
                      );
                    }
                }
              } catch (error) {
                console.error("[ElevenLabs] Error processing message:", error);
              }
            });

            newWs.on("error", (error) => {
              console.error("[ElevenLabs] WebSocket error:", error);

              // Limpiar chunks de audio en caso de error
              clearAudioState();
            });

            newWs.on("close", async () => {
              console.log("[ElevenLabs] Disconnected");

              // Limpiar chunks de audio al desconectar ElevenLabs
              clearAudioState();

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

              if (
                elevenLabsConnections.get(callSid)?.readyState ===
                WebSocket.OPEN
              ) {
                elevenLabsConnections.get(callSid)?.close();
              }
            });
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;

              console.log(
                `🔊 [WebSocket] Received user_voice_id: "${customParameters?.user_voice_id}"`
              );

              // Setup ElevenLabs AFTER receiving customParameters
              // Setup ElevenLabs AFTER receiving customParameters
              // Verificar que no se haya configurado ya para esta llamada
              if (
                !elevenLabsConnections.has(callSid) ||
                elevenLabsConnections.get(callSid)?.readyState !==
                  WebSocket.OPEN
              ) {
                console.log(
                  `[ElevenLabs] Setting up new connection for callSid: ${callSid}`
                );
                setupElevenLabs();
              } else {
                console.log(
                  `[ElevenLabs] Connection already exists for callSid: ${callSid}, skipping setup`
                );
              }
              break;

            case "media":
              if (
                elevenLabsConnections.get(callSid)?.readyState ===
                WebSocket.OPEN
              ) {
                // Corregir: no convertir base64 a base64 nuevamente
                // El audio ya viene en base64 desde Twilio
                const audioChunk = msg.media.payload;
                // 🆕 LOG PARA VERIFICAR CAMPO isFinalChunk

                // Validar que el audio no esté vacío
                if (!audioChunk || audioChunk.length < 10) {
                  console.log("[Audio] Skipping empty or invalid audio chunk");
                  break;
                }

                // Verificar si este chunk de audio ya fue enviado (solo si no está interrumpido)
                if (!interrupted && !isDuplicateAudioChunk(audioChunk)) {
                  sentAudioChunks.add(audioChunk);
                  audioChunkCounter++;

                  // 🆕 TRACKING DE SECUENCIA PARA EVITAR CHUNKS FUERA DE ORDEN
                  audioSequenceId++;
                  const currentSequence = audioSequenceId;

                  // Verificar que no estamos procesando chunks muy antiguos
                  if (
                    lastProcessedSequence > 0 &&
                    currentSequence - lastProcessedSequence > 50
                  ) {
                    console.log(
                      `[Audio] Skipping out-of-order chunk: current=${currentSequence}, last=${lastProcessedSequence}`
                    );
                    break;
                  }
                  lastProcessedSequence = currentSequence;

                  // Actualizar timestamp de audio para control de silencios
                  lastAudioTime = Date.now();

                  // Agregar al buffer
                  audioBuffer.push(audioChunk);

                  // Limpiar timeout anterior si existe
                  if (bufferTimeout) {
                    clearTimeout(bufferTimeout);
                  }

                  // Si el buffer está lleno, enviar inmediatamente
                  if (audioBuffer.length >= bufferSize) {
                    sendAudioBuffer();
                  } else {
                    // Si no está lleno, programar envío con timeout
                    bufferTimeout = setTimeout(() => {
                      if (audioBuffer.length > 0) {
                        sendAudioBuffer();
                      }
                    }, 150); // 150ms timeout para mayor estabilidad (aumentado de 100ms)
                  }

                  // Log ocasional para debugging
                  if (audioChunkCounter % 50 === 0) {
                    console.log(
                      `[Audio] Processed ${audioChunkCounter} audio chunks, buffer size: ${audioBuffer.length}`
                    );
                  }

                  // 🆕 LOGGING MEJORADO PARA DEBUGGING DE DUPLICADOS
                  if (consecutiveDuplicates > 0) {
                    console.log(
                      `[Audio] Consecutive duplicates: ${consecutiveDuplicates}/${maxConsecutiveDuplicates}`
                    );
                  }

                  // 🆕 LIMPIEZA PERIÓDICA DEL CACHE DE AUDIO
                  if (audioChunkCounter > 100) {
                    // Limpiar solo el Set, mantener el contador
                    sentAudioChunks.clear();
                    audioChunkCounter = 0;
                    console.log("[Audio] Cleaned audio chunks cache");
                  }
                } else if (interrupted) {
                  console.log(
                    "[Audio] Skipping audio chunk due to interruption"
                  );
                  // Limpiar estado completo durante interrupciones
                  clearAudioState();
                } else {
                  console.log("[Audio] Skipping duplicate audio chunk");
                }
              } else {
                console.log(
                  "[Audio] ElevenLabs WebSocket not ready, skipping audio chunk"
                );
              }
              break;

            case "stop":
              if (
                elevenLabsConnections.get(callSid)?.readyState ===
                WebSocket.OPEN
              ) {
                elevenLabsConnections.get(callSid)?.close();
              }
              // Limpiar chunks de audio al finalizar la llamada
              clearAudioState();

              // Limpiar intervalo de verificación de silencios
              if (silenceCheckInterval) {
                clearInterval(silenceCheckInterval);
                console.log("[SILENCE] Cleaned silence check interval on stop");
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
        if (elevenLabsConnections.get(callSid)?.readyState === WebSocket.OPEN) {
          elevenLabsConnections.get(callSid)?.close();
        }
        // Limpiar chunks de audio al cerrar el WebSocket
        clearAudioState();

        // Limpiar intervalo de verificación de silencios
        if (silenceCheckInterval) {
          clearInterval(silenceCheckInterval);
          console.log("[SILENCE] Cleaned silence check interval");
        }
      });
    }
  );
});

// Function to clean up stuck calls
async function cleanupStuckCalls() {
  try {
    // console.log("[CLEANUP] Starting cleanup of stuck calls...");

    // Get all calls that are stuck in "In Progress" status
    const { data: stuckCalls, error: callsError } = await supabase
      .from("calls")
      .select("*")
      .eq("status", "In Progress");

    if (callsError) {
      console.error("[CLEANUP] Error fetching stuck calls:", callsError);
      return;
    }

    if (!stuckCalls || stuckCalls.length === 0) {
      //console.log("[CLEANUP] No stuck calls found");
      return;
    }

    console.log(`[CLEANUP] Found ${stuckCalls.length} stuck calls`);

    for (const call of stuckCalls) {
      try {
        // Get the actual call status from Twilio
        const twilioCall = await twilioClient.calls(call.call_sid).fetch();

        console.log(
          `[CLEANUP] Call ${call.call_sid} status in Twilio: ${twilioCall.status}`
        );

        // If the call has ended in Twilio but is still marked as "In Progress"
        if (
          ["completed", "failed", "busy", "no-answer", "canceled"].includes(
            twilioCall.status
          )
        ) {
          console.log(
            `[CLEANUP] Updating call ${call.call_sid} status to ${twilioCall.status}`
          );

          // Update the call in the database
          const { error: updateError } = await supabase
            .from("calls")
            .update({
              status: twilioCall.status,
              duration: twilioCall.duration || 0,
              result: twilioCall.status === "completed" ? "success" : "failed",
              connection_status:
                twilioCall.duration > 0 ? "connected" : "no_connection",
              connection_failure_reason:
                twilioCall.duration === 0
                  ? "client_hung_up_without_answering"
                  : null,
              updated_at: new Date().toISOString(),
            })
            .eq("call_sid", call.call_sid);

          if (updateError) {
            console.error(
              `[CLEANUP][ERROR] Falló la actualización de la llamada ${call.call_sid}:`,
              updateError
            );
          } else {
            console.log(
              `[CLEANUP][SUCCESS] Llamada ${call.call_sid} actualizada correctamente a estado ${twilioCall.status}`
            );
          }

          // Remove from global tracking
          globalActiveCalls.delete(call.call_sid);
          if (call.user_id) {
            const currentCount = userActiveCalls.get(call.user_id) || 0;
            if (currentCount <= 1) {
              userActiveCalls.delete(call.user_id);
            } else {
              userActiveCalls.set(call.user_id, currentCount - 1);
            }
          }
          activeCalls--;

          // Update associated queue item if exists
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
          // Check if call has been running too long (more than 5 minutes)
          const callStartTime = new Date(call.created_at);
          const now = new Date();
          const durationMinutes = (now - callStartTime) / (1000 * 60);

          if (durationMinutes > 5) {
            console.log(
              `[CLEANUP] Call ${
                call.call_sid
              } has been running for ${Math.round(
                durationMinutes
              )} minutes - hanging up`
            );

            try {
              // Hang up the call
              await twilioClient
                .calls(call.call_sid)
                .update({ status: "completed" });

              // Update database
              const { error: timeoutUpdateError } = await supabase
                .from("calls")
                .update({
                  status: "completed",
                  duration: Math.round(durationMinutes * 60),
                  result: "failed",
                  error_code: "TIMEOUT",
                  error_message: "Call hung up due to timeout (5+ minutes)",
                  connection_status: "no_connection",
                  connection_failure_reason: "timeout_5_minutes",
                  updated_at: new Date().toISOString(),
                })
                .eq("call_sid", call.call_sid);

              if (timeoutUpdateError) {
                console.error(
                  `[CLEANUP][ERROR] Falló la actualización por timeout de la llamada ${call.call_sid}:`,
                  timeoutUpdateError
                );
              } else {
                console.log(
                  `[CLEANUP][SUCCESS] Llamada ${call.call_sid} marcada como completada por timeout.`
                );
              }

              // Remove from global tracking
              globalActiveCalls.delete(call.call_sid);
              if (call.user_id) {
                const currentCount = userActiveCalls.get(call.user_id) || 0;
                if (currentCount <= 1) {
                  userActiveCalls.delete(call.user_id);
                } else {
                  userActiveCalls.set(call.user_id, currentCount - 1);
                }
              }
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
        console.error(
          `[CLEANUP] Error checking call ${call.call_sid} in Twilio:`,
          twilioError
        );

        // Handle Twilio error and mark lead if necessary
        const translatedError = await handleTwilioError(
          twilioError,
          call.lead_id,
          "cleanup_verification"
        );

        console.log(`[CLEANUP] Translated error for call ${call.call_sid}:`, {
          original: twilioError.message,
          translated: translatedError.message,
          code: translatedError.code,
        });

        // Determine the appropriate result based on error type
        let result = "failed";
        if (
          twilioError.code === "21211" ||
          twilioError.code === "21214" ||
          twilioError.code === "13224" ||
          translatedError.message.toLowerCase().includes("invalid phone")
        ) {
          result = "invalid_phone";
        }

        await supabase
          .from("calls")
          .update({
            status: "failed",
            result: result,
            error_code: translatedError.code,
            error_message: translatedError.message,
            error_details: JSON.stringify({
              originalMessage: translatedError.originalMessage,
              translated: translatedError.translated,
              twilioCode: twilioError.code,
              twilioStatus: twilioError.status,
              context: "cleanup_verification",
            }),
            updated_at: new Date().toISOString(),
          })
          .eq("call_sid", call.call_sid);

        // Remove from global tracking
        globalActiveCalls.delete(call.call_sid);
        if (call.user_id) {
          const currentCount = userActiveCalls.get(call.user_id) || 0;
          if (currentCount <= 1) {
            userActiveCalls.delete(call.user_id);
          } else {
            userActiveCalls.set(call.user_id, currentCount - 1);
          }
        }
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

// Your existing twilio-status endpoint with enhanced logging and error handling
fastify.post("/twilio-status", async (request, reply) => {
  console.log("📞 [TWILIO STATUS] Status update received");

  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;
  const callErrorCode = request.body.ErrorCode;
  const callErrorMessage = request.body.ErrorMessage;
  const accountSid = request.body.AccountSid; // Para identificar subcuentas

  console.log(
    `📱 [TWILIO STATUS] Call ${callSid}: ${callStatus} (${callDuration}s)`
  );

  // Log si la llamada viene de una subcuenta
  if (accountSid && accountSid !== TWILIO_ACCOUNT_SID) {
    console.log(`📱 [TWILIO STATUS] Call from subaccount: ${accountSid}`);
  }

  try {
    // Get call info from global tracking
    const callInfo = globalActiveCalls.get(callSid);

    // First, let's check if the call exists in the database
    const { data: existingCall, error: checkError } = await supabase
      .from("calls")
      .select("*")
      .eq("call_sid", callSid)
      .single();

    if (checkError) {
      console.error(
        "[TWILIO STATUS] Error checking existing call:",
        checkError
      );
      // Return 200 OK even if call not found to avoid Twilio errors
      return reply.code(200).send();
    }

    // Determine the result based on Twilio status
    let result = "initiated";
    let connectionStatus = "connected";
    let connectionFailureReason = null;

    if (callStatus === "completed" && callDuration > 10) {
      result = "success";
      connectionStatus = "connected";
    } else if (
      callStatus === "completed" &&
      callDuration > 0 &&
      callDuration <= 10
    ) {
      // Very short calls (likely voicemail or quick hangup)
      result = "not_answered";
      connectionStatus = "no_connection";
      connectionFailureReason = "short_call_likely_voicemail";
    } else if (callStatus === "completed" && callDuration === 0) {
      // Client hung up without answering
      result = "not_answered";
      connectionStatus = "no_connection";
      connectionFailureReason = "client_hung_up_without_answering";
    } else if (
      ["failed", "busy", "no-answer", "canceled"].includes(callStatus)
    ) {
      result = "failed";
      connectionStatus = "no_connection";

      // Determine specific failure reason
      switch (callStatus) {
        case "busy":
          connectionFailureReason = "line_busy";
          break;
        case "no-answer":
          connectionFailureReason = "no_answer";
          break;
        case "canceled":
          connectionFailureReason = "call_canceled";
          break;
        default:
          connectionFailureReason = "call_failed";
      }
    }

    // Update call status in database
    const updateData = {
      status: callStatus,
      duration: callDuration || 0,
      result: result,
      connection_status: connectionStatus,
      connection_failure_reason: connectionFailureReason,
      updated_at: new Date().toISOString(),
    };

    // Add error information if available
    if (callErrorCode || callErrorMessage) {
      updateData.error_code = callErrorCode;
      updateData.error_message = callErrorMessage;
    }

    await supabase.from("calls").update(updateData).eq("call_sid", callSid);

    // Handle error cases and mark leads accordingly
    if (existingCall && existingCall.lead_id) {
      try {
        // Handle failed calls with specific error messages
        if (result === "failed" && callErrorMessage) {
          console.log(
            `[TWILIO STATUS] Processing failed call for lead ${existingCall.lead_id}: ${callErrorMessage}`
          );

          // Check for invalid phone number
          if (
            callErrorMessage.toLowerCase().includes("invalid phone number") ||
            callErrorMessage.toLowerCase().includes("invalid phone") ||
            callErrorCode === "21211" || // Twilio error code for invalid phone
            callErrorCode === "21214" || // Twilio error code for invalid phone (actual code received)
            callErrorCode === "13224" // Twilio error code for invalid phone (actual code received)
          ) {
            // Twilio error code for invalid phone
            console.log(
              `[TWILIO STATUS] Marking lead ${existingCall.lead_id} as invalid phone`
            );
            await markLeadInvalidPhone(
              existingCall.lead_id,
              true,
              "twilio_status_webhook"
            );

            // Update the result to show "invalid phone" in the interface
            await supabase
              .from("calls")
              .update({
                result: "invalid_phone",
                error_message: callErrorMessage,
                error_code: callErrorCode,
                updated_at: new Date().toISOString(),
              })
              .eq("call_sid", callSid);
          }
        }

        // Handle no_answer status - mark lead for reprocessing
        if (connectionFailureReason === "no_answer") {
          console.log(
            `[TWILIO STATUS] Marking lead ${existingCall.lead_id} for reprocessing due to no_answer`
          );
          await supabase
            .from("leads")
            .update({
              should_reprocess: true,
              reprocess_reason: "no_answer",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.lead_id);
        }

        // Handle short calls (likely voicemail) - mark lead for reprocessing
        if (connectionFailureReason === "short_call_likely_voicemail") {
          console.log(
            `[TWILIO STATUS] Marking lead ${existingCall.lead_id} for reprocessing due to short call (likely voicemail)`
          );
          await supabase
            .from("leads")
            .update({
              should_reprocess: true,
              reprocess_reason: "short_call_likely_voicemail",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.lead_id);
        }

        // Handle not_answered calls - mark lead for reprocessing
        if (result === "not_answered") {
          console.log(
            `[TWILIO STATUS] Marking lead ${existingCall.lead_id} for reprocessing due to not_answered`
          );
          await supabase
            .from("leads")
            .update({
              should_reprocess: true,
              reprocess_reason: "not_answered",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.lead_id);
        }

        // Handle busy calls - mark lead for reprocessing
        if (connectionFailureReason === "line_busy") {
          console.log(
            `[TWILIO STATUS] Marking lead ${existingCall.lead_id} for reprocessing due to line_busy`
          );
          await supabase
            .from("leads")
            .update({
              should_reprocess: true,
              reprocess_reason: "line_busy",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.lead_id);
        }

        // Handle success calls - mark lead for reprocessing if needed
        if (result === "success") {
          console.log(
            `[TWILIO STATUS] Call successful for lead ${existingCall.lead_id}, checking if reprocessing is needed`
          );
          // You can add logic here to determine if a successful call needs reprocessing
          // For example, if the call was too short or didn't achieve the goal
          if (callDuration < 30) {
            // Less than 30 seconds might indicate a quick hangup
            console.log(
              `[TWILIO STATUS] Call was too short (${callDuration}s), marking lead for reprocessing`
            );
            await supabase
              .from("leads")
              .update({
                should_reprocess: true,
                reprocess_reason: "call_too_short",
                updated_at: new Date().toISOString(),
              })
              .eq("id", existingCall.lead_id);
          }
        }

        // Handle voicemail detection - mark lead for reprocessing
        if (
          updateData.end_reason === "voicemail_detected_by_transcript" ||
          updateData.end_reason === "voicemail_detected_by_silence" ||
          updateData.end_reason === "elevenlabs_voicemail_detected"
        ) {
          console.log(
            `[TWILIO STATUS] Marking lead ${existingCall.lead_id} for reprocessing due to voicemail detection`
          );
          await supabase
            .from("leads")
            .update({
              should_reprocess: true,
              reprocess_reason: "voicemail_detected",
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.lead_id);
        }
      } catch (error) {
        console.error(
          `[TWILIO STATUS] Error handling lead updates for lead ${existingCall.lead_id}:`,
          error
        );
      }
    }

    // Remove from global tracking
    globalActiveCalls.delete(callSid);
    if (existingCall && existingCall.user_id) {
      const currentCount = userActiveCalls.get(existingCall.user_id) || 0;
      if (currentCount <= 1) {
        userActiveCalls.delete(existingCall.user_id);
      } else {
        userActiveCalls.set(existingCall.user_id, currentCount - 1);
      }
    }
    activeCalls--;

    // Deduct minutes from user's available time if call was successful
    if (
      existingCall &&
      existingCall.user_id &&
      callDuration > 0 &&
      result === "success"
    ) {
      try {
        console.log(
          `[TWILIO STATUS] Deducting ${callDuration} seconds from user ${existingCall.user_id}`
        );

        // Get current user data
        const { data: userData, error: userError } = await supabase
          .from("users")
          .select("available_minutes")
          .eq("id", existingCall.user_id)
          .single();

        if (userError) {
          console.error("[TWILIO STATUS] Error fetching user data:", userError);
        } else if (userData) {
          // available_minutes stores the value in seconds
          const totalAvailableSeconds = userData.available_minutes || 0;

          // Calculate remaining seconds after deduction
          const remainingSeconds = Math.max(
            0,
            totalAvailableSeconds - callDuration
          );

          console.log(
            `[TWILIO STATUS] User ${existingCall.user_id} time deduction:`,
            {
              before: {
                seconds: totalAvailableSeconds,
                minutes: Math.floor(totalAvailableSeconds / 60),
              },
              callDuration,
              after: {
                seconds: remainingSeconds,
                minutes: Math.floor(remainingSeconds / 60),
              },
            }
          );

          // Update user's available time (stored in seconds)
          const { error: updateError } = await supabase
            .from("users")
            .update({
              available_minutes: remainingSeconds,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall.user_id);

          if (updateError) {
            console.error(
              "[TWILIO STATUS] Error updating user time:",
              updateError
            );
          } else {
            console.log(
              `[TWILIO STATUS] Successfully deducted ${callDuration} seconds from user ${existingCall.user_id}`
            );
          }
        }
      } catch (deductionError) {
        console.error(
          "[TWILIO STATUS] Error during time deduction:",
          deductionError
        );
      }
    }

    // Update associated queue item
    if (existingCall && existingCall.queue_id) {
      await supabase
        .from("call_queue")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", existingCall.queue_id);
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

    // Run async webhook/meta events after updating call status
    sendCallCompletionData(supabase, callSid);
    // Return 200 OK with empty response as Twilio expects
    reply.code(200).send();
  } catch (error) {
    console.error("[TWILIO STATUS] Error during status update:", error);
    // Return 200 OK even on error to avoid Twilio retries
    reply.code(200).send();
  }
});

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

// Add webhook endpoint for ElevenLabs
fastify.post("/webhook/elevenlabs", async (request, reply) => {
  try {
    console.log("🔔 [ELEVENLABS] Webhook received");

    const webhookData = request.body;

    // Check for ElevenLabs specific structure
    if (
      !webhookData ||
      !webhookData.data ||
      !webhookData.data.conversation_id
    ) {
      console.error("❌ Invalid webhook data structure");
      return reply.code(400).send({ error: "Invalid webhook data" });
    }

    const { conversation_id, analysis, transcript, metadata } =
      webhookData.data;

    console.log("📞 [ELEVENLABS] Processing conversation:", conversation_id);

    // Log essential audio/transcript data
    if (transcript && transcript.length > 0) {
      console.log(
        "🎵 [ELEVENLABS] Audio transcript available:",
        transcript.length,
        "turns"
      );
      // Log first few turns for debugging
      transcript.slice(0, 3).forEach((turn, index) => {
        console.log(
          `   Turn ${index + 1}: ${turn.speaker} - ${turn.text?.substring(
            0,
            100
          )}${turn.text?.length > 100 ? "..." : ""}`
        );
      });
    }

    if (analysis?.transcript_summary) {
      console.log(
        "📝 [ELEVENLABS] Summary:",
        analysis.transcript_summary.substring(0, 200) +
          (analysis.transcript_summary.length > 200 ? "..." : "")
      );
    }

    // Find the call by conversation_id
    const { data: call, error: callError } = await supabase
      .from("calls")
      .select("*")
      .eq("conversation_id", conversation_id)
      .single();

    if (callError || !call) {
      console.error("❌ Call not found for conversation:", conversation_id);
      return reply.code(404).send({ error: "Call not found" });
    }

    // Update call with webhook data
    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (analysis) {
      if (analysis.call_successful !== undefined) {
        updateData.call_successful = analysis.call_successful;
      }
      if (analysis.transcript_summary) {
        updateData.transcript_summary = analysis.transcript_summary;
      }
      if (analysis.data_collection_results) {
        updateData.data_collection_results = analysis.data_collection_results;
      }
    }

    if (metadata) {
      if (metadata.call_duration_secs) {
        updateData.conversation_duration = metadata.call_duration_secs;
      }
      if (transcript && transcript.length > 0) {
        updateData.turn_count = transcript.length;
      }
    }

    const { error: updateError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("conversation_id", conversation_id);

    if (updateError) {
      console.error("❌ Error updating call:", updateError);
      return reply.code(500).send({ error: "Failed to update call" });
    }

    console.log("✅ [ELEVENLABS] Call updated successfully");

    // 🔍 CHECK FOR SCHEDULED CALL IN SUMMARY
    try {
      const scheduledCallInfo = await checkForScheduledCall(webhookData, call);

      if (scheduledCallInfo) {
        console.log(
          "📅 [CALENDAR] Scheduled call detected, creating calendar event"
        );
        await createCalendarEvent(scheduledCallInfo, call);
      }
    } catch (calendarError) {
      console.error("❌ Error processing calendar event:", calendarError);
    }

    // 🌐 TRANSLATE SUMMARY TO SPANISH
    try {
      const originalSummary = webhookData.data.analysis?.transcript_summary;
      if (originalSummary) {
        console.log("🌐 [TRANSLATION] Translating summary to Spanish...");
        const translatedSummary = await translateSummaryToSpanish(
          originalSummary
        );

        if (translatedSummary) {
          // Update call with translated summary
          const { error: translationError } = await supabase
            .from("calls")
            .update({
              transcript_summary_es: translatedSummary,
              updated_at: new Date().toISOString(),
            })
            .eq("conversation_id", conversation_id);

          if (translationError) {
            console.error(
              "❌ [TRANSLATION] Error saving translated summary:",
              translationError
            );
          } else {
            console.log(
              "✅ [TRANSLATION] Translated summary saved successfully"
            );
          }
        }
      }
    } catch (translationError) {
      console.error("❌ Error translating summary:", translationError);
    }

    reply.send({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("❌ Error processing webhook:", error);
    reply.code(500).send({ error: "Internal server error" });
  }
});

// API Integration endpoints for leads
fastify.post("/api/integration/leads", async (request, reply) => {
  try {
    console.log("📞 [API] POST /api/integration/leads - Creating lead");

    // Obtener API key del header
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message:
          "Incluye tu API key en el header: x-api-key o Authorization: Bearer <api_key>",
      });
    }

    // Validar API key
    const { data: apiKeyData, error: apiKeyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (apiKeyError || !apiKeyData || !apiKeyData.is_active) {
      return reply.code(401).send({
        error: "API key inválida o inactiva",
        message: "Verifica que tu API key sea correcta y esté activa",
      });
    }

    const userId = apiKeyData.user_id;

    // Obtener datos del body
    const body = request.body;

    // Verificar si es un array (creación masiva) o un objeto (creación individual)
    const isBulkOperation = Array.isArray(body);
    const leadsData = isBulkOperation ? body : [body];

    // Validar límite de leads por petición
    if (leadsData.length > 100) {
      return reply.code(400).send({
        error: "Demasiados leads",
        message:
          "Máximo 100 leads por petición. Divide tu lote en peticiones más pequeñas.",
      });
    }

    // Validar y procesar cada lead
    const processedLeads = [];
    const errors = [];

    for (let i = 0; i < leadsData.length; i++) {
      const leadData = leadsData[i];
      const {
        name,
        phone,
        email,
        auto_call = false,
        source = "api",
        notes,
        external_id,
      } = leadData;

      // Validar campos requeridos
      if (!name || !phone || !email) {
        errors.push({
          index: i,
          error: "Campos requeridos faltantes",
          message: "name, phone y email son campos obligatorios",
        });
        continue;
      }

      // Validar formato de teléfono
      const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, "");
      if (!/^\d{7,15}$/.test(cleanPhone)) {
        errors.push({
          index: i,
          error: "Teléfono inválido",
          message: "El teléfono debe tener entre 7 y 15 dígitos",
        });
        continue;
      }

      // Validar formato de email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({
          index: i,
          error: "Email inválido",
          message: "El formato del email no es válido",
        });
        continue;
      }

      // Limpiar y formatear el teléfono
      const formattedPhone = cleanPhone.startsWith("+")
        ? cleanPhone
        : `+${cleanPhone}`;

      processedLeads.push({
        index: i,
        data: {
          name,
          phone: formattedPhone,
          email,
          auto_call,
          source,
          notes: notes || null,
          external_id: external_id || null,
        },
      });
    }

    // Si hay errores de validación, retornarlos
    if (errors.length > 0) {
      return reply.code(400).send({
        error: "Errores de validación",
        errors,
        message: `${errors.length} lead(s) con errores de validación`,
      });
    }

    // Procesar leads en lotes para mejor rendimiento
    const results = [];
    const batchSize = 10;

    for (let i = 0; i < processedLeads.length; i += batchSize) {
      const batch = processedLeads.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async ({ index, data }) => {
          try {
            // Buscar lead existente por external_id, email o teléfono
            let existingLead = null;

            if (data.external_id) {
              const { data: externalLead } = await supabase
                .from("leads")
                .select("id")
                .eq("user_id", userId)
                .eq("external_id", data.external_id)
                .maybeSingle();

              existingLead = externalLead;
            }

            if (!existingLead) {
              const { data: emailLead } = await supabase
                .from("leads")
                .select("id")
                .eq("user_id", userId)
                .eq("email", data.email)
                .maybeSingle();

              existingLead = emailLead;
            }

            if (!existingLead) {
              const { data: phoneLead } = await supabase
                .from("leads")
                .select("id")
                .eq("user_id", userId)
                .eq("phone", data.phone)
                .maybeSingle();

              existingLead = phoneLead;
            }

            if (existingLead) {
              // Actualizar lead existente
              const { data: updatedLead, error: updateError } = await supabase
                .from("leads")
                .update({
                  name: data.name,
                  phone: data.phone,
                  auto_call: data.auto_call,
                  source: data.source,
                  notes: data.notes,
                  external_id: data.external_id,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", existingLead.id)
                .select()
                .single();

              if (updateError) {
                return {
                  index,
                  success: false,
                  error: "Error al actualizar lead existente",
                  details: updateError.message,
                };
              }

              // NUEVO: Si auto_call es true, agregar a la cola si no está pendiente
              if (data.auto_call) {
                // Buscar si ya está en la cola pendiente
                const { data: queueItem, error: queueError } = await supabase
                  .from("call_queue")
                  .select("id")
                  .eq("user_id", userId)
                  .eq("lead_id", existingLead.id)
                  .eq("status", "pending")
                  .maybeSingle();
                if (!queueItem) {
                  // Obtener la última posición en la cola
                  const { data: existingQueue } = await supabase
                    .from("call_queue")
                    .select("queue_position")
                    .order("queue_position", { ascending: false })
                    .limit(1);
                  const nextPosition =
                    existingQueue && existingQueue.length > 0
                      ? (existingQueue[0]?.queue_position || 0) + 1
                      : 1;
                  await supabase.from("call_queue").insert({
                    user_id: userId,
                    lead_id: existingLead.id,
                    queue_position: nextPosition,
                    status: "pending",
                    created_at: new Date().toISOString(),
                  });
                }
              }

              return {
                index,
                success: true,
                data: updatedLead,
                action: "updated",
              };
            } else {
              // Crear nuevo lead
              const { data: newLead, error: insertError } = await supabase
                .from("leads")
                .insert({
                  user_id: userId,
                  name: data.name,
                  phone: data.phone,
                  email: data.email,
                  auto_call: data.auto_call,
                  source: data.source,
                  notes: data.notes,
                  external_id: data.external_id,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .select()
                .single();

              if (insertError) {
                return {
                  index,
                  success: false,
                  error: "Error al crear lead",
                  details: insertError.message,
                };
              }

              // NUEVO: Si auto_call es true, agregar a la cola automáticamente
              if (data.auto_call) {
                try {
                  // Obtener la última posición en la cola
                  const { data: existingQueue } = await supabase
                    .from("call_queue")
                    .select("queue_position")
                    .order("queue_position", { ascending: false })
                    .limit(1);
                  const nextPosition =
                    existingQueue && existingQueue.length > 0
                      ? (existingQueue[0]?.queue_position || 0) + 1
                      : 1;

                  await supabase.from("call_queue").insert({
                    user_id: userId,
                    lead_id: newLead.id,
                    queue_position: nextPosition,
                    status: "pending",
                    created_at: new Date().toISOString(),
                  });

                  console.log(
                    `✅ [API] Lead ${newLead.id} agregado automáticamente a la cola de llamadas`
                  );
                } catch (queueError) {
                  console.error(
                    `❌ [API] Error al agregar lead ${newLead.id} a la cola:`,
                    queueError
                  );
                  // No fallamos la creación del lead por un error en la cola
                }
              }

              return {
                index,
                success: true,
                data: newLead,
                action: "created",
              };
            }
          } catch (error) {
            return {
              index,
              success: false,
              error: "Error inesperado",
              details:
                error instanceof Error ? error.message : "Error desconocido",
            };
          }
        })
      );

      results.push(...batchResults);
    }

    // Preparar respuesta
    const successfulLeads = results.filter((r) => r.success);
    const failedLeads = results.filter((r) => !r.success);

    if (isBulkOperation) {
      return reply.send({
        success: true,
        message: `Procesamiento completado. ${successfulLeads.length} exitosos, ${failedLeads.length} errores`,
        data: {
          total: leadsData.length,
          successful: successfulLeads.length,
          failed: failedLeads.length,
          results: results,
        },
      });
    } else {
      const result = results[0];
      if (result.success) {
        return reply.send({
          success: true,
          message: "Lead creado exitosamente",
          data: result.data,
        });
      } else {
        return reply.code(400).send({
          success: false,
          error: result.error,
          message: result.details,
        });
      }
    }
  } catch (error) {
    console.error("❌ [API] Error en POST /api/integration/leads:", error);
    return reply.code(500).send({
      error: "Error interno del servidor",
      message: "Error inesperado al procesar la petición",
    });
  }
});

fastify.get("/api/integration/leads", async (request, reply) => {
  try {
    console.log("📞 [API] GET /api/integration/leads - Getting leads");

    // Obtener API key del header
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message:
          "Incluye tu API key en el header: x-api-key o Authorization: Bearer <api_key>",
      });
    }

    // Validar API key
    const { data: apiKeyData, error: apiKeyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    if (apiKeyError || !apiKeyData || !apiKeyData.is_active) {
      return reply.code(401).send({
        error: "API key inválida o inactiva",
        message: "Verifica que tu API key sea correcta y esté activa",
      });
    }

    const userId = apiKeyData.user_id;

    // Obtener parámetros de consulta
    const page = parseInt(request.query.page || "1");
    const limit = Math.min(parseInt(request.query.limit || "10"), 100);
    const search = request.query.search || "";
    const source = request.query.source || "";
    const externalId = request.query.external_id || "";

    // Construir consulta
    let query = supabase
      .from("leads")
      .select("*", { count: "exact" })
      .eq("user_id", userId);

    // Aplicar filtros
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
      );
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (externalId) {
      query = query.eq("external_id", externalId);
    }

    // Aplicar paginación
    const offset = (page - 1) * limit;
    query = query
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    const { data: leads, error, count } = await query;

    if (error) {
      return reply.code(500).send({
        error: "Error al obtener leads",
        message: error.message,
      });
    }

    return reply.send({
      success: true,
      data: {
        leads: leads || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          total_pages: Math.ceil((count || 0) / limit),
        },
      },
    });
  } catch (error) {
    console.error("❌ [API] Error en GET /api/integration/leads:", error);
    return reply.code(500).send({
      error: "Error interno del servidor",
      message: "Error inesperado al obtener leads",
    });
  }
});

// Start the server
const start = async () => {
  try {
    console.log("🚀 Server starting on port", PORT);

    // Inicializar bucket de grabaciones
    console.log("🪣 [STARTUP] Initializing recording storage...");
    await initializeRecordingBucket();

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log("✅ Server running");
  } catch (err) {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  }
};

// Iniciar el servidor al final del archivo
if (!fastify.server.listening) {
  start();
}

// Function to check for scheduled call in ElevenLabs summary
async function checkForScheduledCall(webhookData, call) {
  try {
    console.log(
      "🔍 [CALENDAR] ===== INICIO DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
    );
    console.log("📞 [CALENDAR] Call SID:", call.call_sid);
    console.log("👤 [CALENDAR] User ID:", call.user_id);
    console.log("📋 [CALENDAR] Lead ID:", call.lead_id);
    console.log("📊 [CALENDAR] Call Status:", call.status);
    console.log(
      "✅ [CALENDAR] Call Successful:",
      webhookData.data.analysis?.call_successful
    );

    // Get the transcript summary from ElevenLabs
    const summary = webhookData.data.analysis?.transcript_summary || "";
    console.log("📄 [CALENDAR] Summary length:", summary.length);
    console.log(
      "📄 [CALENDAR] Summary preview:",
      summary.substring(0, 200) + (summary.length > 200 ? "..." : "")
    );

    if (!summary || summary.trim() === "") {
      console.log(
        "❌ [CALENDAR] No summary available - skipping calendar check"
      );
      return null;
    }

    // Check if call was successful (this indicates successful scheduling)
    const isCallSuccessful =
      webhookData.data.analysis?.call_successful === "success";
    console.log("🎯 [CALENDAR] Call successful indicator:", isCallSuccessful);

    // If call is successful, proceed directly to extract date/time from summary
    if (isCallSuccessful) {
      console.log(
        "✅ [CALENDAR] Call marked as successful - proceeding with date/time extraction"
      );
    } else {
      // Only check for scheduling keywords if call is not marked as successful
      const schedulingKeywords = [
        "scheduled a call",
        "programó una llamada",
        "agendó una llamada",
        "scheduled for",
        "programado para",
        "agendado para",
        "confirmed the time",
        "confirmó la hora",
        "confirmed for",
        "confirmó para",
        "set up a call",
        "programó una cita",
        "agendó una cita",
        "booked a call",
        "reservó una llamada",
        "scheduled it for",
        "programó para",
        "agendó para",
        "scheduled for",
        "programado el",
        "agendado el",
        "confirmed appointment",
        "confirmó la cita",
        "set appointment",
        "estableció cita",
        "made appointment",
        "hizo cita",
        "booked appointment",
        "reservó cita",
        "scheduled appointment",
        "programó cita",
        "agendó cita",
        "scheduled a call for",
        "programó una llamada para",
        "agendó una llamada para",
        "set up a call for",
        "programó una cita para",
        "agendó una cita para",
        "booked a call for",
        "reservó una llamada para",
        "made a call for",
        "hizo una llamada para",
        "arranged a call for",
        "organizó una llamada para",
        "planned a call for",
        "planificó una llamada para",
      ];

      console.log("🔍 [CALENDAR] Checking for scheduling keywords...");
      const foundKeywords = [];

      schedulingKeywords.forEach((keyword) => {
        if (summary.toLowerCase().includes(keyword.toLowerCase())) {
          foundKeywords.push(keyword);
        }
      });

      console.log("🎯 [CALENDAR] Found keywords:", foundKeywords);

      if (foundKeywords.length === 0) {
        console.log(
          "❌ [CALENDAR] No scheduling keywords found and call not marked as successful - skipping calendar check"
        );
        return null;
      }

      console.log(
        "✅ [CALENDAR] Scheduling keywords detected - proceeding with date/time extraction"
      );
    }

    // Extract date and time using direct text parsing
    const dateTimeInfo = await extractDateTimeFromSummary(summary);

    if (dateTimeInfo) {
      console.log(
        "✅ [CALENDAR] Date/time extracted successfully:",
        dateTimeInfo
      );

      // Get lead information
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("name, phone, email")
        .eq("id", call.lead_id)
        .single();

      if (leadError || !lead) {
        console.error("❌ [CALENDAR] Error fetching lead:", leadError);
        return null;
      }

      console.log("✅ [CALENDAR] Lead information retrieved:", {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
      });

      const result = {
        ...dateTimeInfo,
        lead: lead,
        call: call,
        summary: summary,
      };

      console.log("🎉 [CALENDAR] ===== FINAL RESULT =====");
      console.log("📅 [CALENDAR] Date:", result.date);
      console.log("⏰ [CALENDAR] Time:", result.time);
      console.log("🌍 [CALENDAR] Timezone:", result.timezone);
      console.log("👤 [CALENDAR] Lead:", result.lead.name);
      console.log("📞 [CALENDAR] Phone:", result.lead.phone);
      console.log("📧 [CALENDAR] Email:", result.lead.email);
      console.log(
        "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
      );

      return result;
    } else {
      console.log("❌ [CALENDAR] Could not extract date/time from summary");
      console.log(
        "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
      );
    }

    return null;
  } catch (error) {
    console.error("❌ [CALENDAR] Error checking for scheduled call:", error);
    console.log(
      "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA (ERROR) ====="
    );
    return null;
  }
}

// Function to extract date and time from summary using direct text parsing
async function extractDateTimeFromSummary(summary) {
  try {
    console.log(
      "🔍 [CALENDAR][EXTRACT] ===== INICIO DE EXTRACCIÓN DE FECHA/HORA ====="
    );
    console.log("📄 [CALENDAR][EXTRACT] Summary to analyze:", summary);

    if (!summary || summary.trim() === "") {
      console.log("❌ [CALENDAR][EXTRACT] No summary available");
      return null;
    }

    const text = summary.toLowerCase();
    console.log(
      "📝 [CALENDAR][EXTRACT] Normalized text (first 300 chars):",
      text.substring(0, 300)
    );

    // Patterns for date extraction
    const datePatterns = [
      // Specific dates: "Friday", "Monday", etc.
      {
        pattern:
          /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes|sábado|domingo)/gi,
        type: "day",
      },
      // Tomorrow
      { pattern: /(tomorrow|mañana)/gi, type: "tomorrow" },
      // Next day: "next Friday", "next Monday"
      {
        pattern:
          /next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes|sábado|domingo)/gi,
        type: "next_day",
      },
      // Specific date formats: "January 15th", "15th of January", "15/01", "01/15"
      {
        pattern:
          /(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{1,2})(?:st|nd|rd|th)?/gi,
        type: "month_day",
      },
      {
        pattern:
          /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi,
        type: "day_month",
      },
      { pattern: /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/gi, type: "date_slash" },
      { pattern: /(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?/gi, type: "date_dash" },
    ];

    // Patterns for time extraction
    const timePatterns = [
      // 24-hour format: "14:30", "14.30", "1430"
      { pattern: /(\d{1,2}):(\d{2})/gi, type: "24hour" },
      { pattern: /(\d{1,2})\.(\d{2})/gi, type: "24hour_dot" },
      { pattern: /(\d{4})/gi, type: "24hour_compact" },
      // 12-hour format: "2:30 PM", "2:30pm", "2 PM", "2pm"
      { pattern: /(\d{1,2}):(\d{2})\s*(am|pm)/gi, type: "12hour" },
      { pattern: /(\d{1,2})\s*(am|pm)/gi, type: "12hour_no_minutes" },
      // Spanish time formats: "2:30 de la tarde", "2:30 de la mañana"
      {
        pattern: /(\d{1,2}):(\d{2})\s*(?:de\s+la\s+)?(mañana|tarde|noche)/gi,
        type: "spanish_time",
      },
      {
        pattern: /(\d{1,2})\s*(?:de\s+la\s+)?(mañana|tarde|noche)/gi,
        type: "spanish_time_no_minutes",
      },
    ];

    let extractedDate = null;
    let extractedTime = null;

    console.log("🔍 [CALENDAR][EXTRACT] Searching for date patterns...");

    // Extract date
    for (const datePattern of datePatterns) {
      const matches = [...text.matchAll(datePattern.pattern)];
      if (matches.length > 0) {
        const match = matches[0];
        console.log(
          `📅 [CALENDAR][EXTRACT] Date pattern found: ${datePattern.type}`,
          match
        );

        extractedDate = parseDateFromMatch(match, datePattern.type);
        if (extractedDate) {
          console.log(
            `✅ [CALENDAR][EXTRACT] Date extracted: ${extractedDate}`
          );
          break;
        } else {
          console.log(
            `❌ [CALENDAR][EXTRACT] Failed to parse date from pattern: ${datePattern.type}`
          );
        }
      }
    }

    console.log("🔍 [CALENDAR][EXTRACT] Searching for time patterns...");

    // Extract time
    for (const timePattern of timePatterns) {
      const matches = [...text.matchAll(timePattern.pattern)];
      if (matches.length > 0) {
        const match = matches[0];
        console.log(
          `⏰ [CALENDAR][EXTRACT] Time pattern found: ${timePattern.type}`,
          match
        );

        extractedTime = parseTimeFromMatch(match, timePattern.type);
        if (extractedTime) {
          console.log(
            `✅ [CALENDAR][EXTRACT] Time extracted: ${extractedTime}`
          );
          break;
        } else {
          console.log(
            `❌ [CALENDAR][EXTRACT] Failed to parse time from pattern: ${timePattern.type}`
          );
        }
      }
    }

    if (!extractedDate || !extractedTime) {
      console.log(
        "❌ [CALENDAR][EXTRACT] Could not extract complete date/time information"
      );
      console.log("📅 [CALENDAR][EXTRACT] Extracted date:", extractedDate);
      console.log("⏰ [CALENDAR][EXTRACT] Extracted time:", extractedTime);
      console.log(
        "🔍 [CALENDAR][EXTRACT] ===== FIN DE EXTRACCIÓN DE FECHA/HORA (INCOMPLETA) ====="
      );
      return null;
    }

    console.log(
      "✅ [CALENDAR][EXTRACT] Successfully extracted date and time:",
      {
        date: extractedDate,
        time: extractedTime,
      }
    );

    const result = {
      date: extractedDate,
      time: extractedTime,
      timezone: "America/New_York",
      title: "Llamada inversión inmobiliaria",
      description: "Llamada programada desde conversación telefónica",
      attendees: [],
    };

    console.log("🎉 [CALENDAR][EXTRACT] ===== RESULTADO FINAL =====");
    console.log("📅 [CALENDAR][EXTRACT] Date:", result.date);
    console.log("⏰ [CALENDAR][EXTRACT] Time:", result.time);
    console.log("🌍 [CALENDAR][EXTRACT] Timezone:", result.timezone);
    console.log(
      "🔍 [CALENDAR][EXTRACT] ===== FIN DE EXTRACCIÓN DE FECHA/HORA ====="
    );

    return result;
  } catch (error) {
    console.error("❌ [CALENDAR][EXTRACT] Error extracting date/time:", error);
    console.log(
      "🔍 [CALENDAR][EXTRACT] ===== FIN DE EXTRACCIÓN DE FECHA/HORA (ERROR) ====="
    );
    return null;
  }
}

// Helper function to parse date from regex match
function parseDateFromMatch(match, type) {
  try {
    const today = new Date();
    const currentYear = today.getFullYear();

    switch (type) {
      case "day":
        const dayName = match[1].toLowerCase();
        const dayMap = {
          monday: 1,
          lunes: 1,
          tuesday: 2,
          martes: 2,
          wednesday: 3,
          miércoles: 3,
          thursday: 4,
          jueves: 4,
          friday: 5,
          viernes: 5,
          saturday: 6,
          sábado: 6,
          sunday: 0,
          domingo: 0,
        };

        const targetDay = dayMap[dayName];
        if (targetDay === undefined) return null;

        const currentDay = today.getDay();
        let daysToAdd = targetDay - currentDay;
        if (daysToAdd <= 0) daysToAdd += 7; // Next week

        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysToAdd);

        return targetDate.toISOString().split("T")[0];

      case "tomorrow":
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow.toISOString().split("T")[0];

      case "next_day":
        const nextDayName = match[2].toLowerCase();
        const nextDayMap = {
          monday: 1,
          lunes: 1,
          tuesday: 2,
          martes: 2,
          wednesday: 3,
          miércoles: 3,
          thursday: 4,
          jueves: 4,
          friday: 5,
          viernes: 5,
          saturday: 6,
          sábado: 6,
          sunday: 0,
          domingo: 0,
        };

        const nextTargetDay = nextDayMap[nextDayName];
        if (nextTargetDay === undefined) return null;

        const nextCurrentDay = today.getDay();
        let nextDaysToAdd = nextTargetDay - nextCurrentDay;
        if (nextDaysToAdd <= 0) nextDaysToAdd += 7;

        const nextTargetDate = new Date(today);
        nextTargetDate.setDate(today.getDate() + nextDaysToAdd);

        return nextTargetDate.toISOString().split("T")[0];

      case "month_day":
        const monthName = match[1].toLowerCase();
        const day = parseInt(match[2]);
        const month = getMonthNumber(monthName);
        if (month === -1 || day < 1 || day > 31) return null;

        return `${currentYear}-${month.toString().padStart(2, "0")}-${day
          .toString()
          .padStart(2, "0")}`;

      case "day_month":
        const day2 = parseInt(match[1]);
        const monthName2 = match[2].toLowerCase();
        const month2 = getMonthNumber(monthName2);
        if (month2 === -1 || day2 < 1 || day2 > 31) return null;

        return `${currentYear}-${month2.toString().padStart(2, "0")}-${day2
          .toString()
          .padStart(2, "0")}`;

      case "date_slash":
        const month3 = parseInt(match[1]);
        const day3 = parseInt(match[2]);
        const year3 = match[3] ? parseInt(match[3]) : currentYear;
        if (month3 < 1 || month3 > 12 || day3 < 1 || day3 > 31) return null;

        return `${year3}-${month3.toString().padStart(2, "0")}-${day3
          .toString()
          .padStart(2, "0")}`;

      case "date_dash":
        const month4 = parseInt(match[1]);
        const day4 = parseInt(match[2]);
        const year4 = match[3] ? parseInt(match[3]) : currentYear;
        if (month4 < 1 || month4 > 12 || day4 < 1 || day4 > 31) return null;

        return `${year4}-${month4.toString().padStart(2, "0")}-${day4
          .toString()
          .padStart(2, "0")}`;

      default:
        return null;
    }
  } catch (error) {
    console.error("❌ [CALENDAR] Error parsing date:", error);
    return null;
  }
}

// Helper function to parse time from regex match
function parseTimeFromMatch(match, type) {
  try {
    switch (type) {
      case "24hour":
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        return `${hour.toString().padStart(2, "0")}:${minute
          .toString()
          .padStart(2, "0")}`;

      case "24hour_dot":
        const hour2 = parseInt(match[1]);
        const minute2 = parseInt(match[2]);
        if (hour2 < 0 || hour2 > 23 || minute2 < 0 || minute2 > 59) return null;
        return `${hour2.toString().padStart(2, "0")}:${minute2
          .toString()
          .padStart(2, "0")}`;

      case "24hour_compact":
        const timeStr = match[1];
        if (timeStr.length !== 4) return null;
        const hour3 = parseInt(timeStr.substring(0, 2));
        const minute3 = parseInt(timeStr.substring(2, 4));
        if (hour3 < 0 || hour3 > 23 || minute3 < 0 || minute3 > 59) return null;
        return `${hour3.toString().padStart(2, "0")}:${minute3
          .toString()
          .padStart(2, "0")}`;

      case "12hour":
        let hour4 = parseInt(match[1]);
        const minute4 = parseInt(match[2]);
        const period = match[3].toLowerCase();

        if (hour4 < 1 || hour4 > 12 || minute4 < 0 || minute4 > 59) return null;
        if (period === "pm" && hour4 !== 12) hour4 += 12;
        if (period === "am" && hour4 === 12) hour4 = 0;

        return `${hour4.toString().padStart(2, "0")}:${minute4
          .toString()
          .padStart(2, "0")}`;

      case "12hour_no_minutes":
        let hour5 = parseInt(match[1]);
        const period2 = match[2].toLowerCase();

        if (hour5 < 1 || hour5 > 12) return null;
        if (period2 === "pm" && hour5 !== 12) hour5 += 12;
        if (period2 === "am" && hour5 === 12) hour5 = 0;

        return `${hour5.toString().padStart(2, "0")}:00`;

      case "spanish_time":
        let hour6 = parseInt(match[1]);
        const minute6 = parseInt(match[2]);
        const period3 = match[3].toLowerCase();

        if (hour6 < 1 || hour6 > 12 || minute6 < 0 || minute6 > 59) return null;
        if (period3 === "tarde" || period3 === "noche") {
          if (hour6 !== 12) hour6 += 12;
        } else if (period3 === "mañana" && hour6 === 12) {
          hour6 = 0;
        }

        return `${hour6.toString().padStart(2, "0")}:${minute6
          .toString()
          .padStart(2, "0")}`;

      case "spanish_time_no_minutes":
        let hour7 = parseInt(match[1]);
        const period4 = match[2].toLowerCase();

        if (hour7 < 1 || hour7 > 12) return null;
        if (period4 === "tarde" || period4 === "noche") {
          if (hour7 !== 12) hour7 += 12;
        } else if (period4 === "mañana" && hour7 === 12) {
          hour7 = 0;
        }

        return `${hour7.toString().padStart(2, "0")}:00`;

      default:
        return null;
    }
  } catch (error) {
    console.error("❌ [CALENDAR] Error parsing time:", error);
    return null;
  }
}

// Helper function to get month number from month name
function getMonthNumber(monthName) {
  const monthMap = {
    january: 1,
    enero: 1,
    february: 2,
    febrero: 2,
    march: 3,
    marzo: 3,
    april: 4,
    abril: 4,
    may: 5,
    mayo: 5,
    june: 6,
    junio: 6,
    july: 7,
    julio: 7,
    august: 8,
    agosto: 8,
    september: 9,
    septiembre: 9,
    october: 10,
    octubre: 10,
    november: 11,
    noviembre: 11,
    december: 12,
    diciembre: 12,
  };

  return monthMap[monthName.toLowerCase()] || -1;
}

// Function to create calendar event
async function createCalendarEvent(scheduledCallInfo, call) {
  try {
    console.log("📅 [CALENDAR] Creating calendar event...");

    // Get user calendar settings
    const { data: calendarSettings, error: settingsError } = await supabase
      .from("user_calendar_settings")
      .select(
        "access_token, refresh_token, calendar_enabled, calendar_timezone"
      )
      .eq("user_id", call.user_id)
      .single();

    if (settingsError || !calendarSettings) {
      console.error(
        "❌ [CALENDAR] No calendar settings found for user:",
        call.user_id
      );
      return;
    }

    if (!calendarSettings.calendar_enabled) {
      console.log("ℹ️ [CALENDAR] Calendar not enabled for user:", call.user_id);
      return;
    }

    // Verify and refresh token if needed
    try {
      const tokenInfoResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${calendarSettings.access_token}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!tokenInfoResponse.ok) {
        console.log("🔄 [CALENDAR] Token expired, refreshing...");
        const { google } = await import("googleapis");
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
          access_token: calendarSettings.access_token,
          refresh_token: calendarSettings.refresh_token,
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        if (!credentials.access_token) {
          console.error("❌ [CALENDAR] Failed to refresh token");
          return;
        }

        // Update token in database
        await supabase
          .from("user_calendar_settings")
          .update({
            access_token: credentials.access_token,
            refresh_token:
              credentials.refresh_token || calendarSettings.refresh_token,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", call.user_id);

        calendarSettings.access_token = credentials.access_token;
        console.log("✅ [CALENDAR] Token refreshed successfully");
      }
    } catch (tokenError) {
      console.error("❌ [CALENDAR] Error refreshing token:", tokenError);
      return;
    }

    // Create calendar event
    const { google } = await import("googleapis");
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    oauth2Client.setCredentials({
      access_token: calendarSettings.access_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Get user timezone (default to America/New_York if not specified)
    const userTimeZone =
      scheduledCallInfo.timezone ||
      calendarSettings.calendar_timezone ||
      "America/New_York";

    console.log("🔍 [CALENDAR] User timezone:", userTimeZone);

    const dateTimeString = `${scheduledCallInfo.date}T${scheduledCallInfo.time}:00`;

    // Descomponer la fecha y hora para evitar ambigüedad con zonas horarias locales
    const [year, month, day] = scheduledCallInfo.date.split("-").map(Number);
    const [hour, minute] = scheduledCallInfo.time.split(":").map(Number);

    const eventDate = new Date(year, month - 1, day, hour + 4, minute);
    const endDate = new Date(eventDate.getTime() + 30 * 60 * 1000); // 30 minutos

    // Formatear fechas en formato ISO ajustado a la zona horaria del usuario
    const formatDateForGoogleCalendar = (date) => {
      return date.toISOString();
    };

    const startDateTime = formatDateForGoogleCalendar(eventDate);
    const endDateTime = formatDateForGoogleCalendar(endDate);

    console.log("🔍 [CALENDAR] Date calculations:", {
      originalDate: `${scheduledCallInfo.date}T${scheduledCallInfo.time}`,
      userTimeZone: userTimeZone,
      startDateTimeFormatted: startDateTime,
      endDateTimeFormatted: endDateTime,
    });

    // CORREGIDO: Usar el email real del cliente como invitado
    const attendees = [];
    if (scheduledCallInfo.lead && scheduledCallInfo.lead.email) {
      attendees.push({ email: scheduledCallInfo.lead.email });
    }

    const event = {
      summary: scheduledCallInfo.title,
      description: `${scheduledCallInfo.description}\n\nCliente: ${scheduledCallInfo.lead.name}`,
      start: {
        dateTime: startDateTime,
        timeZone: userTimeZone,
      },
      end: {
        dateTime: endDateTime,
        timeZone: userTimeZone,
      },
      attendees: attendees,
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 }, // 1 day before
          { method: "email", minutes: 1 * 60 }, // 1 hour before
          { method: "popup", minutes: 1 * 60 }, // 1 hour before
          { method: "popup", minutes: 15 }, // 15 minutes before
        ],
      },
    };

    console.log("📅 [CALENDAR] Creating event:", {
      title: event.summary,
      start: event.start.dateTime,
      end: event.end.dateTime,
      timezone: userTimeZone,
      attendees: event.attendees.length,
    });

    const calendarResponse = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      sendUpdates: "all",
    });

    console.log("✅ [CALENDAR] Event created successfully:", {
      eventId: calendarResponse.data.id,
      htmlLink: calendarResponse.data.htmlLink,
      start: calendarResponse.data.start,
      end: calendarResponse.data.end,
    });

    // Update call with calendar event info
    await supabase
      .from("calls")
      .update({
        calendar_event_id: calendarResponse.data.id,
        calendar_event_link: calendarResponse.data.htmlLink,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", call.conversation_id);

    console.log("✅ [CALENDAR] Call updated with calendar event info");
  } catch (error) {
    console.error("❌ [CALENDAR] Error creating calendar event:", error);
  }
}

// Función para reanudar la llamada después de pausa
const resumeTwilioCall = async (callSid, delayMs = 1000) => {
  if (!callSid) return;
  setTimeout(async () => {
    try {
      await twilioClient.calls(callSid).update({
        url: `https://${RAILWAY_PUBLIC_DOMAIN}/twiml/resume`,
        method: "POST",
      });
      console.log(`🔄 [TWILIO] Llamada reanudada para callSid: ${callSid}`);
    } catch (err) {
      console.error("❌ [TWILIO] Error reanudando llamada:", err);
    }
  }, delayMs);
};

// Function to translate transcript summary to Spanish using OpenAI
async function translateSummaryToSpanish(summary) {
  try {
    console.log("🌐 [TRANSLATION] Starting translation of summary to Spanish");

    if (!summary || summary.trim() === "") {
      console.log("❌ [TRANSLATION] No summary to translate");
      return null;
    }

    const { OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "Eres un traductor profesional. Traduce el siguiente resumen de conversación telefónica al español de manera natural y profesional, manteniendo el contexto y la información importante.",
        },
        {
          role: "user",
          content: `Traduce este resumen al español: "${summary}"`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const translatedSummary = response.choices[0]?.message?.content?.trim();

    if (translatedSummary) {
      console.log("✅ [TRANSLATION] Summary translated successfully");
      console.log(
        "📝 [TRANSLATION] Original:",
        summary.substring(0, 100) + "..."
      );
      console.log(
        "📝 [TRANSLATION] Translated:",
        translatedSummary.substring(0, 100) + "..."
      );
      return translatedSummary;
    } else {
      console.log("❌ [TRANSLATION] No translation received from OpenAI");
      return null;
    }
  } catch (error) {
    console.error("❌ [TRANSLATION] Error translating summary:", error);
    return null;
  }
}

// Add webhook endpoint for Stripe (handles user_subscriptions directly)
fastify.post("/webhook/stripe", async (request, reply) => {
  try {
    console.log("💳 [STRIPE] Webhook received, processing subscription...");
    console.log(
      "📋 [STRIPE] Request headers:",
      JSON.stringify(request.headers, null, 2)
    );
    console.log(
      "📋 [STRIPE] Request body length:",
      request.rawBody?.length || 0
    );

    // Convert Buffer to string for logging
    const rawBodyString = request.rawBody
      ? request.rawBody.toString("utf8")
      : "";
    console.log(
      "📋 [STRIPE] Request body preview:",
      rawBodyString.substring(0, 200) + "..."
    );

    const rawBody = request.rawBody;
    const signature = request.headers["stripe-signature"];

    console.log("🔍 [STRIPE] Signature header:", signature);
    console.log("🔍 [STRIPE] Raw body exists:", !!rawBody);
    console.log(
      "🔍 [STRIPE] Webhook secret configured:",
      !!process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log(
      "🔍 [STRIPE] Webhook secret preview:",
      process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 20) + "..."
    );

    if (!signature) {
      console.error("❌ [STRIPE] No Stripe signature found");
      return reply.code(400).send({ error: "No signature" });
    }

    if (!rawBody) {
      console.error("❌ [STRIPE] No raw body found");
      return reply.code(400).send({ error: "No raw body" });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("❌ [STRIPE] No webhook secret configured");
      return reply.code(500).send({ error: "Webhook secret not configured" });
    }

    // Import Stripe dynamically
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-04-30.basil",
    });

    // Verify the webhook signature
    let event;
    try {
      console.log("🔍 [STRIPE] Attempting signature verification...");
      console.log("🔍 [STRIPE] Raw body type:", typeof rawBody);
      console.log("🔍 [STRIPE] Raw body is Buffer:", Buffer.isBuffer(rawBody));

      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("✅ [STRIPE] Webhook signature verified");
      console.log("📡 [STRIPE] Event type:", event.type);
    } catch (err) {
      console.error("❌ [STRIPE] Webhook signature verification failed:");
      console.error("   Error message:", err.message);
      console.error("   Error code:", err.code);
      console.error(
        "   Expected signature format:",
        signature?.substring(0, 50) + "..."
      );
      console.error(
        "   Webhook secret used:",
        process.env.STRIPE_WEBHOOK_SECRET?.substring(0, 20) + "..."
      );
      return reply.code(400).send({ error: "Invalid signature" });
    }

    // Process different event types
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event.data.object, stripe);
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event.data.object, stripe);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object, stripe);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;

      default:
        console.log(`ℹ️ [STRIPE] Unhandled event type: ${event.type}`);
    }

    return reply.send({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("❌ [STRIPE] Error handling Stripe webhook:", error);
    return reply.code(500).send({ error: "Internal server error" });
  }
});

// Handle checkout.session.completed event
async function handleCheckoutSessionCompleted(session, stripe) {
  try {
    console.log("✅ [STRIPE] Processing checkout.session.completed");
    console.log("📋 [STRIPE] Session details:", {
      id: session.id,
      customer: session.customer,
      subscription: session.subscription,
      customer_email: session.customer_email,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    });

    if (!session.subscription) {
      console.log("❌ [STRIPE] No subscription found in session");
      return;
    }

    // Get subscription details from Stripe using the subscription ID
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription
    );
    console.log("📦 [STRIPE] Subscription retrieved:", subscription.id);
    console.log("📦 [STRIPE] Subscription timestamps:", {
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
    });

    // Get product and price details from the subscription
    const price = await stripe.prices.retrieve(
      subscription.items.data[0].price.id
    );
    const product = await stripe.products.retrieve(price.product);

    console.log("📦 [STRIPE] Product details:", {
      name: product.name,
      metadata: product.metadata,
    });

    // Find the subscription plan by product name
    let planId = null;
    let minutesPerMonth = 250; // Default fallback

    if (product.name) {
      const { data: plan, error: planError } = await supabase
        .from("subscription_plans")
        .select("id, minutes_per_month")
        .eq("name", product.name)
        .eq("is_active", true)
        .single();

      if (planError) {
        console.warn("⚠️ [STRIPE] Plan not found by name:", product.name);
        console.warn("⚠️ [STRIPE] Plan error:", planError.message);

        // Try to find plan by stripe_price_id as fallback
        const { data: planByPriceId } = await supabase
          .from("subscription_plans")
          .select("id, minutes_per_month")
          .eq("stripe_price_id", price.id)
          .eq("is_active", true)
          .single();

        if (planByPriceId) {
          planId = planByPriceId.id;
          minutesPerMonth = planByPriceId.minutes_per_month;
          console.log(
            "✅ [STRIPE] Plan found by stripe_price_id:",
            planByPriceId.id
          );
        } else {
          console.warn(
            "⚠️ [STRIPE] Plan not found by stripe_price_id either:",
            price.id
          );
          // Use default values
          minutesPerMonth = parseInt(
            product.metadata?.minutes_per_month ||
              price.metadata?.minutes_per_month ||
              "250"
          );
        }
      } else {
        planId = plan.id;
        minutesPerMonth = plan.minutes_per_month;
        console.log("✅ [STRIPE] Plan found by name:", plan.id);
      }
    } else {
      console.warn("⚠️ [STRIPE] Product name is empty, using default values");
      minutesPerMonth = parseInt(
        product.metadata?.minutes_per_month ||
          price.metadata?.minutes_per_month ||
          "250"
      );
    }

    console.log("📦 [STRIPE] Final plan details:", {
      planId: planId,
      minutesPerMonth: minutesPerMonth,
      productName: product.name,
    });

    // Find user by customer email or customer ID
    let user = null;

    if (session.customer_email) {
      const { data: userByEmail } = await supabase
        .from("users")
        .select("*")
        .eq("email", session.customer_email)
        .single();

      if (userByEmail) {
        user = userByEmail;
        console.log("✅ [STRIPE] User found by email:", user.id);
      }
    }

    if (!user && session.customer) {
      const { data: userByCustomerId } = await supabase
        .from("users")
        .select("*")
        .eq("stripe_customer_id", session.customer)
        .single();

      if (userByCustomerId) {
        user = userByCustomerId;
        console.log("✅ [STRIPE] User found by customer ID:", user.id);
      }
    }

    if (!user) {
      console.error("❌ [STRIPE] User not found for session:", session.id);
      return;
    }

    // Update user's stripe_customer_id if not set
    if (!user.stripe_customer_id && session.customer) {
      await supabase
        .from("users")
        .update({
          stripe_customer_id: session.customer,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);

      console.log("✅ [STRIPE] Updated user stripe_customer_id");
    }

    // Helper function to safely convert Stripe timestamp to ISO string
    const convertStripeTimestamp = (timestamp) => {
      if (!timestamp || typeof timestamp !== "number") {
        console.warn("⚠️ [STRIPE] Invalid timestamp:", timestamp);
        return new Date().toISOString(); // Fallback to current time
      }

      try {
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) {
          console.warn("⚠️ [STRIPE] Invalid date from timestamp:", timestamp);
          return new Date().toISOString(); // Fallback to current time
        }
        return date.toISOString();
      } catch (error) {
        console.error("❌ [STRIPE] Error converting timestamp:", error);
        return new Date().toISOString(); // Fallback to current time
      }
    };

    // Check if subscription already exists
    const { data: existingSubscription } = await supabase
      .from("user_subscriptions")
      .select("*")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    if (existingSubscription) {
      console.log("ℹ️ [STRIPE] Subscription already exists, updating...");

      await supabase
        .from("user_subscriptions")
        .update({
          plan_id: planId,
          status: subscription.status,
          current_period_start: convertStripeTimestamp(
            subscription.current_period_start
          ),
          current_period_end: convertStripeTimestamp(
            subscription.current_period_end
          ),
          cancel_at_period_end: subscription.cancel_at_period_end,
          minutes_per_month: minutesPerMonth,
          product_name: product.name,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingSubscription.id);

      console.log("✅ [STRIPE] Subscription updated");
    } else {
      console.log("🆕 [STRIPE] Creating new subscription...");

      // Create new subscription record
      const { data: newSubscription, error: insertError } = await supabase
        .from("user_subscriptions")
        .insert({
          user_id: user.id,
          plan_id: planId,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: session.customer,
          status: subscription.status,
          current_period_start: convertStripeTimestamp(
            subscription.current_period_start
          ),
          current_period_end: convertStripeTimestamp(
            subscription.current_period_end
          ),
          cancel_at_period_end: subscription.cancel_at_period_end,
          minutes_per_month: minutesPerMonth,
          product_name: product.name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.error("❌ [STRIPE] Error creating subscription:", insertError);
        return;
      }

      console.log("✅ [STRIPE] New subscription created:", newSubscription.id);
    }

    // Add minutes to user's available_minutes (for both new and existing subscriptions)
    console.log("💰 [STRIPE] Adding minutes to user account...");

    // Get current user minutes
    const { data: currentUser, error: userError } = await supabase
      .from("users")
      .select("available_minutes")
      .eq("id", user.id)
      .single();

    if (userError) {
      console.error(
        "❌ [STRIPE] Error getting current user minutes:",
        userError
      );
      return;
    }

    const currentSeconds = currentUser.available_minutes || 0;
    const secondsToAdd = minutesPerMonth * 60; // Convert minutes to seconds
    const newTotalSeconds = secondsToAdd; // Clear existing and set to new amount

    console.log("💰 [STRIPE] Minutes calculation:", {
      currentSeconds: currentSeconds,
      addingMinutes: minutesPerMonth,
      addingSeconds: secondsToAdd,
      addingMinutes: minutesPerMonth,
      newTotalSeconds: newTotalSeconds,
    });

    // Update user's available minutes
    const { error: updateMinutesError } = await supabase
      .from("users")
      .update({
        available_minutes: newTotalSeconds,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateMinutesError) {
      console.error(
        "❌ [STRIPE] Error updating user minutes:",
        updateMinutesError
      );
      return;
    }

    console.log("✅ [STRIPE] User minutes updated successfully:", {
      userId: user.id,
      previousSeconds: currentSeconds,
      addedMinutes: minutesPerMonth,
      newTotalSeconds: newTotalSeconds,
    });

    // Sync referral data
    await syncReferralData(user.id, {
      plan_name: product.name,
      status: subscription.status,
      minutes_per_month: minutesPerMonth,
    });
  } catch (error) {
    console.error("❌ [STRIPE] Error processing checkout session:", error);
  }
}

// Handle invoice.payment_succeeded event
async function handleInvoicePaymentSucceeded(invoice, stripe) {
  try {
    console.log("✅ [STRIPE] Processing invoice.payment_succeeded");

    // Extract subscription ID from different possible locations
    let subscriptionId = invoice.subscription;

    // If not found directly, check in parent.subscription_details
    if (!subscriptionId && invoice.parent?.subscription_details?.subscription) {
      subscriptionId = invoice.parent.subscription_details.subscription;
    }

    // Also check in lines for subscription items
    if (!subscriptionId && invoice.lines?.data?.length > 0) {
      const subscriptionLine = invoice.lines.data.find(
        (line) => line.parent?.subscription_item_details?.subscription
      );
      if (subscriptionLine) {
        subscriptionId =
          subscriptionLine.parent.subscription_item_details.subscription;
      }
    }

    console.log("📋 [STRIPE] Invoice details:", {
      id: invoice.id,
      customer: invoice.customer,
      subscription: subscriptionId,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      billing_reason: invoice.billing_reason,
    });

    if (!subscriptionId) {
      console.log("❌ [STRIPE] No subscription found in invoice");
      console.log("🔍 [STRIPE] Invoice structure debug:", {
        hasDirectSubscription: !!invoice.subscription,
        hasParentSubscription:
          !!invoice.parent?.subscription_details?.subscription,
        parentType: invoice.parent?.type,
        linesCount: invoice.lines?.data?.length || 0,
        firstLineParent: invoice.lines?.data?.[0]?.parent?.type,
      });
      return;
    }

    // Get subscription details
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    // Helper function to safely convert Stripe timestamp to ISO string
    const convertStripeTimestamp = (timestamp) => {
      if (!timestamp || typeof timestamp !== "number") {
        console.warn("⚠️ [STRIPE] Invalid timestamp:", timestamp);
        return new Date().toISOString(); // Fallback to current time
      }

      try {
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) {
          console.warn("⚠️ [STRIPE] Invalid date from timestamp:", timestamp);
          return new Date().toISOString(); // Fallback to current time
        }
        return date.toISOString();
      } catch (error) {
        console.error("❌ [STRIPE] Error converting timestamp:", error);
        return new Date().toISOString(); // Fallback to current time
      }
    };

    // Get the user subscription record
    const { data: userSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("user_id, minutes_per_month, plan_id")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    if (subscriptionError || !userSubscription) {
      console.error(
        "❌ [STRIPE] Error getting user subscription:",
        subscriptionError
      );
      return;
    }

    console.log("📦 [STRIPE] User subscription found:", {
      userId: userSubscription.user_id,
      minutesPerMonth: userSubscription.minutes_per_month,
      planId: userSubscription.plan_id,
    });

    // Update subscription status
    const { error: updateError } = await supabase
      .from("user_subscriptions")
      .update({
        status: subscription.status,
        current_period_start: convertStripeTimestamp(
          subscription.current_period_start
        ),
        current_period_end: convertStripeTimestamp(
          subscription.current_period_end
        ),
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (updateError) {
      console.error("❌ [STRIPE] Error updating subscription:", updateError);
      return;
    }

    console.log("✅ [STRIPE] Subscription updated for payment");

    // Add minutes to user's account for monthly renewal
    console.log("💰 [STRIPE] Adding minutes for monthly renewal...");

    // Get current user minutes
    const { data: currentUser, error: userError } = await supabase
      .from("users")
      .select("available_minutes")
      .eq("id", userSubscription.user_id)
      .single();

    if (userError) {
      console.error(
        "❌ [STRIPE] Error getting current user minutes:",
        userError
      );
      return;
    }

    const currentSeconds = currentUser.available_minutes || 0;
    const minutesToAdd = userSubscription.minutes_per_month || 250; // Default fallback
    const secondsToAdd = minutesToAdd * 60; // Convert minutes to seconds
    const newTotalSeconds = secondsToAdd; // Clear existing and set to new amount

    console.log("💰 [STRIPE] Monthly renewal minutes calculation:", {
      currentSeconds: currentSeconds,
      addingMinutes: minutesPerMonth,
      addingSeconds: secondsToAdd,
      addingMinutes: minutesToAdd,
      newTotalSeconds: newTotalSeconds,
    });

    // Update user's available minutes
    const { error: updateMinutesError } = await supabase
      .from("users")
      .update({
        available_minutes: newTotalSeconds,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userSubscription.user_id);

    if (updateMinutesError) {
      console.error(
        "❌ [STRIPE] Error updating user minutes for renewal:",
        updateMinutesError
      );
      return;
    }

    console.log("✅ [STRIPE] Monthly renewal minutes added successfully:", {
      userId: userSubscription.user_id,
      previousSeconds: currentSeconds,
      addedMinutes: minutesToAdd,
      addedSeconds: secondsToAdd,
      newTotalSeconds: newTotalSeconds,
    });

    // Sync referral data
    await syncReferralData(userSubscription.user_id);
  } catch (error) {
    console.error("❌ [STRIPE] Error processing invoice payment:", error);
  }
}

// Handle invoice.payment_failed event
async function handleInvoicePaymentFailed(invoice, stripe) {
  try {
    console.log("❌ [STRIPE] Processing invoice.payment_failed");

    // Extract subscription ID from different possible locations (same logic as payment_succeeded)
    let subscriptionId = invoice.subscription;

    if (!subscriptionId && invoice.parent?.subscription_details?.subscription) {
      subscriptionId = invoice.parent.subscription_details.subscription;
    }

    if (!subscriptionId && invoice.lines?.data?.length > 0) {
      const subscriptionLine = invoice.lines.data.find(
        (line) => line.parent?.subscription_item_details?.subscription
      );
      if (subscriptionLine) {
        subscriptionId =
          subscriptionLine.parent.subscription_item_details.subscription;
      }
    }

    console.log("📋 [STRIPE] Failed invoice details:", {
      id: invoice.id,
      customer: invoice.customer,
      subscription: subscriptionId,
      amount_due: invoice.amount_due,
      currency: invoice.currency,
      billing_reason: invoice.billing_reason,
      attempt_count: invoice.attempt_count,
      next_payment_attempt: invoice.next_payment_attempt,
    });

    if (!subscriptionId) {
      console.log("❌ [STRIPE] No subscription found in failed invoice");
      return;
    }

    // Get subscription details
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    // Get the user subscription record
    const { data: userSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("user_id, minutes_per_month, plan_id")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    if (subscriptionError || !userSubscription) {
      console.error(
        "❌ [STRIPE] Error getting user subscription for failed payment:",
        subscriptionError
      );
      return;
    }

    console.log("📦 [STRIPE] User subscription found for failed payment:", {
      userId: userSubscription.user_id,
      minutesPerMonth: userSubscription.minutes_per_month,
      planId: userSubscription.plan_id,
    });

    // Update subscription status to past_due or incomplete
    const newStatus =
      subscription.status === "past_due" ? "past_due" : "incomplete";

    const { error: updateError } = await supabase
      .from("user_subscriptions")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (updateError) {
      console.error(
        "❌ [STRIPE] Error updating subscription status for failed payment:",
        updateError
      );
      return;
    }

    console.log(
      `✅ [STRIPE] Subscription marked as ${newStatus} due to payment failure`
    );

    // Check if this is a final failure (no more retry attempts)
    const isFinalFailure =
      !invoice.next_payment_attempt ||
      (invoice.attempt_count && invoice.attempt_count >= 4);

    if (isFinalFailure) {
      console.log(
        "💰 [STRIPE] Final payment failure - resetting user minutes to 0..."
      );

      // Get current user minutes for logging
      const { data: currentUser, error: userError } = await supabase
        .from("users")
        .select("available_minutes")
        .eq("id", userSubscription.user_id)
        .single();

      if (userError) {
        console.error(
          "❌ [STRIPE] Error getting current user minutes:",
          userError
        );
        return;
      }

      const previousMinutes = currentUser.available_minutes || 0;

      // Set minutes to 0 for final payment failure
      const { error: updateMinutesError } = await supabase
        .from("users")
        .update({
          available_minutes: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userSubscription.user_id);

      if (updateMinutesError) {
        console.error(
          "❌ [STRIPE] Error resetting user minutes for failed payment:",
          updateMinutesError
        );
        return;
      }

      console.log(
        "✅ [STRIPE] User minutes reset to 0 due to final payment failure:",
        {
          userId: userSubscription.user_id,
          previousMinutes: previousMinutes,
          newMinutes: 0,
          reason: "payment_failed_final",
          attemptCount: invoice.attempt_count,
        }
      );
    } else {
      console.log(
        "⚠️ [STRIPE] Payment failed but retries remain - keeping current minutes:",
        {
          userId: userSubscription.user_id,
          attemptCount: invoice.attempt_count,
          nextRetry: invoice.next_payment_attempt,
        }
      );
    }

    // Sync referral data
    await syncReferralData(userSubscription.user_id);
  } catch (error) {
    console.error(
      "❌ [STRIPE] Error processing invoice payment failure:",
      error
    );
  }
}

// Handle customer.subscription.updated event
async function handleSubscriptionUpdated(subscription) {
  try {
    console.log("✅ [STRIPE] Processing customer.subscription.updated");
    console.log("📋 [STRIPE] Subscription details:", {
      id: subscription.id,
      status: subscription.status,
      cancel_at_period_end: subscription.cancel_at_period_end,
    });

    // Helper function to safely convert Stripe timestamp to ISO string
    const convertStripeTimestamp = (timestamp) => {
      if (!timestamp || typeof timestamp !== "number") {
        console.warn("⚠️ [STRIPE] Invalid timestamp:", timestamp);
        return new Date().toISOString(); // Fallback to current time
      }

      try {
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) {
          console.warn("⚠️ [STRIPE] Invalid date from timestamp:", timestamp);
          return new Date().toISOString(); // Fallback to current time
        }
        return date.toISOString();
      } catch (error) {
        console.error("❌ [STRIPE] Error converting timestamp:", error);
        return new Date().toISOString(); // Fallback to current time
      }
    };

    const { error: updateError } = await supabase
      .from("user_subscriptions")
      .update({
        status: subscription.status,
        current_period_start: convertStripeTimestamp(
          subscription.current_period_start
        ),
        current_period_end: convertStripeTimestamp(
          subscription.current_period_end
        ),
        cancel_at_period_end: subscription.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (updateError) {
      console.error("❌ [STRIPE] Error updating subscription:", updateError);
      return;
    }

    console.log("✅ [STRIPE] Subscription updated");

    // Get user_id from subscription to sync referral data
    const { data: userSubscription } = await supabase
      .from("user_subscriptions")
      .select("user_id")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    if (userSubscription) {
      await syncReferralData(userSubscription.user_id);
    }
  } catch (error) {
    console.error("❌ [STRIPE] Error processing subscription update:", error);
  }
}

// Handle customer.subscription.deleted event
async function handleSubscriptionDeleted(subscription) {
  try {
    console.log("✅ [STRIPE] Processing customer.subscription.deleted");
    console.log("📋 [STRIPE] Subscription details:", {
      id: subscription.id,
      status: subscription.status,
      canceled_at: subscription.canceled_at,
      ended_at: subscription.ended_at,
    });

    // Get the user subscription record first to get user_id
    const { data: userSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("user_id, minutes_per_month")
      .eq("stripe_subscription_id", subscription.id)
      .single();

    if (subscriptionError || !userSubscription) {
      console.error(
        "❌ [STRIPE] Error getting user subscription:",
        subscriptionError
      );
      return;
    }

    console.log("📦 [STRIPE] User subscription found:", {
      userId: userSubscription.user_id,
      previousMinutes: userSubscription.minutes_per_month,
    });

    // Update subscription status to deleted/cancelled
    const { error: updateError } = await supabase
      .from("user_subscriptions")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (updateError) {
      console.error("❌ [STRIPE] Error updating subscription:", updateError);
      return;
    }

    console.log("✅ [STRIPE] Subscription marked as cancelled");

    // Reset user's available minutes to 0 when subscription is cancelled
    console.log(
      "💰 [STRIPE] Resetting user minutes to 0 due to subscription cancellation..."
    );

    // Get current user minutes for logging
    const { data: currentUser, error: userError } = await supabase
      .from("users")
      .select("available_minutes")
      .eq("id", userSubscription.user_id)
      .single();

    if (userError) {
      console.error(
        "❌ [STRIPE] Error getting current user minutes:",
        userError
      );
      return;
    }

    const previousMinutes = currentUser.available_minutes || 0;

    // Set minutes to 0
    const { error: updateMinutesError } = await supabase
      .from("users")
      .update({
        available_minutes: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userSubscription.user_id);

    if (updateMinutesError) {
      console.error(
        "❌ [STRIPE] Error resetting user minutes:",
        updateMinutesError
      );
      return;
    }

    console.log("✅ [STRIPE] User minutes reset to 0 successfully:", {
      userId: userSubscription.user_id,
      previousMinutes: previousMinutes,
      newMinutes: 0,
      reason: "subscription_cancelled",
    });

    // Sync referral data
    await syncReferralData(userSubscription.user_id);
  } catch (error) {
    console.error("❌ [STRIPE] Error processing subscription deletion:", error);
  }
}

// Helper function to sync referral data when subscription changes
async function syncReferralData(userId, subscriptionData) {
  try {
    console.log("🔄 [REFERRAL SYNC] Syncing referral data for user:", userId);

    // Get user subscription details
    const { data: userSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("plan_id, minutes_per_month, status")
      .eq("user_id", userId)
      .single();

    if (subscriptionError) {
      console.warn(
        "⚠️ [REFERRAL SYNC] No subscription found for user:",
        userId
      );
      return;
    }

    // Get plan details
    let planName = "free";
    if (userSubscription.plan_id) {
      const { data: plan } = await supabase
        .from("subscription_plans")
        .select("name")
        .eq("id", userSubscription.plan_id)
        .single();

      if (plan) {
        planName = plan.name;
      }
    }

    // Update referrals table
    const { error: updateError } = await supabase
      .from("referrals")
      .update({
        referred_plan: planName,
        referred_status: userSubscription.status || "active",
        referred_minutes: userSubscription.minutes_per_month || 5,
        updated_at: new Date().toISOString(),
      })
      .eq("referred_id", userId);

    if (updateError) {
      console.error(
        "❌ [REFERRAL SYNC] Error updating referrals:",
        updateError
      );
      return;
    }

    console.log("✅ [REFERRAL SYNC] Referral data synced successfully:", {
      userId,
      planName,
      status: userSubscription.status,
      minutes: userSubscription.minutes_per_month,
    });
  } catch (error) {
    console.error("❌ [REFERRAL SYNC] Error syncing referral data:", error);
  }
}

// Endpoint to unmark lead as invalid phone when phone number is edited
fastify.post("/api/leads/unmark-invalid-phone", async (request, reply) => {
  try {
    const { leadId } = request.body;

    if (!leadId) {
      return reply.code(400).send({
        success: false,
        error: "Lead ID is required",
      });
    }

    console.log(
      `[API] Unmarking lead ${leadId} as invalid phone (phone edited)`
    );

    const success = await markLeadInvalidPhone(leadId, false, "phone_edited");

    if (success) {
      reply.send({
        success: true,
        message: "Lead unmarked as invalid phone successfully",
      });
    } else {
      reply.code(500).send({
        success: false,
        error: "Failed to unmark lead as invalid phone",
      });
    }
  } catch (error) {
    console.error("[API] Error unmarking lead as invalid phone:", error);
    reply.code(500).send({
      success: false,
      error: "Internal server error",
    });
  }
});

// Twilio recording status callback endpoint
fastify.post("/twilio-recording-status", async (request, reply) => {
  try {
    console.log("🎙️ [TWILIO RECORDING] Recording status callback received");
    console.log("🎙️ [TWILIO RECORDING] Body:", request.body);

    const {
      CallSid,
      RecordingSid,
      RecordingUrl,
      RecordingDuration,
      RecordingStatus,
      RecordingChannels,
      RecordingSource,
      AccountSid, // Este campo nos dice de qué cuenta viene la grabación
    } = request.body;

    if (!CallSid || !RecordingSid) {
      console.error("❌ [TWILIO RECORDING] CallSid and RecordingSid required");
      return reply
        .code(400)
        .send({ error: "CallSid and RecordingSid required" });
    }

    console.log("🎙️ [TWILIO RECORDING] Processing recording:", {
      CallSid,
      RecordingSid,
      RecordingUrl,
      RecordingDuration,
      RecordingStatus,
      RecordingChannels,
      RecordingSource,
      AccountSid,
    });

    // Verificar si la grabación viene de una subcuenta
    let isFromSubaccount = false;
    if (AccountSid && AccountSid !== TWILIO_ACCOUNT_SID) {
      isFromSubaccount = true;
      console.log(
        `🎙️ [TWILIO RECORDING] Recording from subaccount: ${AccountSid}`
      );
    }

    // Update call with recording information
    const { error: updateError } = await supabase
      .from("calls")
      .update({
        recording_url: RecordingUrl || null,
        recording_sid: RecordingSid,
        recording_duration: RecordingDuration
          ? parseInt(RecordingDuration)
          : null,
        recording_status: RecordingStatus || null,
        recording_channels: RecordingChannels || null,
        recording_source: RecordingSource || null,
        updated_at: new Date().toISOString(),
      })
      .eq("call_sid", CallSid);

    if (updateError) {
      console.error(
        "❌ [TWILIO RECORDING] Error updating call with recording info:",
        updateError
      );
    } else {
      console.log(
        "✅ [TWILIO RECORDING] Call updated with recording info successfully"
      );
    }

    // Si la grabación está completa y tenemos URL, descargarla y almacenarla
    if (RecordingStatus === "completed" && RecordingUrl) {
      console.log(
        `🎙️ [TWILIO RECORDING] Recording completed, starting download for call ${CallSid}`
      );

      // Ejecutar la descarga de forma asíncrona para no bloquear la respuesta
      // La función downloadAndStoreRecording ya maneja las credenciales correctas
      downloadAndStoreRecording(RecordingUrl, CallSid, RecordingSid)
        .then((publicUrl) => {
          console.log(
            `✅ [TWILIO RECORDING] Recording download completed for call ${CallSid}: ${publicUrl}`
          );
        })
        .catch((error) => {
          console.error(
            `❌ [TWILIO RECORDING] Recording download failed for call ${CallSid}:`,
            error
          );
        });
    }

    reply.send({ success: true });
  } catch (error) {
    console.error(
      "❌ [TWILIO RECORDING] Error processing recording callback:",
      error
    );
    reply.code(500).send({ error: "Internal server error" });
  }
});

// Función para limpiar grabaciones antiguas (más de 24 horas)
// NOTA: Esta función se ha movido a Supabase para mejor rendimiento
// Ver: supabase/migrations/20250106_add_recording_cleanup.sql

// Endpoint para limpiar grabaciones antiguas manualmente
fastify.post("/api/admin/cleanup-recordings", async (request, reply) => {
  try {
    console.log("🧹 [ADMIN] Manual recording cleanup requested");

    // Verificar API key
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message: "Se requiere autenticación para esta operación",
      });
    }

    // Ejecutar la función de limpieza en Supabase
    const { data, error } = await supabase.rpc("cleanup_old_recordings");

    if (error) {
      console.error("❌ [ADMIN] Error ejecutando limpieza:", error);
      return reply.code(500).send({
        error: "Error ejecutando limpieza",
        message: error.message,
      });
    }

    // Obtener estadísticas después de la limpieza
    const { data: stats, error: statsError } = await supabase.rpc(
      "get_recording_stats"
    );

    if (statsError) {
      console.error("❌ [ADMIN] Error obteniendo estadísticas:", statsError);
    }

    console.log("✅ [ADMIN] Limpieza manual completada:", data);

    return reply.send({
      success: true,
      message: "Limpieza de grabaciones completada",
      data: {
        cleanup_result: data,
        statistics: stats,
      },
    });
  } catch (error) {
    console.error("❌ [ADMIN] Error en limpieza manual:", error);
    return reply.code(500).send({
      error: "Error interno del servidor",
      message: "Error inesperado al ejecutar limpieza",
    });
  }
});

// Endpoint para obtener estadísticas de grabaciones
fastify.get("/api/admin/recording-stats", async (request, reply) => {
  try {
    console.log("📊 [ADMIN] Recording statistics requested");

    // Verificar API key
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message: "Se requiere autenticación para esta operación",
      });
    }

    // Obtener estadísticas
    const { data: stats, error } = await supabase.rpc("get_recording_stats");

    if (error) {
      console.error("❌ [ADMIN] Error obteniendo estadísticas:", error);
      return reply.code(500).send({
        error: "Error obteniendo estadísticas",
        message: error.message,
      });
    }

    // Obtener grabaciones recientes para monitoreo
    const { data: recentRecordings, error: recordingsError } = await supabase
      .from("recording_monitor")
      .select("*")
      .limit(10);

    if (recordingsError) {
      console.error(
        "❌ [ADMIN] Error obteniendo grabaciones recientes:",
        recordingsError
      );
    }

    return reply.send({
      success: true,
      data: {
        statistics: stats,
        recent_recordings: recentRecordings || [],
      },
    });
  } catch (error) {
    console.error("❌ [ADMIN] Error obteniendo estadísticas:", error);
    return reply.code(500).send({
      error: "Error interno del servidor",
      message: "Error inesperado al obtener estadísticas",
    });
  }
});

// Función para descargar grabación de Twilio y guardarla en Supabase Storage
async function downloadAndStoreRecording(recordingUrl, callSid, recordingSid) {
  try {
    console.log(
      `🎙️ [RECORDING DOWNLOAD] Starting download for call ${callSid}`
    );

    // Primero, obtener información de la llamada para determinar qué credenciales usar
    const { data: callData, error: callError } = await supabase
      .from("calls")
      .select(
        `
        user_id,
        users!calls_user_id_fkey(
          twilio_subaccount_sid,
          twilio_auth_token
        )
      `
      )
      .eq("call_sid", callSid)
      .single();

    if (callError) {
      console.error(
        `❌ [RECORDING DOWNLOAD] Error getting call data for ${callSid}:`,
        callError
      );
      throw new Error(`Failed to get call data: ${callError.message}`);
    }

    // Determinar qué cliente de Twilio usar
    let twilioClientToUse = twilioClient; // Default
    let accountSid = TWILIO_ACCOUNT_SID;
    let authToken = TWILIO_AUTH_TOKEN;

    if (
      callData.users?.twilio_subaccount_sid &&
      callData.users?.twilio_auth_token
    ) {
      // Usar las credenciales de la subcuenta del usuario
      accountSid = callData.users.twilio_subaccount_sid;
      authToken = callData.users.twilio_auth_token;
      twilioClientToUse = new Twilio(accountSid, authToken);

      console.log(
        `🎙️ [RECORDING DOWNLOAD] Using user's subaccount for call ${callSid}:`,
        {
          userId: callData.user_id,
          subaccountSid: accountSid,
        }
      );
    } else {
      console.log(
        `🎙️ [RECORDING DOWNLOAD] Using main account for call ${callSid}`
      );
    }

    // Usar el cliente correcto para obtener la grabación con autenticación
    const recording = await twilioClientToUse.recordings(recordingSid).fetch();
    const extension = recording.mediaFormat || "wav"; // fallback
    const actualRecordingUrl = `https://api.twilio.com${recording.uri.replace(
      ".json",
      `.${extension}`
    )}`;

    const response = await fetch(actualRecordingUrl, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download recording: ${response.status} ${response.statusText}`
      );
    }

    const audioBuffer = await response.arrayBuffer();
    const audioData = Buffer.from(audioBuffer);

    console.log(
      `🎙️ [RECORDING DOWNLOAD] Downloaded ${audioData.length} bytes for call ${callSid}`
    );

    // Generar nombre único para el archivo
    const fileName = `recordings/${callSid}_${recordingSid}.${extension}`;

    // Subir a Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("call-recordings")
      .upload(fileName, audioData, {
        contentType: `audio/${extension}`,
        upsert: false,
      });

    if (uploadError) {
      throw new Error(
        `Failed to upload to Supabase Storage: ${uploadError.message}`
      );
    }

    console.log(
      `🎙️ [RECORDING DOWNLOAD] Successfully uploaded to Supabase Storage: ${fileName}`
    );

    // Obtener URL pública del archivo
    const { data: urlData } = supabase.storage
      .from("call-recordings")
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    // Actualizar la base de datos con la URL del archivo descargado
    const { error: updateError } = await supabase
      .from("calls")
      .update({
        recording_storage_url: publicUrl,
        recording_storage_path: fileName,
        recording_downloaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("call_sid", callSid);

    if (updateError) {
      throw new Error(`Failed to update database: ${updateError.message}`);
    }

    console.log(
      `✅ [RECORDING DOWNLOAD] Successfully stored recording for call ${callSid}: ${publicUrl}`
    );
    return publicUrl;
  } catch (error) {
    console.error(
      `❌ [RECORDING DOWNLOAD] Error downloading/storing recording for call ${callSid}:`,
      error
    );
    throw error;
  }
}

// Función para inicializar el bucket de grabaciones en Supabase Storage
async function initializeRecordingBucket() {
  try {
    console.log("🪣 [STORAGE] Initializing recording bucket...");

    // Listar buckets existentes
    const { data: buckets, error: listError } =
      await supabase.storage.listBuckets();

    if (listError) {
      console.error("❌ [STORAGE] Error listing buckets:", listError);
      return false;
    }

    // Verificar si el bucket ya existe
    const bucketExists = buckets.some(
      (bucket) => bucket.name === "call-recordings"
    );

    if (bucketExists) {
      console.log("✅ [STORAGE] Recording bucket already exists");
      return true;
    }

    // Crear el bucket si no existe
    const { data: bucket, error: createError } =
      await supabase.storage.createBucket("call-recordings", {
        public: true,
        allowedMimeTypes: ["audio/wav", "audio/mp3"],
        fileSizeLimit: 52428800, // 50MB limit
      });

    if (createError) {
      console.error("❌ [STORAGE] Error creating bucket:", createError);
      return false;
    }

    console.log("✅ [STORAGE] Recording bucket created successfully");
    return true;
  } catch (error) {
    console.error("❌ [STORAGE] Error initializing recording bucket:", error);
    return false;
  }
}

// Endpoint para obtener grabaciones de un usuario
fastify.get("/api/recordings/:userId", async (request, reply) => {
  try {
    const { userId } = request.params;

    if (!userId) {
      return reply.code(400).send({
        success: false,
        error: "User ID is required",
      });
    }

    console.log(`🎙️ [API] Fetching recordings for user ${userId}`);

    // Obtener llamadas con grabaciones disponibles
    const { data: calls, error } = await supabase
      .from("calls")
      .select(
        `
        id,
        call_sid,
        lead_id,
        duration,
        result,
        created_at,
        recording_storage_url,
        recording_duration,
        recording_downloaded_at,
        lead:leads (
          name,
          phone,
          email
        )
      `
      )
      .eq("user_id", userId)
      .not("recording_storage_url", "is", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(
        `❌ [API] Error fetching recordings for user ${userId}:`,
        error
      );
      return reply.code(500).send({
        success: false,
        error: "Error fetching recordings",
      });
    }

    console.log(
      `✅ [API] Found ${calls?.length || 0} recordings for user ${userId}`
    );

    reply.send({
      success: true,
      recordings: calls || [],
    });
  } catch (error) {
    console.error(`❌ [API] Error in recordings endpoint:`, error);
    reply.code(500).send({
      success: false,
      error: "Internal server error",
    });
  }
});

// Endpoint para descargar manualmente una grabación (en caso de que falle la descarga automática)
fastify.post("/api/recordings/download/:callSid", async (request, reply) => {
  try {
    const { callSid } = request.params;

    if (!callSid) {
      return reply.code(400).send({
        success: false,
        error: "Call SID is required",
      });
    }

    console.log(`🎙️ [API] Manual download requested for call ${callSid}`);

    // Obtener información de la llamada
    const { data: call, error: callError } = await supabase
      .from("calls")
      .select("call_sid, recording_url, recording_sid, recording_storage_url")
      .eq("call_sid", callSid)
      .single();

    if (callError || !call) {
      return reply.code(404).send({
        success: false,
        error: "Call not found",
      });
    }

    // Verificar si ya está descargada
    if (call.recording_storage_url) {
      return reply.send({
        success: true,
        message: "Recording already downloaded",
        url: call.recording_storage_url,
      });
    }

    // Verificar si tiene URL de Twilio
    if (!call.recording_url) {
      return reply.code(400).send({
        success: false,
        error: "No recording URL available",
      });
    }

    // Descargar la grabación
    const publicUrl = await downloadAndStoreRecording(
      call.recording_url,
      call.call_sid,
      call.recording_sid
    );

    reply.send({
      success: true,
      message: "Recording downloaded successfully",
      url: publicUrl,
    });
  } catch (error) {
    console.error(`❌ [API] Error in manual download:`, error);
    reply.code(500).send({
      success: false,
      error: "Error downloading recording",
    });
  }
});

// Endpoint para limpiar grabaciones antiguas manualmente

// =============================================================================
// TWILIO SUBACCOUNTS MANAGEMENT ENDPOINTS
// =============================================================================

// Endpoint para crear subcuenta de Twilio para un usuario
fastify.post("/twilio/create-subaccount", async (request, reply) => {
  try {
    console.log("🔧 [TWILIO SUBACCOUNT] Creating new subaccount...");
    console.log("📥 [TWILIO SUBACCOUNT] Request received:");
    console.log("🌐 [TWILIO SUBACCOUNT] Request headers:", request.headers);
    console.log(
      "📋 [TWILIO SUBACCOUNT] Request body:",
      JSON.stringify(request.body, null, 2)
    );
    console.log("⏰ [TWILIO SUBACCOUNT] Timestamp:", new Date().toISOString());

    const { userId, userName, userEmail, adminUserId } = request.body;

    console.log("🔍 [TWILIO SUBACCOUNT] Extracted fields:", {
      hasUserId: !!userId,
      hasUserName: !!userName,
      hasUserEmail: !!userEmail,
      hasAdminUserId: !!adminUserId,
      userId,
      userName,
      userEmail,
      adminUserId,
    });

    if (!userId || !userName || !adminUserId) {
      console.error("❌ [TWILIO SUBACCOUNT] Missing required fields");
      return reply.code(400).send({
        error: "Missing required fields: userId, userName, adminUserId",
      });
    }

    // Verificar que el usuario que hace la petición es admin
    console.log("👤 [TWILIO SUBACCOUNT] Verifying admin user:", adminUserId);
    const { data: adminUser, error: adminError } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", adminUserId)
      .single();

    console.log("🔍 [TWILIO SUBACCOUNT] Admin verification result:", {
      hasAdminUser: !!adminUser,
      isAdmin: adminUser?.is_admin,
      adminError: adminError?.message,
    });

    if (adminError || !adminUser?.is_admin) {
      console.error("❌ [TWILIO SUBACCOUNT] Admin verification failed");
      return reply.code(403).send({
        error: "Unauthorized: Admin access required",
      });
    }

    // Verificar que el usuario target existe
    console.log("🎯 [TWILIO SUBACCOUNT] Verifying target user:", userId);
    const { data: targetUser, error: userError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email, twilio_subaccount_sid")
      .eq("id", userId)
      .single();

    console.log("🔍 [TWILIO SUBACCOUNT] Target user verification result:", {
      hasTargetUser: !!targetUser,
      targetUserEmail: targetUser?.email,
      hasExistingSubaccount: !!targetUser?.twilio_subaccount_sid,
      userError: userError?.message,
    });

    if (userError || !targetUser) {
      console.error("❌ [TWILIO SUBACCOUNT] Target user not found");
      return reply.code(404).send({
        error: "User not found",
      });
    }

    // Verificar si ya tiene una subcuenta
    if (targetUser.twilio_subaccount_sid) {
      console.warn(
        "⚠️ [TWILIO SUBACCOUNT] User already has subaccount:",
        targetUser.twilio_subaccount_sid
      );
      return reply.code(400).send({
        error: "User already has a Twilio subaccount",
        subaccountSid: targetUser.twilio_subaccount_sid,
      });
    }

    // Log de inicio de operación
    const { data: logEntry } = await supabase
      .from("twilio_operations_log")
      .insert({
        user_id: userId,
        operation_type: "create_subaccount",
        operation_status: "pending",
        executed_by: adminUserId,
        twilio_request: {
          userName,
          userEmail,
          timestamp: new Date().toISOString(),
        },
      })
      .select()
      .single();

    try {
      // Crear subcuenta en Twilio
      console.log("🔧 [TWILIO SUBACCOUNT] Starting Twilio API call...");
      console.log("📋 [TWILIO SUBACCOUNT] Request data:", {
        userId,
        userName,
        userEmail,
        adminUserId,
        targetUserId: targetUser.id,
        targetUserEmail: targetUser.email,
      });

      const subaccountName = `${userName} - ${userEmail}`;
      console.log("🏷️  [TWILIO SUBACCOUNT] Subaccount name:", subaccountName);

      console.log(
        "📞 [TWILIO SUBACCOUNT] Calling Twilio API to create subaccount..."
      );
      console.log("🔑 [TWILIO SUBACCOUNT] Twilio client config:", {
        hasTwilioClient: !!twilioClient,
        hasApiAccounts: !!twilioClient?.api?.accounts,
        twilioAccountSid: process.env.TWILIO_ACCOUNT_SID
          ? "Present"
          : "Missing",
        twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ? "Present" : "Missing",
      });

      const subaccount = await twilioClient.api.accounts.create({
        friendlyName: subaccountName,
      });

      console.log("✅ [TWILIO SUBACCOUNT] Twilio API response received:");
      console.log("📊 [TWILIO SUBACCOUNT] Subaccount details:", {
        sid: subaccount.sid,
        friendlyName: subaccount.friendlyName,
        status: subaccount.status,
        authToken: subaccount.authToken ? "Present" : "Missing",
        dateCreated: subaccount.dateCreated,
        ownerAccountSid: subaccount.ownerAccountSid,
      });

      console.log("✅ [TWILIO SUBACCOUNT] Subaccount created:", {
        sid: subaccount.sid,
        friendlyName: subaccount.friendlyName,
        status: subaccount.status,
      });

      // Guardar en base de datos
      const { data: savedSubaccount, error: saveError } = await supabase
        .from("twilio_subaccounts")
        .insert({
          user_id: userId,
          subaccount_sid: subaccount.sid,
          subaccount_name: subaccountName,
          auth_token: subaccount.authToken,
          status: subaccount.status,
          created_by: adminUserId,
          subaccount_metadata: {
            twilio_status: subaccount.status,
            date_created: subaccount.dateCreated,
            date_updated: subaccount.dateUpdated,
            owner_account_sid: subaccount.ownerAccountSid,
          },
        })
        .select()
        .single();

      if (saveError) {
        console.error(
          "❌ [TWILIO SUBACCOUNT] Error saving to database:",
          saveError
        );
        throw new Error("Failed to save subaccount to database");
      }

      // Actualizar tabla users
      const { error: updateUserError } = await supabase
        .from("users")
        .update({
          twilio_subaccount_sid: subaccount.sid,
          twilio_auth_token: subaccount.authToken,
          twilio_subaccount_status: "active",
          twilio_subaccount_created_at: new Date().toISOString(),
        })
        .eq("id", userId);

      if (updateUserError) {
        console.error(
          "❌ [TWILIO SUBACCOUNT] Error updating user:",
          updateUserError
        );
        throw new Error("Failed to update user with subaccount info");
      }

      // Actualizar log como exitoso
      await supabase
        .from("twilio_operations_log")
        .update({
          operation_status: "success",
          completed_at: new Date().toISOString(),
          twilio_response: {
            sid: subaccount.sid,
            friendlyName: subaccount.friendlyName,
            status: subaccount.status,
            authToken: "***hidden***", // No guardar el token completo en logs
            dateCreated: subaccount.dateCreated,
          },
        })
        .eq("id", logEntry.id);

      return reply.send({
        success: true,
        message: "Subaccount created successfully",
        data: {
          subaccountSid: subaccount.sid,
          subaccountName: subaccountName,
          status: subaccount.status,
          userId: userId,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (twilioError) {
      console.error("❌ [TWILIO SUBACCOUNT] Twilio API error:", twilioError);
      console.error("🔍 [TWILIO SUBACCOUNT] Error details:", {
        message: twilioError.message,
        code: twilioError.code,
        status: twilioError.status,
        moreInfo: twilioError.moreInfo,
        details: twilioError.details,
        stack: twilioError.stack?.substring(0, 500) + "...", // Primeras 500 chars del stack
      });
      console.error(
        "📞 [TWILIO SUBACCOUNT] Full Twilio error object:",
        JSON.stringify(twilioError, null, 2)
      );

      // Actualizar log como fallido
      await supabase
        .from("twilio_operations_log")
        .update({
          operation_status: "failed",
          completed_at: new Date().toISOString(),
          error_message: twilioError.message,
          twilio_response: {
            error: twilioError.message,
            code: twilioError.code,
            status: twilioError.status,
            moreInfo: twilioError.moreInfo,
            details: twilioError.details,
          },
        })
        .eq("id", logEntry.id);

      return reply.code(500).send({
        error: "Failed to create Twilio subaccount",
        details: twilioError.message,
        code: twilioError.code,
        moreInfo: twilioError.moreInfo,
      });
    }
  } catch (error) {
    console.error("❌ [TWILIO SUBACCOUNT] General error:", error);
    return reply.code(500).send({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Endpoint para comprar número de teléfono para una subcuenta
fastify.post("/twilio/purchase-phone-number", async (request, reply) => {
  try {
    console.log("📞 [TWILIO PHONE] Purchasing phone number...");

    const {
      userId,
      areaCode,
      phoneType = "local", // local, toll-free
      redirectEnabled = false,
      redirectNumber,
      adminUserId,
    } = request.body;

    if (!userId || !adminUserId) {
      return reply.code(400).send({
        error: "Missing required fields: userId, adminUserId",
      });
    }

    // Verificar admin
    const { data: adminUser, error: adminError } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", adminUserId)
      .single();

    if (adminError || !adminUser?.is_admin) {
      return reply.code(403).send({
        error: "Unauthorized: Admin access required",
      });
    }

    // Obtener información del usuario y su subcuenta
    const { data: targetUser, error: userError } = await supabase
      .from("users")
      .select(
        `
        id, 
        first_name, 
        last_name, 
        email, 
        twilio_subaccount_sid, 
        twilio_auth_token,
        twilio_phone_number
      `
      )
      .eq("id", userId)
      .single();

    if (userError || !targetUser) {
      return reply.code(404).send({
        error: "User not found",
      });
    }

    if (!targetUser.twilio_subaccount_sid) {
      return reply.code(400).send({
        error: "User does not have a Twilio subaccount. Create one first.",
      });
    }

    if (targetUser.twilio_phone_number) {
      return reply.code(400).send({
        error: "User already has a phone number",
        phoneNumber: targetUser.twilio_phone_number,
      });
    }

    // Log de inicio de operación
    const { data: logEntry } = await supabase
      .from("twilio_operations_log")
      .insert({
        user_id: userId,
        operation_type: "purchase_number",
        operation_status: "pending",
        executed_by: adminUserId,
        subaccount_sid: targetUser.twilio_subaccount_sid,
        twilio_request: {
          areaCode,
          phoneType,
          redirectEnabled,
          redirectNumber,
          timestamp: new Date().toISOString(),
        },
      })
      .select()
      .single();

    try {
      // Crear cliente de Twilio para la subcuenta
      const subaccountClient = new Twilio(
        targetUser.twilio_subaccount_sid,
        targetUser.twilio_auth_token
      );

      // Buscar números disponibles
      let availableNumbers;
      const searchOptions = {
        limit: 10,
      };

      if (areaCode) {
        searchOptions.areaCode = areaCode;
      }

      if (phoneType === "toll-free") {
        availableNumbers = await subaccountClient
          .availablePhoneNumbers("US")
          .tollFree.list(searchOptions);
      } else {
        availableNumbers = await subaccountClient
          .availablePhoneNumbers("US")
          .local.list(searchOptions);
      }

      if (!availableNumbers || availableNumbers.length === 0) {
        throw new Error(
          `No available ${phoneType} numbers found${
            areaCode ? ` in area code ${areaCode}` : ""
          }`
        );
      }

      // Seleccionar el primer número disponible
      const selectedNumber = availableNumbers[0];
      console.log(
        "📞 [TWILIO PHONE] Selected number:",
        selectedNumber.phoneNumber
      );

      // Configurar webhook URL para redirección si está habilitada
      let voiceUrl = `https://${RAILWAY_PUBLIC_DOMAIN}/outbound-call-twiml`;
      if (redirectEnabled && redirectNumber) {
        voiceUrl = `https://${RAILWAY_PUBLIC_DOMAIN}/twilio/redirect-call?redirect_to=${encodeURIComponent(
          redirectNumber
        )}&user_id=${userId}`;
      }

      // Comprar el número
      const purchasedNumber =
        await subaccountClient.incomingPhoneNumbers.create({
          phoneNumber: selectedNumber.phoneNumber,
          friendlyName: `${targetUser.first_name} ${targetUser.last_name}`,
          voiceUrl: voiceUrl,
          voiceMethod: "POST",
          statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
          statusCallbackMethod: "POST",
        });

      console.log("✅ [TWILIO PHONE] Number purchased:", {
        sid: purchasedNumber.sid,
        phoneNumber: purchasedNumber.phoneNumber,
        friendlyName: purchasedNumber.friendlyName,
      });

      // Guardar en base de datos
      const { data: savedPhone, error: savePhoneError } = await supabase
        .from("twilio_phone_numbers")
        .insert({
          user_id: userId,
          phone_number: purchasedNumber.phoneNumber,
          phone_number_sid: purchasedNumber.sid,
          friendly_name: purchasedNumber.friendlyName,
          country_code: "US",
          phone_number_type: phoneType,
          redirect_enabled: redirectEnabled,
          redirect_number: redirectNumber,
          capabilities: {
            voice: selectedNumber.capabilities.voice,
            sms: selectedNumber.capabilities.sms,
            mms: selectedNumber.capabilities.mms,
          },
          created_by: adminUserId,
          phone_metadata: {
            twilio_sid: purchasedNumber.sid,
            account_sid: purchasedNumber.accountSid,
            date_created: purchasedNumber.dateCreated,
            voice_url: voiceUrl,
            selected_from: {
              locality: selectedNumber.locality,
              region: selectedNumber.region,
              iso_country: selectedNumber.isoCountry,
            },
          },
        })
        .select()
        .single();

      if (savePhoneError) {
        console.error(
          "❌ [TWILIO PHONE] Error saving phone to database:",
          savePhoneError
        );
        throw new Error("Failed to save phone number to database");
      }

      // Actualizar tabla users
      const { error: updateUserError } = await supabase
        .from("users")
        .update({
          twilio_phone_number: purchasedNumber.phoneNumber,
          twilio_phone_number_sid: purchasedNumber.sid,
          twilio_phone_redirect_number: redirectNumber,
          twilio_redirect_enabled: redirectEnabled,
        })
        .eq("id", userId);

      if (updateUserError) {
        console.error(
          "❌ [TWILIO PHONE] Error updating user:",
          updateUserError
        );
        throw new Error("Failed to update user with phone number info");
      }

      // Actualizar log como exitoso
      await supabase
        .from("twilio_operations_log")
        .update({
          operation_status: "success",
          completed_at: new Date().toISOString(),
          phone_number_sid: purchasedNumber.sid,
          twilio_response: {
            sid: purchasedNumber.sid,
            phoneNumber: purchasedNumber.phoneNumber,
            friendlyName: purchasedNumber.friendlyName,
            capabilities: selectedNumber.capabilities,
            locality: selectedNumber.locality,
            region: selectedNumber.region,
          },
        })
        .eq("id", logEntry.id);

      return reply.send({
        success: true,
        message: "Phone number purchased successfully",
        data: {
          phoneNumber: purchasedNumber.phoneNumber,
          phoneNumberSid: purchasedNumber.sid,
          friendlyName: purchasedNumber.friendlyName,
          phoneType: phoneType,
          redirectEnabled: redirectEnabled,
          redirectNumber: redirectNumber,
          capabilities: selectedNumber.capabilities,
          location: {
            locality: selectedNumber.locality,
            region: selectedNumber.region,
            country: selectedNumber.isoCountry,
          },
          userId: userId,
          purchasedAt: new Date().toISOString(),
        },
      });
    } catch (twilioError) {
      console.error("❌ [TWILIO PHONE] Twilio API error:", twilioError);

      // Actualizar log como fallido
      await supabase
        .from("twilio_operations_log")
        .update({
          operation_status: "failed",
          completed_at: new Date().toISOString(),
          error_message: twilioError.message,
          twilio_response: {
            error: twilioError.message,
            code: twilioError.code,
            status: twilioError.status,
          },
        })
        .eq("id", logEntry.id);

      return reply.code(500).send({
        error: "Failed to purchase phone number",
        details: twilioError.message,
        code: twilioError.code,
      });
    }
  } catch (error) {
    console.error("❌ [TWILIO PHONE] General error:", error);
    return reply.code(500).send({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Endpoint para manejar redirección de llamadas entrantes
fastify.all("/twilio/redirect-call", async (request, reply) => {
  try {
    const accountSid = request.body?.AccountSid;
    const toNumber = request.body?.To;
    const fromNumber = request.body?.From;
    const callSid = request.body?.CallSid;

    console.log("📞 [TWILIO REDIRECT] Incoming call details:", {
      accountSid,
      toNumber,
      fromNumber,
      callSid,
      method: request.method,
      url: request.url,
      body: request.body,
    });

    if (!accountSid || !toNumber) {
      console.error("❌ [TWILIO REDIRECT] Missing AccountSid or To number");
      return reply
        .code(400)
        .send({ error: "Missing required Twilio parameters" });
    }

    // Buscar la configuración del número de teléfono en la base de datos
    const { data: phoneConfigs, error: phoneError } = await supabase
      .from("twilio_phone_numbers")
      .select(
        `
        *,
        users!twilio_phone_numbers_user_id_fkey(*)
      `
      )
      .eq("phone_number", toNumber)
      .eq("users.twilio_subaccount_sid", accountSid);

    if (phoneError || !phoneConfigs || phoneConfigs.length === 0) {
      console.error("❌ [TWILIO REDIRECT] Phone number not found:", {
        toNumber,
        accountSid,
        error: phoneError,
      });

      // Respuesta TwiML por defecto si no se encuentra configuración
      const defaultResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say language="es-US" voice="Lupe">
            Lo sentimos, no pudimos procesar su llamada. Por favor intente más tarde.
          </Say>
        </Response>`;

      return reply.type("text/xml").send(defaultResponse);
    }

    const phoneConfig = phoneConfigs[0]; // Tomar el primer resultado
    const user = phoneConfig.users;

    console.log("📞 [TWILIO REDIRECT] Phone config found:", {
      userId: user.id,
      userName: `${user.first_name} ${user.last_name}`,
      redirectEnabled: phoneConfig.redirect_enabled,
      redirectNumber: phoneConfig.redirect_number,
    });

    // Verificar si la redirección está habilitada
    if (!phoneConfig.redirect_enabled || !phoneConfig.redirect_number) {
      console.log(
        "📞 [TWILIO REDIRECT] Redirect not enabled, using default flow"
      );

      // Si no hay redirección, usar el flujo normal (outbound-call-twiml)
      const defaultResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say language="es-US" voice="Lupe">
            Hola, en un momento lo atenderemos.
          </Say>
          <Redirect>https://${
            process.env.RAILWAY_PUBLIC_DOMAIN || "localhost:3000"
          }/outbound-call-twiml</Redirect>
        </Response>`;

      return reply.type("text/xml").send(defaultResponse);
    }

    // Formatear el número de redirección correctamente
    let redirectNumber = phoneConfig.redirect_number.toString();

    // Limpiar el número (remover espacios, guiones, etc.)
    redirectNumber = redirectNumber.replace(/[\s\-\(\)]/g, "");

    // Si no tiene +, agregarlo
    if (!redirectNumber.startsWith("+")) {
      // Si es un número de 10 dígitos (US), agregar +1
      if (redirectNumber.length === 10) {
        redirectNumber = `+1${redirectNumber}`;
      }
      // Si es un número de 11 dígitos que empieza con 1, agregar +
      else if (redirectNumber.length === 11 && redirectNumber.startsWith("1")) {
        redirectNumber = `+${redirectNumber}`;
      }
      // Si no, asumir que necesita +1
      else {
        redirectNumber = `+1${redirectNumber}`;
      }
    }

    console.log("📞 [TWILIO REDIRECT] Formatted redirect number:", {
      original: phoneConfig.redirect_number,
      formatted: redirectNumber,
    });

    // Crear respuesta TwiML para redireccionar la llamada
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Dial timeout="30" record="true">
          <Number>${redirectNumber}</Number>
        </Dial>
        <Say language="es-US" voice="Lupe">
          Lo sentimos, no pudimos conectar su llamada. Por favor intente más tarde.
        </Say>
      </Response>`;

    // Log de la redirección
    await supabase.from("twilio_operations_log").insert({
      user_id: user.id,
      operation_type: "redirect_call",
      operation_status: "success",
      twilio_request: {
        from: fromNumber,
        to: toNumber,
        callSid: callSid,
        accountSid: accountSid,
        redirect_to: redirectNumber,
        timestamp: new Date().toISOString(),
      },
    });

    console.log("✅ [TWILIO REDIRECT] Redirecting to:", redirectNumber);
    reply.type("text/xml").send(twimlResponse);
  } catch (error) {
    console.error("❌ [TWILIO REDIRECT] Error:", error);

    // Respuesta TwiML de error
    const errorResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say language="es-US" voice="Lupe">
          Lo sentimos, ocurrió un error. Por favor intente más tarde.
        </Say>
      </Response>`;

    reply.type("text/xml").send(errorResponse);
  }
});

// Endpoint para obtener información de subcuentas y números de teléfono
fastify.get("/twilio/user-info/:userId", async (request, reply) => {
  try {
    const { userId } = request.params;
    const { adminUserId } = request.query;

    // Verificar admin
    const { data: adminUser, error: adminError } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", adminUserId)
      .single();

    if (adminError || !adminUser?.is_admin) {
      return reply.code(403).send({
        error: "Unauthorized: Admin access required",
      });
    }

    // Obtener información completa del usuario
    const { data: userInfo, error: userError } = await supabase
      .from("users")
      .select(
        `
        id,
        first_name,
        last_name,
        email,
        twilio_subaccount_sid,
        twilio_phone_number,
        twilio_phone_number_sid,
        twilio_subaccount_status,
        twilio_subaccount_created_at,
        twilio_phone_redirect_number,
        twilio_redirect_enabled
      `
      )
      .eq("id", userId)
      .single();

    if (userError || !userInfo) {
      return reply.code(404).send({ error: "User not found" });
    }

    // Obtener información detallada de subcuenta si existe
    let subaccountDetails = null;
    if (userInfo.twilio_subaccount_sid) {
      const { data: subaccount } = await supabase
        .from("twilio_subaccounts")
        .select("*")
        .eq("user_id", userId)
        .single();

      subaccountDetails = subaccount;
    }

    // Obtener información detallada del número de teléfono si existe
    let phoneDetails = null;
    if (userInfo.twilio_phone_number_sid) {
      const { data: phone } = await supabase
        .from("twilio_phone_numbers")
        .select("*")
        .eq("user_id", userId)
        .single();

      phoneDetails = phone;
    }

    // Obtener historial de operaciones recientes
    const { data: recentOperations } = await supabase
      .from("twilio_operations_log")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10);

    return reply.send({
      success: true,
      data: {
        user: {
          id: userInfo.id,
          name: `${userInfo.first_name} ${userInfo.last_name}`,
          email: userInfo.email,
        },
        subaccount: {
          exists: !!userInfo.twilio_subaccount_sid,
          sid: userInfo.twilio_subaccount_sid,
          status: userInfo.twilio_subaccount_status,
          createdAt: userInfo.twilio_subaccount_created_at,
          details: subaccountDetails,
        },
        phoneNumber: {
          exists: !!userInfo.twilio_phone_number,
          number: userInfo.twilio_phone_number,
          sid: userInfo.twilio_phone_number_sid,
          redirectEnabled: userInfo.twilio_redirect_enabled,
          redirectNumber: userInfo.twilio_phone_redirect_number,
          details: phoneDetails,
        },
        recentOperations: recentOperations || [],
      },
    });
  } catch (error) {
    console.error("❌ [TWILIO INFO] Error:", error);
    return reply.code(500).send({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Función para limpiar grabaciones de Twilio (tanto cuenta principal como subcuentas)
async function cleanupTwilioRecordings(olderThanHours = 72) {
  try {
    console.log(
      `🧹 [TWILIO CLEANUP] Starting Twilio recordings cleanup (older than ${olderThanHours}h)`
    );

    // Obtener grabaciones que necesitan ser eliminadas de Twilio
    const { data: recordingsToDelete, error: fetchError } = await supabase
      .from("calls")
      .select(
        `
        recording_sid,
        call_sid,
        user_id,
        created_at,
        users!calls_user_id_fkey(
          twilio_subaccount_sid,
          twilio_auth_token
        )
      `
      )
      .not("recording_sid", "is", null)
      .lt(
        "created_at",
        new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString()
      );

    if (fetchError) {
      console.error(
        "❌ [TWILIO CLEANUP] Error fetching recordings to delete:",
        fetchError
      );
      throw fetchError;
    }

    if (!recordingsToDelete || recordingsToDelete.length === 0) {
      console.log("✅ [TWILIO CLEANUP] No recordings to delete from Twilio");
      return { deletedCount: 0, errors: [] };
    }

    console.log(
      `🧹 [TWILIO CLEANUP] Found ${recordingsToDelete.length} recordings to delete from Twilio`
    );

    let deletedCount = 0;
    const errors = [];

    // Agrupar por tipo de cuenta (principal vs subcuentas)
    const mainAccountRecordings = [];
    const subaccountRecordings = new Map(); // Map<subaccountSid, recordings[]>

    for (const recording of recordingsToDelete) {
      if (
        recording.users?.twilio_subaccount_sid &&
        recording.users?.twilio_auth_token
      ) {
        // Es de una subcuenta
        const subaccountSid = recording.users.twilio_subaccount_sid;
        if (!subaccountRecordings.has(subaccountSid)) {
          subaccountRecordings.set(subaccountSid, []);
        }
        subaccountRecordings.get(subaccountSid).push(recording);
      } else {
        // Es de la cuenta principal
        mainAccountRecordings.push(recording);
      }
    }

    // Limpiar grabaciones de la cuenta principal
    if (mainAccountRecordings.length > 0) {
      console.log(
        `🧹 [TWILIO CLEANUP] Deleting ${mainAccountRecordings.length} recordings from main account`
      );

      for (const recording of mainAccountRecordings) {
        try {
          await twilioClient.recordings(recording.recording_sid).remove();
          deletedCount++;
          console.log(
            `✅ [TWILIO CLEANUP] Deleted recording ${recording.recording_sid} from main account`
          );
        } catch (error) {
          console.error(
            `❌ [TWILIO CLEANUP] Error deleting recording ${recording.recording_sid} from main account:`,
            error
          );
          errors.push({
            recordingSid: recording.recording_sid,
            callSid: recording.call_sid,
            accountType: "main",
            error: error.message,
          });
        }
      }
    }

    // Limpiar grabaciones de subcuentas
    for (const [subaccountSid, recordings] of subaccountRecordings.entries()) {
      console.log(
        `🧹 [TWILIO CLEANUP] Deleting ${recordings.length} recordings from subaccount ${subaccountSid}`
      );

      // Obtener las credenciales de la subcuenta (usar la primera grabación como referencia)
      const firstRecording = recordings[0];
      const authToken = firstRecording.users.twilio_auth_token;

      try {
        // Crear cliente para esta subcuenta
        const subaccountClient = new Twilio(subaccountSid, authToken);

        for (const recording of recordings) {
          try {
            await subaccountClient.recordings(recording.recording_sid).remove();
            deletedCount++;
            console.log(
              `✅ [TWILIO CLEANUP] Deleted recording ${recording.recording_sid} from subaccount ${subaccountSid}`
            );
          } catch (error) {
            console.error(
              `❌ [TWILIO CLEANUP] Error deleting recording ${recording.recording_sid} from subaccount ${subaccountSid}:`,
              error
            );
            errors.push({
              recordingSid: recording.recording_sid,
              callSid: recording.call_sid,
              accountType: "subaccount",
              subaccountSid: subaccountSid,
              error: error.message,
            });
          }
        }
      } catch (error) {
        console.error(
          `❌ [TWILIO CLEANUP] Error creating client for subaccount ${subaccountSid}:`,
          error
        );
        // Agregar todos los recordings de esta subcuenta como errores
        for (const recording of recordings) {
          errors.push({
            recordingSid: recording.recording_sid,
            callSid: recording.call_sid,
            accountType: "subaccount",
            subaccountSid: subaccountSid,
            error: `Failed to create subaccount client: ${error.message}`,
          });
        }
      }
    }

    console.log(
      `✅ [TWILIO CLEANUP] Cleanup completed. Deleted: ${deletedCount}, Errors: ${errors.length}`
    );

    return {
      deletedCount,
      errors,
      totalRecordings: recordingsToDelete.length,
      mainAccountDeleted: mainAccountRecordings.length,
      subaccountDeleted: deletedCount - mainAccountRecordings.length,
    };
  } catch (error) {
    console.error("❌ [TWILIO CLEANUP] Error in cleanup process:", error);
    throw error;
  }
}

// Endpoint para limpiar grabaciones de Twilio manualmente
fastify.post("/api/admin/cleanup-twilio-recordings", async (request, reply) => {
  try {
    console.log("🧹 [ADMIN] Manual Twilio recordings cleanup requested");

    // Verificar API key
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message: "Se requiere autenticación para esta operación",
      });
    }

    const { olderThanHours = 72 } = request.body || {};

    // Ejecutar la limpieza de Twilio
    const result = await cleanupTwilioRecordings(olderThanHours);

    return reply.send({
      success: true,
      message: `Twilio recordings cleanup completed`,
      data: result,
    });
  } catch (error) {
    console.error("❌ [ADMIN] Error en limpieza de Twilio:", error);
    return reply.code(500).send({
      error: "Error interno del servidor",
      message: "Error inesperado al ejecutar limpieza de Twilio",
    });
  }
});

// Función para verificar y activar subcuenta de Twilio
async function verifyAndActivateSubaccount(subaccountSid, authToken) {
  try {
    console.log(`🔍 [TWILIO VERIFY] Verifying subaccount: ${subaccountSid}`);

    // Crear cliente para la subcuenta
    const subaccountClient = new Twilio(subaccountSid, authToken);

    // Verificar estado de la subcuenta
    const account = await subaccountClient.api.accounts(subaccountSid).fetch();

    console.log(`📋 [TWILIO VERIFY] Subaccount status:`, {
      sid: account.sid,
      status: account.status,
      type: account.type,
      dateCreated: account.dateCreated,
    });

    // Verificar límites y capacidades
    const balance = await subaccountClient.balance.fetch();

    console.log(`💰 [TWILIO VERIFY] Subaccount balance:`, {
      balance: balance.balance,
      currency: balance.currency,
    });

    // Verificar si puede hacer llamadas (intentar listar números disponibles)
    try {
      const availableNumbers = await subaccountClient
        .availablePhoneNumbers("US")
        .local.list({ limit: 1 });

      console.log(
        `📞 [TWILIO VERIFY] Can search phone numbers: ${
          availableNumbers.length > 0 ? "YES" : "NO"
        }`
      );
    } catch (error) {
      console.warn(
        `⚠️ [TWILIO VERIFY] Cannot search phone numbers:`,
        error.message
      );
    }

    return {
      isActive: account.status === "active",
      status: account.status,
      type: account.type,
      balance: balance.balance,
      currency: balance.currency,
      canMakeCalls: account.status === "active",
    };
  } catch (error) {
    console.error(
      `❌ [TWILIO VERIFY] Error verifying subaccount ${subaccountSid}:`,
      error
    );
    throw error;
  }
}

// Endpoint para verificar estado de subcuenta
fastify.get(
  "/twilio/verify-subaccount/:subaccountSid",
  async (request, reply) => {
    try {
      const { subaccountSid } = request.params;
      const { adminUserId } = request.query;

      // Verificar admin
      const { data: adminUser, error: adminError } = await supabase
        .from("users")
        .select("is_admin")
        .eq("id", adminUserId)
        .single();

      if (adminError || !adminUser?.is_admin) {
        return reply.code(403).send({
          error: "Unauthorized: Admin access required",
        });
      }

      // Obtener las credenciales de la subcuenta
      const { data: subaccountData, error: subaccountError } = await supabase
        .from("users")
        .select("twilio_auth_token")
        .eq("twilio_subaccount_sid", subaccountSid)
        .single();

      if (subaccountError || !subaccountData) {
        return reply.code(404).send({
          error: "Subaccount not found",
        });
      }

      // Verificar la subcuenta
      const verificationResult = await verifyAndActivateSubaccount(
        subaccountSid,
        subaccountData.twilio_auth_token
      );

      return reply.send({
        success: true,
        data: verificationResult,
      });
    } catch (error) {
      console.error("❌ [TWILIO VERIFY] Error:", error);
      return reply.code(500).send({
        error: "Internal server error",
        details: error.message,
      });
    }
  }
);
