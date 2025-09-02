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
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OPENAI_API_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const fastify = Fastify({
  logger: false,
  connectionTimeout: 30000,
  keepAliveTimeout: 30000,
  maxRequestsPerSocket: 100,
  disableRequestLogging: true,
  bodyLimit: 1048576,
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    if (req.url === "/webhook/stripe" || req.url === "/webhook/elevenlabs") {
      req.rawBody = body;
      done(null, body);
    } else {
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

// Verificar variables de entorno críticas
const requiredEnvVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
];

const missingEnvVars = requiredEnvVars.filter(
  (varName) => !process.env[varName]
);
if (missingEnvVars.length > 0) {
  console.error("❌ [STARTUP] Variables de entorno faltantes:", missingEnvVars);
  console.error(
    "❌ [STARTUP] El servidor no puede iniciar sin estas variables"
  );
  process.exit(1);
}

console.log(
  "✅ [STARTUP] Todas las variables de entorno críticas están definidas"
);

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

  // Manejo especial para errores de geo-permissions
  let translatedMessage = errorTranslations[errorCode] || errorMessage;

  // Detectar errores de geo-permissions por el mensaje
  if (
    errorMessage.toLowerCase().includes("geo-permissions") ||
    errorMessage.toLowerCase().includes("not authorized to call") ||
    errorMessage.toLowerCase().includes("international permissions")
  ) {
    translatedMessage = "País no autorizado para realizar llamadas";
  }

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

// Function to determine detailed call result based on AI analysis only
function determineDetailedCallResult(callData) {
  try {
    const { calendar_event_id, detailed_result } = callData;

    // Si hay cita agendada, siempre retornar "Cita Agendada"
    if (calendar_event_id) {
      return "Cita Agendada";
    }

    // Usar únicamente el resultado de la IA (detailed_result)
    if (detailed_result) {
      return detailed_result;
    }

    // Si no hay resultado de la IA, retornar null
    return null;
  } catch (error) {
    console.error("Error in determineDetailedCallResult:", error);
    return "Desconocido";
  }
}

// Optimized signature verification - minimal logging
function verifyElevenLabsSignature(rawBody, signature) {
  try {
    // Si no hay ELEVENLABS_WEBHOOK_SECRET, permitir sin verificación
    if (!ELEVENLABS_WEBHOOK_SECRET) {
      console.warn(
        "[WEBHOOK] No ELEVENLABS_WEBHOOK_SECRET configured, skipping signature verification"
      );
      return true;
    }

    // Verificar que signature existe y es una cadena
    if (!signature || typeof signature !== "string") {
      console.warn("[WEBHOOK] Signature is missing or invalid:", signature);
      // En desarrollo, permitir sin firma para testing
      if (
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
      ) {
        console.warn(
          "[WEBHOOK] Development mode: allowing request without signature"
        );
        return true;
      }
      return false;
    }

    let timestamp = null;
    let actualSignature = null;

    if (signature.includes("t=") && signature.includes("v0=")) {
      const tMatch = signature.match(/t=(\d+)/);
      if (tMatch) timestamp = tMatch[1];

      const v0Match = signature.match(/v0=([a-f0-9]+)/);
      if (v0Match) actualSignature = v0Match[1];
    } else {
      console.warn("[WEBHOOK] Invalid signature format:", signature);
      return false;
    }

    if (!timestamp || !actualSignature) {
      console.warn("[WEBHOOK] Missing timestamp or signature in header");
      return false;
    }

    // Verificar que el timestamp no sea muy antiguo (5 minutos)
    const currentTime = Math.floor(Date.now() / 1000);
    const timestampAge = currentTime - parseInt(timestamp);
    if (timestampAge > 300) {
      // 5 minutos
      console.warn(`[WEBHOOK] Signature timestamp too old: ${timestampAge}s`);
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
      .createHmac("sha256", ELEVENLABS_WEBHOOK_SECRET)
      .update(signedPayload, "utf8")
      .digest("hex");

    const isValid = expectedSignature === actualSignature;

    if (!isValid) {
      console.error("[WEBHOOK] Signature verification failed");
      console.error("[WEBHOOK] Expected:", expectedSignature);
      console.error("[WEBHOOK] Received:", actualSignature);
      console.error("[WEBHOOK] Timestamp:", timestamp);
      console.error(
        "[WEBHOOK] Raw body length:",
        rawBody ? rawBody.length : "undefined"
      );
      console.error(
        "[WEBHOOK] Signed payload preview:",
        signedPayload.substring(0, 100) + "..."
      );

      // En desarrollo, permitir continuar para debugging
      if (
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
      ) {
        console.warn(
          "[WEBHOOK] Development mode: allowing request despite signature mismatch"
        );
        return true;
      }
    } else {
    }

    return isValid;
  } catch (error) {
    console.error("[WEBHOOK] Error verifying signature:", error);

    // En desarrollo, permitir continuar para debugging
    if (
      process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test"
    ) {
      console.warn(
        "[WEBHOOK] Development mode: allowing request despite verification error"
      );
      return true;
    }

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
  // Mutex: evitar procesamiento simultáneo (timeout de 30 segundos)
  if (isProcessingQueue) {
    console.log(
      `[Queue] Skipping - already processing (${new Date().toISOString()})`
    );
    return;
  }

  console.log(
    `[Queue] Starting queue processing check at ${new Date().toISOString()}`
  );
  isProcessingQueue = true;

  // Timeout de seguridad para liberar el mutex
  const mutexTimeout = setTimeout(() => {
    console.warn(
      `[Queue] ⚠️ Mutex timeout - forcing release at ${new Date().toISOString()}`
    );
    isProcessingQueue = false;
  }, 30000); // 30 segundos máximo

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
        priority,
        scheduled_at,
        lead:leads (
          name,
          phone,
            email,
            language
        )
      `
        )
        .eq("status", "pending")
        .or(`scheduled_at.lte.${new Date().toISOString()},scheduled_at.is.null`)
        .order("priority", { ascending: true })
        .order("scheduled_at", { ascending: true, nullsFirst: true })
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
          "id, available_call_credits, email, first_name, last_name, assistant_name"
        )
        .in("id", userIds);

      if (usersError) {
        console.error("[Queue] ❌ Error fetching users data:", usersError);
        return;
      }

      // Create optimized user lookup map
      const usersMap = new Map(usersData?.map((user) => [user.id, user]) || []);

      // Group items by user and validate credits
      const userQueues = new Map();

      console.log(`[Queue] Available items by user:`, {
        totalItems: availableItems.length,
        uniqueUsers: userIds.length,
        usersWithData: usersData?.length || 0,
      });

      for (const item of availableItems) {
        const user = usersMap.get(item.user_id);

        if (!user) {
          console.log(
            `[Queue] Skipping item ${item.id} - user ${item.user_id} not found in users data`
          );
          continue;
        }

        if (user.available_call_credits < 60) {
          console.log(
            `[Queue] Skipping item ${item.id} - user ${item.user_id} has insufficient credits: ${user.available_call_credits} < 60`
          );
          continue;
        }

        if (!userQueues.has(item.user_id)) {
          userQueues.set(item.user_id, []);
        }
        userQueues.get(item.user_id).push(item);
      }

      console.log(`[Queue] Users with sufficient credits:`, {
        userQueuesSize: userQueues.size,
        users: Array.from(userQueues.keys()).map((userId) => {
          const user = usersMap.get(userId);
          return {
            userId,
            availableCredits: user?.available_call_credits,
            queueLength: userQueues.get(userId)?.length || 0,
          };
        }),
      });

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
          availableCredits: user.available_call_credits,
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
          Math.floor(userData.availableCredits / 60), // 60 minutes per call
          availableSlots - itemsToProcess.length // Available slots remaining
        );

        console.log(`[Queue] User ${userData.userId} slot calculation:`, {
          userId: userData.userId,
          userActiveCallCount,
          currentUserSlots,
          maxCallsPerUser: QUEUE_CONFIG.maxCallsPerUser,
          availableCredits: userData.availableCredits,
          creditsPerCall: Math.floor(userData.availableCredits / 60),
          availableSlotsRemaining: availableSlots - itemsToProcess.length,
          maxSlotsForUser,
          canProcess: maxSlotsForUser > 0,
        });

        if (maxSlotsForUser <= 0) {
          console.log(
            `[Queue] Skipping user ${userData.userId} - no available slots (${maxSlotsForUser})`
          );
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

      console.log(`[Queue] Processing queue - Summary:`, {
        availableSlots,
        itemsToProcess: itemsToProcess.length,
        userPriority: userPriority.map((u) => ({
          userId: u.userId,
          hasActiveCalls: u.hasActiveCalls,
          queueLength: u.queueLength,
          availableCredits: u.availableCredits,
          userActiveCallCount: userActiveCalls.get(u.userId) || 0,
        })),
        userActiveCalls: Object.fromEntries(userActiveCalls),
        globalActiveCallsSize: globalActiveCalls.size,
      });

      if (itemsToProcess.length === 0) {
        console.log(
          `[Queue] No items to process - all users at capacity or no available slots`
        );
        return;
      }

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
    // Limpiar timeout y liberar el mutex
    clearTimeout(mutexTimeout);
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
      console.log(
        `[Queue] Worker ${workerId} - Cannot process: max concurrent calls reached`
      );
      return false;
    }

    const userActiveCallCount = userActiveCalls.get(queueItem.user_id) || 0;
    console.log(`[Queue] Worker ${workerId} - Checking user limits:`, {
      userId: queueItem.user_id,
      userActiveCallCount,
      maxCallsPerUser: QUEUE_CONFIG.maxCallsPerUser,
      canProcess: userActiveCallCount < QUEUE_CONFIG.maxCallsPerUser,
      userActiveCalls: Object.fromEntries(userActiveCalls),
    });

    if (userActiveCallCount >= QUEUE_CONFIG.maxCallsPerUser) {
      console.log(
        `[Queue] Worker ${workerId} - Cannot process: max calls per user reached (${userActiveCallCount}/${QUEUE_CONFIG.maxCallsPerUser})`
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
    const released = releaseWorker(workerId, "finally_block");
    if (released) {
      console.log(
        `[Queue] 🔄 Worker ${workerId} released in finally block (fallback)`
      );
    }
  }
}

// Centralized worker release function
function releaseWorker(workerId, reason = "call_completed") {
  if (workerPool.has(workerId)) {
    workerPool.delete(workerId);
    console.log(
      `[Queue] Worker ${workerId} released (${reason}). Pool size: ${workerPool.size}`
    );
    return true;
  } else {
    console.log(`[Queue] Worker ${workerId} not found in pool (${reason})`);
    return false;
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

processAllPendingQueues();

// Add this function at the top with other utility functions
async function cancelPendingCalls(userId, reason) {
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
      .order("created_at", { ascending: false })
      .limit(1);

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
      .order("created_at", { ascending: false })
      .limit(1);

    if (settingsError) {
      console.log(
        `[Calendar][SUMMARY] ❌ Error obteniendo configuración: ${settingsError.message}`
      );
      return null;
    }
    if (!calendarSettings || calendarSettings.length === 0) {
      console.log(
        `[Calendar][SUMMARY] ❌ No hay configuración de calendario para el usuario.`
      );
      return null;
    }

    // Obtener la configuración más reciente (primer elemento del array)
    const calendarConfig = calendarSettings[0];

    console.log(
      `[Calendar][SUMMARY] Configuración encontrada:`,
      calendarSettings
    );

    if (!calendarConfig.calendar_enabled) {
      console.log(
        `[Calendar][SUMMARY] ⚠️ Calendario no habilitado para usuario ${userId}`
      );
      return null;
    }
    if (!calendarConfig.access_token) {
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
        `https://oauth2.googleapis.com/tokeninfo?access_token=${calendarConfig.access_token}`,
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
          access_token: calendarConfig.access_token,
          refresh_token: calendarConfig.refresh_token,
        });
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (credentials.access_token) {
          await supabase
            .from("user_calendar_settings")
            .update({
              access_token: credentials.access_token,
              refresh_token:
                credentials.refresh_token || calendarConfig.refresh_token,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
          calendarConfig.access_token = credentials.access_token;
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
        access_token: calendarConfig.access_token,
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
        timezone: calendarConfig.calendar_timezone,
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
            timeZone: calendarConfig.calendar_timezone,
          }),
          endTime: end.toLocaleTimeString("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: calendarConfig.calendar_timezone,
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
          timeZone: calendarConfig.calendar_timezone,
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
              calendarConfig.calendar_timezone
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

    // Check available credits before proceeding
    console.log(`[DEBUG] Buscando usuario con ID: ${queueItem.user_id}`);
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select(
        "available_call_credits, email, first_name, last_name, assistant_name, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token, location, title"
      )
      .eq("id", queueItem.user_id)
      .order("created_at", { ascending: false })
      .limit(1);

    console.log(`[DEBUG] Resultado de consulta de usuario:`, userData);
    console.log(`[DEBUG] Error de consulta de usuario:`, userError);

    if (userError) {
      console.error(
        `[Queue] Worker ${workerId} - Error checking user credits:`,
        userError
      );
      throw userError;
    }

    if (!userData || userData[0]?.available_call_credits < 60) {
      // Cancel all pending calls for this user
      await cancelPendingCalls(
        queueItem.user_id,
        "No hay créditos suficientes (mínimo 60)"
      );

      // Update current queue item status
      await supabase
        .from("call_queue")
        .update({
          status: "cancelled",
          completed_at: new Date().toISOString(),
          error_message: "No hay créditos suficientes (mínimo 60)",
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
    const agentFirstName = userData[0]?.first_name || "Agente";
    const agentName =
      `${userData[0]?.first_name || ""} ${
        userData[0]?.last_name || ""
      }`.trim() || "Agente";

    // 🔍 AGREGAR LOGS DETALLADOS PARA DEBUGGING
    console.log("🔍 [AGENT DATA] User data for agent construction:", {
      userId: queueItem.user_id,
      userData: {
        first_name: userData[0]?.first_name,
        last_name: userData[0]?.last_name,
        assistant_name: userData[0]?.assistant_name,
        email: userData[0]?.email,
      },
      constructed: {
        agentFirstName: agentFirstName,
        agentName: agentName,
      },
    });

    console.log("🔍 [LEAD DATA] Lead data for call:", {
      leadId: queueItem.lead_id,
      lead: {
        name: queueItem.lead.name,
        phone: queueItem.lead.phone,
        email: queueItem.lead.email,
      },
    });
    // Obtener fecha en zona horaria de Nueva York
    const date = new Date();
    const nyDate = new Date(
      date.toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const diasSemana = [
      "Domingo",
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
    ];
    const dia_semana = diasSemana[nyDate.getDay()];
    const fecha = `${String(nyDate.getDate()).padStart(2, "0")}/${String(
      nyDate.getMonth() + 1
    ).padStart(2, "0")}/${String(nyDate.getFullYear()).slice(-2)}`;

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
        userData[0]?.twilio_phone_number &&
        userData[0]?.twilio_subaccount_sid &&
        userData[0]?.twilio_auth_token
      ) {
        // User has their own Twilio number, use it
        fromPhoneNumber = userData[0]?.twilio_phone_number;
        twilioClientToUse = new Twilio(
          userData[0]?.twilio_subaccount_sid,
          userData[0]?.twilio_auth_token
        );

        console.log(
          `[Queue] Worker ${workerId} - Using user's Twilio number:`,
          {
            userId: queueItem.user_id,
            fromNumber: fromPhoneNumber,
            subaccountSid: userData[0]?.twilio_subaccount_sid,
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
      const languageParam = encodeURIComponent(queueItem.lead.language || "es");

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

            .order("created_at", { ascending: false })
            .limit(1);

        if (
          !voiceSettingsError &&
          voiceSettingsData &&
          voiceSettingsData.length > 0
        ) {
          selectedVoiceId = voiceSettingsData[0].elevenlabs_voices?.voice_id;
          console.log(`🔊 [VOICE] ✅ User selected voice: ${selectedVoiceId}`);
        } else {
          console.log(
            `🔊 [VOICE] ❌ No voice selected for user, using default. Error: ${
              voiceSettingsError?.message || "No data found"
            }`
          );
          // Buscar voz por defecto en variable de entorno
          if (!selectedVoiceId && process.env.ELEVENLABS_DEFAULT_VOICE_ID) {
            selectedVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
            console.log(
              `🔊 [VOICE] Using fallback default voice from env: ${selectedVoiceId}`
            );
          }
          // Buscar en la base de datos la voz marcada como default
          if (!selectedVoiceId) {
            const { data: defaultVoice } = await supabase
              .from("elevenlabs_voices")
              .select("voice_id")
              .eq("is_default_for_new_users", true)
              .eq("is_active", true)
              .maybeSingle();
            if (defaultVoice?.voice_id) {
              selectedVoiceId = defaultVoice.voice_id;
              console.log(
                `🔊 [VOICE] Using fallback default voice from DB: ${selectedVoiceId}`
              );
            }
          }
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

      // Declarar idioma al principio para evitar errores de inicialización
      let idioma = queueItem.lead.language || "es";

      try {
        const { data: questionsData, error: questionsError } = await supabase
          .from("agent_questions")
          .select(
            "question_text, question_text_en, question_type, is_required, order_index"
          )
          .order("order_index", { ascending: true });

        if (!questionsError && questionsData && questionsData.length > 0) {
          const questionsList = questionsData
            .map((q, index) => {
              if (idioma === "en" && q.question_text_en) {
                return `${index + 1}. ${q.question_text_en}`;
              }
              return `${index + 1}. ${q.question_text}`;
            })
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

      console.log("[DEBUG] userData[0]", userData[0]);
      console.log("[DEBUG] userData[0].location:", userData[0]?.location);
      console.log(
        "[DEBUG] userData[0].location type:",
        typeof userData[0]?.location
      );
      console.log(
        "[DEBUG] userData[0].location length:",
        userData[0]?.location?.length
      );
      const agentLocation = userData[0]?.location || "Florida";
      console.log("[DEBUG] Final agentLocation:", agentLocation);
      const agentTitle = userData[0]?.title || "Agente Inmobiliario";
      // Traducción de agentTitle si idioma es inglés
      let agentTitleTranslated = agentTitle;
      if (idioma === "en") {
        if (agentTitle === "Agente Inmobiliario")
          agentTitleTranslated = "Realtor";
        else if (agentTitle === "Realtor") agentTitleTranslated = "Realtor";
        else if (agentTitle === "Broker") agentTitleTranslated = "Broker";
        else if (agentTitle === "Asesor Inmobiliario")
          agentTitleTranslated = "Real Estate Advisor";
        else if (agentTitle === "Consultor Inmobiliario")
          agentTitleTranslated = "Real Estate Consultant";
      }
      console.log(
        "[DEBUG] agentLocation",
        agentLocation,
        "agentTitle",
        agentTitle,
        "agentTitleTranslated",
        agentTitleTranslated
      );

      let firstMessage;
      if (idioma === "en") {
        firstMessage =
          "Hello {{client_name}}, I am {{assistant_name}}, assistant to {{agent_name}}, {{agent_title}} in {{agent_location}}. How are you?";
      } else {
        firstMessage =
          "Holaa {{client_name}}, soy {{assistant_name}}. Asistente de {{agent_name}},{{agent_title}} en {{agent_location}}. ¿Cómo estás?";
      }

      let promptOverride = undefined;
      if (idioma === "en") {
        promptOverride = `You are a professional assistant with a friendly, trustworthy, and persuasive tone, specialized in the real estate sector in {{agent_location}}. You should sound charming and always smile. You speak neutral English or Spanish and communicate clearly and effectively with clients interested in buying properties. Avoid sounding robotic; speak fluently and empathetically, as a real advisor would. Always call the client by their name. Under no circumstances repeat exactly the same phrases to the client during a call. Do not leave too much time for the client to respond; if there is a pause, continue. Use short sentences.
Be careful with voicemail. If you detect a machine answering to leave a message or if there is no response after your greeting and a second attempt to connect, hang up. Keep the call as short as possible if the client does not respond.
Important: If you are asked to leave a message after the tone or something similar, or if the phone number is repeated automatically, it is a machine and you should hang up. When you say you will end the call, end it. If it seems like a series of numbers has been listed, it is a voicemail. End the call no matter what.
First, greet to build rapport and explain the reason for the call.
The conversation should not last more than 7 minutes.
Objective:
Your mission is to contact people who registered in an ad because they might be interested in buying a property in {{agent_location}}. Your goal is to build trust, answer their questions, and schedule an appointment with {{agent_name}} so they can get more information and move forward in the process.
If they are interested, your goal is to schedule a call—use all your charm to achieve it.
Conversation Strategy:
1 Discover Interest and Needs
Ask questions to understand the prospect's situation, similar to:
{{preguntas}}
You must follow the entire question guide. Wait for the client's answer to one question before asking the next. Ask one question at a time.
The questions cannot always be the same; use similar variants.
2 Generate Interest and Trust
Highlight the value of speaking with {{agent_firstname}} with expressions like:
"{{agent_firstname}} helps buyers like you find excellent options" or "{{agent_firstname}} can answer any questions about financing, locations, and processes."
3 Schedule the Appointment
Before scheduling, you must have received answers to the {{preguntas}}.
Propose specific times naturally:
Important: We describe calendar availability in {{calendar_availability}}, always tell them it is {{agent_location}} time.
For example: "We can schedule a call with {{agent_firstname}} to review your options."
Propose 2 specific half-hour slots according to availability in {{calendar_availability}}. Schedule on weekdays, starting tomorrow. Remember today is {{fecha}} (format dd/MM/YY) and today is {{dia_semana}}. Try to make the call as soon as possible according to availability in {{calendar_availability}} ({{agent_location}} time).
If the prospect cannot make those times, ask for their availability:
"I understand, what day and time works best for you?"
Then, after they propose, say:
"Let me check the schedule…" pause briefly and check {{calendar_availability}}. If the date and time are available, say "Perfect, we can schedule it." Otherwise, propose another available time that same day or another as soon as possible.
4 Confirmation and Closing
Confirm the appointment clearly and enthusiastically:
"Done, scheduled for [day and time]. I will send you the call link shortly. I'm sure it will be a very useful conversation for you!"
Mention the specific day and time when confirming. The current date is {{fecha}} (format dd/MM/YY) and today is {{dia_semana}}. Example confirmation: next Wednesday, April 9 at 10am. You must mention the date; I need it included in the call summary.
Reinforce the importance of the meeting:
"I'm sure this call will help you clarify everything and get closer to the property you are looking for. See you soon!"
Try to use {{client_name}} as the name of the person you are talking to! Respond with short sentences.
If they start asking more things, try to tell them that {{agent_firstname}} can help with more details, and if they haven't scheduled, take the opportunity to do so. End the call by thanking them and saying goodbye before hanging up. Very important: Mention the exact date of the appointment if achieved; make sure the date matches what was agreed with the client according to the calendar. Use the field {{fecha}} (format dd/MM/YY) as a reference for today's date and {{dia_semana}} for the day of the week. Very important: avoid using very long sentences of more than one statement.
Other client data not part of the conversation: {{client_phone}}{{client_email}}{{client_id}}
`;
      }

      console.log(
        `[Queue] Worker ${workerId} - Creating Twilio call with params:`,
        {
          from: fromPhoneNumber,
          to: queueItem.lead.phone,
          userId: queueItem.user_id,
          leadId: queueItem.lead_id,
        }
      );

      call = await twilioClientToUse.calls.create({
        from: fromPhoneNumber,
        to: queueItem.lead.phone,
        url: `https://${RAILWAY_PUBLIC_DOMAIN}/outbound-call-twiml?prompt=${encodeURIComponent(
          "Eres un asistente de ventas inmobiliarias."
        )}&first_message=${encodeURIComponent(
          firstMessage
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
          userData[0]?.assistant_name
        )}&calendar_availability=${availabilityParam}&calendar_timezone=${timezoneParam}${voiceParam}${customLlmParam}&agent_location=${encodeURIComponent(
          agentLocation
        )}&agent_title=${encodeURIComponent(
          agentTitleTranslated
        )}&conversation_language=${encodeURIComponent(
          idioma
        )}&language=${languageParam}`,
        statusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-status`,
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
        record: true,
        recordingStatusCallback: `https://${RAILWAY_PUBLIC_DOMAIN}/twilio-recording-status`,
        recordingStatusCallbackMethod: "POST",
        recordingChannels: "dual",
        recordingStatusCallbackEvent: ["completed"],
      });

      console.log(
        `[Queue] Worker ${workerId} - Twilio call created successfully:`,
        {
          callSid: call.sid,
          callStatus: call.status,
          userId: queueItem.user_id,
          leadId: queueItem.lead_id,
        }
      );
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
      } else if (
        twilioError.message.toLowerCase().includes("geo-permissions") ||
        twilioError.message.toLowerCase().includes("not authorized to call") ||
        twilioError.message
          .toLowerCase()
          .includes("international permissions") ||
        translatedError.message.toLowerCase().includes("país no autorizado")
      ) {
        result = "país no autorizado";
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
    console.log(`[Queue] Worker ${workerId} - Registering call in database:`, {
      callSid: call.sid,
      userId: queueItem.user_id,
      leadId: queueItem.lead_id,
      queueId: queueItem.id,
    });

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

async function getSignedUrl(options = {}) {
  const { agentId = ELEVENLABS_AGENT_ID } = options;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
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
    language,
  } = request.body;

  console.log("🌐 [OUTBOUND-CALL] Idioma recibido:", language);

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

    .order("created_at", { ascending: false })
    .limit(1);

  if (userError || !userData || userData.length === 0) {
    console.error("[API] Error fetching user data:", userError);

    // Verificar si la cuenta está activa
    if (!userData[0]?.is_active) {
      console.error("[API] User account is disabled:", { userId: user_id });
      return reply.code(403).send({ error: "User account is disabled" });
    }

    // Verificar consentimiento legal básico (términos y privacidad)
    if (!userData[0]?.terms_accepted_at || !userData[0]?.privacy_accepted_at) {
      console.error("[API] User missing basic legal consent:", {
        userId,
        terms: userData[0]?.terms_accepted_at,
        privacy: userData[0]?.privacy_accepted_at,
      });
      return reply.code(403).send({
        error:
          "Legal consent required. Please accept terms and privacy policy.",
      });
    }

    // Verificar consentimiento para llamadas automatizadas
    if (!userData[0]?.automated_calls_consent) {
      console.error("[API] User missing automated calls consent:", {
        userId,
        automated_calls_consent: userData[0]?.automated_calls_consent,
      });
      return reply.code(403).send({
        error:
          "Automated calls consent required. Please accept automated calls consent.",
      });
    }

    // Verificar si tiene minutos disponibles (a menos que sea admin)
    if (
      !userData[0]?.is_admin &&
      (!userData[0]?.available_minutes || userData[0]?.available_minutes <= 0)
    ) {
      console.error("[API] User has no available minutes:", {
        userId,
        available_minutes: userData[0]?.available_minutes,
      });
      return reply.code(403).send({ error: "No available minutes" });
    }
    return reply.code(400).send({ error: "User not found" });
  }

  // Determine which phone number and Twilio client to use
  let fromPhoneNumber = TWILIO_PHONE_NUMBER; // Default
  let twilioClientToUse = twilioClient; // Default

  if (
    userData[0]?.twilio_phone_number &&
    userData[0]?.twilio_subaccount_sid &&
    userData[0]?.twilio_auth_token
  ) {
    // User has their own Twilio number, use it
    fromPhoneNumber = userData[0]?.twilio_phone_number;
    twilioClientToUse = new Twilio(
      userData[0]?.twilio_subaccount_sid,
      userData[0]?.twilio_auth_token
    );

    console.log("[API] Using user's Twilio number:", {
      userId: user_id,
      fromNumber: fromPhoneNumber,
      subaccountSid: userData[0]?.twilio_subaccount_sid,
    });
  } else {
    console.log("[API] Using default Twilio number:", fromPhoneNumber);
  }

  // Create agent_name from first_name and last_name
  const agentFirstName = userData[0]?.first_name || "Agente";
  const agentName =
    `${userData[0]?.first_name || ""} ${userData[0]?.last_name || ""}`.trim() ||
    "Agente";

  // Obtener fecha en zona horaria de Nueva York
  const date = new Date();
  const nyDate = new Date(
    date.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const diasSemana = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ];
  const dia_semana = diasSemana[nyDate.getDay()];
  const fecha = `${String(nyDate.getDate()).padStart(2, "0")}/${String(
    nyDate.getMonth() + 1
  ).padStart(2, "0")}/${String(nyDate.getFullYear()).slice(-2)}`;

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
      )}&assistant_name=${encodeURIComponent(
        userData[0]?.assistant_name
      )}&language=${encodeURIComponent(language)}`,
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
  console.log("[DEBUG] /outbound-call-twiml params:", request.query);
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
    agent_location,
    agent_title,
    language,
  } = request.query;

  console.log(`🔊 [TWiML] Received user_voice_id: "${user_voice_id}"`);
  console.log("🌐 [TWiML] Idioma recibido en query:", language);

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
          <Parameter name="agent_location" value="${escapeXml(
            agent_location
          )}" />
          <Parameter name="agent_title" value="${escapeXml(agent_title)}" />
          <Parameter name="language" value="${escapeXml(language)}" />
        </Stream>
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Your existing WebSocket endpoint registration
fastify.register(async (fastifyInstance) => {
  // Add incoming media stream endpoint
  fastifyInstance.get(
    "/incoming-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to incoming media stream");

      let streamSid = null;
      let callSid = null;
      let agentId = null;
      let elevenLabsWs = null;

      ws.on("error", console.error);

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.event === "start") {
            streamSid = message.start.streamSid;
            callSid = message.start.callSid;
            const fromNumber =
              message.start.customParameters?.fromNumber || "unknown";

            console.log("📞 [INCOMING] Stream started:", {
              streamSid,
              callSid,
              fromNumber,
            });

            // 🔗 Conectar WS a ElevenLabs con el agente específico para incoming calls
            try {
              const agentId = "agent_9001k3m4b0y4fhyvwc9car16yqw2";
              const signedUrl = await getSignedUrl({ agentId });

              console.log(
                "🔍 [ELEVENLABS] Connecting to signed URL for agent:",
                agentId
              );

              elevenLabsWs = new WebSocket(signedUrl);

              elevenLabsWs.on("open", () => {
                console.log("✅ [ELEVENLABS] WS connected");

                // Configuración simple para incoming calls
                const initialConfig = {
                  type: "conversation_initiation_client_data",
                  conversation_config_override: {
                    keep_alive: true,
                  },
                  usage: {
                    no_ip_reason: "user_ip_not_collected",
                  },
                };

                elevenLabsWs.send(JSON.stringify(initialConfig));
              });

              elevenLabsWs.on("message", (raw) => {
                let evt;
                try {
                  evt = JSON.parse(raw.toString());
                } catch {
                  /* puede venir binario en releases muy viejas */
                }

                // ⚠️ Maneja eventos del agente:
                // Espera tipos como: "audio", "agent_response", "user_transcript", "error", etc.
                if (evt && evt.type === "audio") {
                  const audioPayload =
                    evt.audio?.chunk ||
                    evt.audio_event?.audio_base_64 ||
                    evt.audio_base64;

                  if (audioPayload) {
                    // 🔊 Reenviar audio del agente -> de vuelta a Twilio (mulaw base64)
                    console.log(
                      "🔊 [ELEVENLABS] Sending audio to Twilio, length:",
                      audioPayload.length
                    );
                    ws.send(
                      JSON.stringify({
                        event: "media",
                        streamSid,
                        media: { payload: audioPayload },
                      })
                    );
                  } else {
                    console.log(
                      "⚠️ [ELEVENLABS] Audio event received but no payload found:",
                      evt
                    );
                  }
                } else if (evt && evt.type === "agent_response") {
                  console.log("🗣️ [ELEVENLABS] agent_response:", evt.text);
                } else if (evt && evt.type === "user_transcript") {
                  console.log("👤 [USER] transcript:", evt.text);
                } else if (evt && evt.type === "error") {
                  console.error("❌ [ELEVENLABS] error:", evt.message || evt);
                } else {
                  console.log(
                    "🔍 [ELEVENLABS] Received event:",
                    evt?.type || "unknown"
                  );
                  // Si ElevenLabs manda audio crudo (raro), intenta fallback:
                  if (!evt && Buffer.isBuffer(raw)) {
                    const base64 = raw.toString("base64");
                    console.log(
                      "🔊 [ELEVENLABS] Sending raw audio to Twilio, length:",
                      base64.length
                    );
                    ws.send(
                      JSON.stringify({
                        event: "media",
                        streamSid,
                        media: { payload: base64 },
                      })
                    );
                  }
                }
              });

              elevenLabsWs.on("error", (error) => {
                console.error("❌ [ELEVENLABS] WS error:", error);
              });

              elevenLabsWs.on("close", () => {
                console.log("📞 [ELEVENLABS] WS closed");
              });
            } catch (error) {
              console.error(
                "❌ [ELEVENLABS] Error connecting to agent:",
                error
              );
            }
          } else if (message.event === "media") {
            // 🎙️ Audio del llamante -> enviar a ElevenLabs
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              console.log(
                "🎙️ [TWILIO] Received audio from caller, length:",
                message.media.payload.length
              );
              // Twilio te entrega media.payload en base64 mulaw 8kHz mono
              const frame = {
                type: "user_audio_chunk",
                user_audio_chunk: message.media.payload,
              };
              elevenLabsWs.send(JSON.stringify(frame));
            } else {
              console.log(
                "⚠️ [TWILIO] ElevenLabs WebSocket not ready, state:",
                elevenLabsWs?.readyState
              );
            }
          } else if (message.event === "mark") {
            // opcional: marks de Twilio
          } else if (message.event === "stop") {
            console.log("📞 [INCOMING] Stream stopped");
            if (elevenLabsWs) elevenLabsWs.close();
          }
        } catch (error) {
          console.error("❌ [INCOMING] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("📞 [INCOMING] WebSocket connection closed");
        if (elevenLabsWs) elevenLabsWs.close();
      });
    }
  );

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
      let bufferSize = 1; // 🚀 ULTRA RÁPIDO: Buffer mínimo para latencia ultra baja (reducido de 5 a 1)
      let bufferTimeout = null; // Timeout para enviar buffer parcial

      // 🆕 NUEVAS VARIABLES PARA MEJORAR DETECCIÓN DE DUPLICADOS
      let lastAudioHash = null; // Hash del último chunk de audio enviado
      let consecutiveDuplicates = 0; // Contador de duplicados consecutivos
      let maxConsecutiveDuplicates = 3; // Máximo de duplicados consecutivos permitidos
      let audioSequenceId = 0; // ID secuencial para tracking de chunks
      let lastProcessedSequence = -1; // Último sequence ID procesado
      let audioChunkTimestamps = new Map(); // Timestamps de chunks para detectar duplicados
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

      // 🆕 FUNCIÓN SIMPLIFICADA PARA VERIFICAR SI UN CHUNK ES DUPLICADO
      const isDuplicateAudioChunk = (audioChunk) => {
        // Verificación simplificada para reducir latencia
        if (sentAudioChunks.has(audioChunk)) {
          return true;
        }

        // Solo verificar hash básico para duplicados consecutivos
        const audioHash = generateAudioHash(audioChunk);
        if (lastAudioHash === audioHash) {
          return true;
        }

        lastAudioHash = audioHash;
        return false;
      };

      // 🆕 FUNCIÓN SIMPLIFICADA PARA LIMPIAR ESTADO DE AUDIO
      const clearAudioState = () => {
        sentAudioChunks.clear();
        audioChunkCounter = 0;
        audioBuffer = [];
        lastAudioHash = null;
        audioSequenceId = 0;
        lastProcessedSequence = -1;

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

      // Verificar silencios cada 5 segundos (reducido para menos interferencia)
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
          // Enviar todos los chunks del buffer inmediatamente
          audioBuffer.forEach((chunk) => {
            elevenLabsConnections.get(callSid)?.send(
              JSON.stringify({
                type: "user_audio_chunk",
                user_audio_chunk: chunk,
              })
            );
          });

          // Limpiar buffer inmediatamente
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

            // 🔍 AGREGAR LOGS DETALLADOS PARA DEBUGGING
            console.log("🔍 [ELEVENLABS CONFIG] Custom parameters received:", {
              client_name: customParameters?.client_name,
              client_phone: customParameters?.client_phone,
              client_email: customParameters?.client_email,
              client_id: customParameters?.client_id,
              fecha: customParameters?.fecha,
              dia_semana: customParameters?.dia_semana,
              agent_firstname: customParameters?.agent_firstname,
              agent_name: customParameters?.agent_name,
              assistant_name: customParameters?.assistant_name,
              calendar_availability: customParameters?.calendar_availability,
              calendar_timezone: customParameters?.calendar_timezone,
              user_voice_id: customParameters?.user_voice_id,
              custom_llm_prompt: customParameters?.custom_llm_prompt
                ? "Present"
                : "Not present",
              agent_location: customParameters?.agent_location,
              agent_title: customParameters?.agent_title,
            });
            const webhookLanguage = customParameters?.language || "es";
            console.log(
              "🔍 [ELEVENLABS CONFIG] Custom language:",
              webhookLanguage
            );

            // ... justo antes de armar initialConfig ...
            let promptOverride = undefined;
            if (webhookLanguage === "en") {
              promptOverride = `You are a professional assistant with a friendly, trustworthy, and persuasive tone, specialized in the real estate sector in {{agent_location}}. You should sound charming and always smile. You speak neutral English or Spanish and communicate clearly and effectively with clients interested in buying properties. Avoid sounding robotic; speak fluently and empathetically, as a real advisor would. Always call the client by their name. Under no circumstances repeat exactly the same phrases to the client during a call. Do not leave too much time for the client to respond; if there is a pause, continue. Use short sentences.
Be careful with voicemail. If you detect a machine answering to leave a message or if there is no response after your greeting and a second attempt to connect, hang up. Keep the call as short as possible if the client does not respond.
Important: If you are asked to leave a message after the tone or something similar, or if the phone number is repeated automatically, it is a machine and you should hang up. When you say you will end the call, end it. If it seems like a series of numbers has been listed, it is a voicemail. End the call no matter what.
First, greet to build rapport and explain the reason for the call.
The conversation should not last more than 7 minutes.
Objective:
Your mission is to contact people who registered in an ad because they might be interested in buying a property in {{agent_location}}. Your goal is to build trust, answer their questions, and schedule an appointment with {{agent_name}} so they can get more information and move forward in the process.
If they are interested, your goal is to schedule a call—use all your charm to achieve it.
Conversation Strategy:
1 Discover Interest and Needs
Ask questions to understand the prospect's situation, similar to:
{{preguntas}}
You must follow the entire question guide. Wait for the client's answer to one question before asking the next. Ask one question at a time.
The questions cannot always be the same; use similar variants.
2 Generate Interest and Trust
Highlight the value of speaking with {{agent_firstname}} with expressions like:
"{{agent_firstname}} helps buyers like you find excellent options" or "{{agent_firstname}} can answer any questions about financing, locations, and processes."
3 Schedule the Appointment
Before scheduling, you must have received answers to the {{preguntas}}.
Propose specific times naturally:
Important: We describe calendar availability in {{calendar_availability}}, always tell them it is {{agent_location}} time.
For example: "We can schedule a call with {{agent_firstname}} to review your options."
Propose 2 specific half-hour slots according to availability in {{calendar_availability}}. Schedule on weekdays, starting tomorrow. Remember today is {{fecha}} (format dd/MM/YY) and today is {{dia_semana}}. Try to make the call as soon as possible according to availability in {{calendar_availability}} ({{agent_location}} time).
If the prospect cannot make those times, ask for their availability:
"I understand, what day and time works best for you?"
Then, after they propose, say:
"Let me check the schedule…" pause briefly and check {{calendar_availability}}. If the date and time are available, say "Perfect, we can schedule it." Otherwise, propose another available time that same day or another as soon as possible.
4 Confirmation and Closing
Confirm the appointment clearly and enthusiastically:
"Done, scheduled for [day and time]. I will send you the call link shortly. I'm sure it will be a very useful conversation for you!"
Mention the specific day and time when confirming. The current date is {{fecha}} (format dd/MM/YY) and today is {{dia_semana}}. Example confirmation: next Wednesday, April 9 at 10am. You must mention the date; I need it included in the call summary.
Reinforce the importance of the meeting:
"I'm sure this call will help you clarify everything and get closer to the property you are looking for. See you soon!"
Try to use {{client_name}} as the name of the person you are talking to! Respond with short sentences.
If they start asking more things, try to tell them that {{agent_firstname}} can help with more details, and if they haven't scheduled, take the opportunity to do so. End the call by thanking them and saying goodbye before hanging up. Very important: Mention the exact date of the appointment if achieved; make sure the date matches what was agreed with the client according to the calendar. Use the field {{fecha}} (format dd/MM/YY) as a reference for today's date and {{dia_semana}} for the day of the week. Very important: avoid using very long sentences of more than one statement.
Other client data not part of the conversation: {{client_phone}}{{client_email}}{{client_id}}
`;
            }
            let firstMessage;
            if (webhookLanguage === "en") {
              firstMessage =
                "Hello {{client_name}}, I am {{assistant_name}}, assistant to {{agent_name}}, {{agent_title}} in {{agent_location}}. How are you?";
            } else {
              firstMessage =
                "Holaa {{client_name}}, soy {{assistant_name}}. Asistente de {{agent_name}},{{agent_title}} en {{agent_location}}. ¿Cómo estás?";
            }
            // ...

            // Al armar initialConfig:
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  language: webhookLanguage,
                  agent_id: ELEVENLABS_AGENT_ID,
                  first_message: firstMessage, // solo agrega esta línea
                  ...(promptOverride
                    ? { prompt: { prompt: promptOverride } }
                    : {}),
                },
                tts: {
                  voice_id:
                    customParameters?.user_voice_id ||
                    customParameters?.voice_id ||
                    "",
                },
                keep_alive: true,
                // 🚀 ULTRA RÁPIDO: Configuraciones adicionales para latencia mínima
                conversation_config: {
                  enable_fast_response: true, // Habilitar respuesta rápida
                  enable_instant_processing: true, // Procesamiento instantáneo
                  response_timeout: 0.5, // Timeout de respuesta de 0.5 segundos
                },
                // 🚀 OPTIMIZADO: Configuraciones para reducir latencia de respuesta
                processing_config: {
                  enable_streaming: true, // Habilitar streaming para respuestas más rápidas
                  enable_early_termination: true, // Terminación temprana para respuestas más ágiles
                  response_delay_threshold: 0.1, // 🚀 ULTRA RÁPIDO: 0.1 segundos para respuesta inmediata
                  enable_realtime_processing: true, // Procesamiento en tiempo real
                  enable_instant_response: true, // Respuesta instantánea
                },

                interruption_settings: {
                  enabled: true,
                  sensitivity: "ultra_high", // 🚀 ULTRA RÁPIDO: Sensibilidad ultra alta para detección inmediata
                  min_duration: 0.1, // 🚀 ULTRA RÁPIDO: 0.1 segundos para detección instantánea del fin de habla
                  max_duration: 0.5, // 🚀 ULTRA RÁPIDO: 0.5 segundos máximo para respuestas ultra rápidas
                  cooldown_period: 0.1, // 🚀 ULTRA RÁPIDO: 0.1 segundos de cooldown para reactividad máxima
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
                agent_name: customParameters?.agent_name || "Agente",
                assistant_name:
                  customParameters?.assistant_name || "Asistente de Ventas",
                calendar_availability:
                  customParameters?.calendar_availability ||
                  "Disponible todos los dias",
                calendar_timezone:
                  customParameters?.calendar_timezone || "America/New_York",
                preguntas: customParameters?.custom_llm_prompt || "",
                agent_title:
                  customParameters?.agent_title || "Agente Inmobiliario",
                agent_location: customParameters?.agent_location || "Florida",
                conversation_language: webhookLanguage,
              },
              usage: {
                no_ip_reason: "user_ip_not_collected",
              },
            };

            // 🔍 LOG DE LA CONFIGURACIÓN FINAL
            console.log("🔍 [ELEVENLABS CONFIG] Final config being sent:", {
              agent_firstname: initialConfig.dynamic_variables.agent_firstname,
              agent_name: initialConfig.dynamic_variables.agent_name,
              assistant_name: initialConfig.dynamic_variables.assistant_name,
              client_name: initialConfig.dynamic_variables.client_name,
              agent_location: initialConfig.dynamic_variables.agent_location,
            });

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

                // console.log(
                //   `[ElevenLabs] Message:`,
                //   JSON.stringify(message, null, 2)
                // );

                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log(
                      "🚀 [INIT] Conversation initiation metadata received"
                    );
                    console.log("🔍 [INIT] Message data:", {
                      callSid: callSid,
                      conversation_id:
                        message.conversation_initiation_metadata_event
                          ?.conversation_id,
                      hasEvent:
                        !!message.conversation_initiation_metadata_event,
                    });

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
                        "💾 [INIT] Saving conversation_id to database:",
                        {
                          call_sid: callSid,
                          conversation_id: conversationId,
                        }
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
                        } else {
                          console.log(
                            "✅ [INIT] Successfully saved conversation_id:",
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
                      console.log("⚠️ [INIT] Cannot save conversation_id:", {
                        hasCallSid: !!callSid,
                        hasConversationId:
                          !!message.conversation_initiation_metadata_event
                            ?.conversation_id,
                      });
                    }
                    break;

                  case "audio":
                    if (streamSid) {
                      const audioPayload =
                        message.audio?.chunk ||
                        message.audio_event?.audio_base_64;

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
                    console.log("🔊 [AUDIO] Audio chunk received");
                    if (!interrupted) {
                      wsClient.send(message.audio);
                    }
                    break;

                  case "message_response":
                    console.log(
                      `[ElevenLabs] Full message_response:`,
                      JSON.stringify(message, null, 2)
                    );
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
                    // 🆕 OPTIMIZADO: Limpieza rápida durante interrupciones
                    audioBuffer = [];
                    if (bufferTimeout) {
                      clearTimeout(bufferTimeout);
                      bufferTimeout = null;
                    }
                    // Solo enviar clear si no estamos en modo de detección de buzón de voz
                    if (!isVoicemailDetectionMode) {
                      sendClearToTwilio(streamSid);
                      interrupted = false;
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
                        "después del tono",
                        "despues del tono",
                        "buzón de voz",
                        "buzon de voz",
                        "no está disponible",
                        "no esta disponible",
                        "no contesta",
                        "no responde",
                        "contestador",
                        "grabadora",

                        // English phrases - solo las más comunes
                        "leave a message",
                        "after the tone",
                        "voicemail",
                        "not available",
                        "not answering",
                        "answering machine",
                        "grabe su mensaje",
                        "tecla gato",
                      ].some((phrase) => {
                        const normalizedPhrase = phrase
                          .toLowerCase()
                          .normalize("NFD")
                          .replace(/[\u0300-\u036f]/g, "");
                        return normalizedTranscript.includes(normalizedPhrase);
                      });

                      // Enhanced numeric sequence detection - OPTIMIZED
                      const normalizedDigits = transcript.replace(/\D/g, "");
                      const hasNumericSequence =
                        normalizedDigits.length >= 7 ||
                        /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(transcript) ||
                        /\d{4}[-.\s]?\d{3}[-.\s]?\d{3}/.test(transcript) ||
                        /\d{3}[-.\s]?\d{4}[-.\s]?\d{4}/.test(transcript);

                      // Detect when system is saying the phone number being called
                      const phoneNumberPattern =
                        customParameters?.client_phone?.replace(/[^\d]/g, "") ||
                        "";
                      const hasPhoneNumberSequence =
                        phoneNumberPattern &&
                        phoneNumberPattern.length > 0 &&
                        (() => {
                          // Buscar secuencias de al menos 4 dígitos consecutivos del número
                          for (
                            let i = 0;
                            i <= phoneNumberPattern.length - 4;
                            i++
                          ) {
                            const sequence = phoneNumberPattern.substring(
                              i,
                              i + 4
                            );
                            if (transcript.includes(sequence)) {
                              return true;
                            }
                          }
                          return false;
                        })();

                      // Check for consecutive number sequences that might be the phone number
                      const consecutiveNumbers = transcript.match(/\d+/g) || [];
                      const hasConsecutivePhoneNumbers =
                        phoneNumberPattern &&
                        consecutiveNumbers.some(
                          (num) =>
                            num.length >= 4 && phoneNumberPattern.includes(num)
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
                            // Get call data to find the user
                            const { data: callData, error: callError } =
                              await supabase
                                .from("calls")
                                .select("user_id")
                                .eq("call_sid", callSid)
                                .single();

                            // Get the correct Twilio client
                            const { client: twilioClientToUse, accountInfo } =
                              await getTwilioClientForUser(callData?.user_id);

                            await twilioClientToUse
                              .calls(callSid)
                              .update({ status: "completed" });
                            console.log(
                              `[Twilio] Call ${callSid} ended using ${accountInfo}.`
                            );
                          } catch (err) {
                            console.error("[Twilio] Error ending call:", err);
                          }
                        }

                        if (ws.readyState === WebSocket.OPEN) {
                          ws.close();
                        }
                      }
                    }, 50); // Delay reducido a 50ms para respuesta más rápida
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

                          // Release worker for timeout
                          const callInfo = globalActiveCalls.get(callSid);
                          if (callInfo && callInfo.workerId) {
                            const released = releaseWorker(
                              callInfo.workerId,
                              "conversation_timeout"
                            );
                            if (released) {
                              globalActiveCalls.delete(callSid);
                              console.log(
                                `[Queue] ✅ Worker ${callInfo.workerId} released due to conversation timeout`
                              );
                            }
                          }
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

                          // Release worker for conversation failure
                          const callInfo = globalActiveCalls.get(callSid);
                          if (callInfo && callInfo.workerId) {
                            const released = releaseWorker(
                              callInfo.workerId,
                              "conversation_failed"
                            );
                            if (released) {
                              globalActiveCalls.delete(callSid);
                              console.log(
                                `[Queue] ✅ Worker ${callInfo.workerId} released due to conversation failure`
                              );
                            }
                          }
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

                          // Release worker for no user response
                          const callInfo = globalActiveCalls.get(callSid);
                          if (callInfo && callInfo.workerId) {
                            const released = releaseWorker(
                              callInfo.workerId,
                              "no_user_response"
                            );
                            if (released) {
                              globalActiveCalls.delete(callSid);
                              console.log(
                                `[Queue] ✅ Worker ${callInfo.workerId} released due to no user response`
                              );
                            }
                          }
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

                  case "agent_tool_response": {
                    const tool = message.agent_tool_response || message; // soporta formato anidado o plano
                    const toolName =
                      tool.tool_name || message.tool_name || "unknown";
                    const toolType =
                      tool.tool_type || message.tool_type || "unknown";
                    const isError = tool.is_error === true;
                    const toolCallId =
                      tool.tool_call_id || message.tool_call_id;

                    console.log(
                      `🔧 [TOOL] Agent tool response - Tool: ${toolName} | Type: ${toolType} | Error: ${isError} | CallId: ${
                        toolCallId || "n/a"
                      }`
                    );

                    const payload = tool.tool_response || message.tool_response;
                    if (payload !== undefined) {
                      console.log("🔧 [TOOL] Payload:", payload);
                      if (toolName === "voicemail_detection") {
                        console.log(
                          `📞 [VOICEMAIL] Detection result: ${payload?.voicemail_detected}`
                        );
                      }
                    }

                    // Solo log, no altera el flujo de la llamada
                    if (toolName === "end_call") {
                      console.log(
                        "🔚 [TOOL] end_call solicitado por el agente"
                      );
                    }
                    break;
                  }

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
                  // Get call data to find the user
                  const { data: callData, error: callError } = await supabase
                    .from("calls")
                    .select("user_id")
                    .eq("call_sid", callSid)
                    .single();

                  // Get the correct Twilio client
                  const { client: twilioClientToUse, accountInfo } =
                    await getTwilioClientForUser(callData?.user_id);

                  await twilioClientToUse
                    .calls(callSid)
                    .update({ status: "completed" });
                  console.log(
                    `[Twilio] Call ${callSid} ended due to ElevenLabs disconnection using ${accountInfo}.`
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

              // console.log(
              console.log("🔍 [WEBSOCKET DEBUG] Received customParameters:", {
                agent_firstname: customParameters?.agent_firstname,
                agent_name: customParameters?.agent_name,
                assistant_name: customParameters?.assistant_name,
                client_name: customParameters?.client_name,
                client_phone: customParameters?.client_phone,
                client_email: customParameters?.client_email,
              });
              //   `🔊 [WebSocket] Received user_voice_id: "${customParameters?.user_voice_id}"`
              // );

              // Setup ElevenLabs AFTER receiving customParameters
              // Setup ElevenLabs AFTER receiving customParameters
              // Verificar que no se haya configurado ya para esta llamada
              if (
                !elevenLabsConnections.has(callSid) ||
                elevenLabsConnections.get(callSid)?.readyState !==
                  WebSocket.OPEN
              ) {
                // console.log(
                //   `[ElevenLabs] Setting up new connection for callSid: ${callSid}`
                // );
                setupElevenLabs();
              } else {
                // console.log( `[ElevenLabs] Connection already exists for callSid: ${callSid}, skipping setup` );
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

                // Validar que el audio no esté vacío
                if (!audioChunk || audioChunk.length < 10) {
                  //console.log("[Audio] Skipping empty or invalid audio chunk");
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
                    // console.log( `[Audio] Skipping out-of-order chunk: current=${currentSequence}, last=${lastProcessedSequence}`);
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

                  // 🚀 ULTRA RÁPIDO: Envío inmediato para latencia mínima
                  if (audioBuffer.length >= bufferSize) {
                    sendAudioBuffer();
                  } else {
                    // Timeout ultra corto para respuesta inmediata
                    bufferTimeout = setTimeout(() => {
                      if (audioBuffer.length > 0) {
                        sendAudioBuffer();
                      }
                    }, 20); // 🚀 ULTRA RÁPIDO: 20ms timeout para latencia mínima
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
                  // console.log("[Audio] Skipping duplicate audio chunk");
                }
              } else {
                // console.log("[Audio] ElevenLabs WebSocket not ready, skipping audio chunk");
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
        // Get the correct Twilio client for this call
        const { client: twilioClientToUse, accountInfo } =
          await getTwilioClientForUser(call.user_id);

        // Get the actual call status from Twilio
        const twilioCall = await twilioClientToUse.calls(call.call_sid).fetch();

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
          // Check if call has been running too long (more than 15 minutes)
          const callStartTime = new Date(call.created_at);
          const now = new Date();
          const durationMinutes = (now - callStartTime) / (1000 * 60);

          if (durationMinutes > 15) {
            console.log(
              `[CLEANUP] Call ${
                call.call_sid
              } has been running for ${Math.round(
                durationMinutes
              )} minutes - hanging up`
            );

            try {
              // Hang up the call using the correct client
              await twilioClientToUse
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
                  error_message: "Call hung up due to timeout (15+ minutes)",
                  connection_status: "no_connection",
                  connection_failure_reason: "timeout_15_minutes",
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
      console.log(`[CLEANUP] Found ${stuckQueue.length} stuck queue items`);

      for (const queueItem of stuckQueue) {
        const { data: associatedCall } = await supabase
          .from("calls")
          .select("status, created_at")
          .eq("queue_id", queueItem.id)
          .order("created_at", { ascending: false })
          .limit(1);

        console.log(
          `[CLEANUP] Queue item ${queueItem.id}: associated call status = ${
            associatedCall?.status || "none"
          }`
        );

        // Only mark as completed if:
        // 1. There's no associated call (orphaned queue item)
        // 2. The call is actually finished (completed, failed, etc.)
        // 3. The call has been running for more than 20 minutes (stuck)

        let shouldMarkCompleted = false;
        let reason = "";

        if (!associatedCall) {
          shouldMarkCompleted = true;
          reason = "no_associated_call";
        } else if (
          ["completed", "failed", "busy", "no-answer", "canceled"].includes(
            associatedCall.status
          )
        ) {
          shouldMarkCompleted = true;
          reason = `call_${associatedCall.status}`;
        } else if (associatedCall.status === "In Progress") {
          // Check if call has been running too long (more than 20 minutes)
          const callStartTime = new Date(
            queueItem.started_at || queueItem.created_at
          );
          const now = new Date();
          const durationMinutes = (now - callStartTime) / (1000 * 60);

          if (durationMinutes > 20) {
            shouldMarkCompleted = true;
            reason = "call_stuck_too_long";
          }
        }

        if (shouldMarkCompleted) {
          console.log(
            `[CLEANUP] Marking queue item ${queueItem.id} as completed - reason: ${reason}`
          );
          await supabase
            .from("call_queue")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", queueItem.id);
        } else {
          console.log(
            `[CLEANUP] Queue item ${queueItem.id} still active - call status: ${associatedCall?.status}`
          );
        }
      }
    }
  } catch (error) {
    console.error("[CLEANUP] Error during cleanup:", error);
  }
}
// Your existing twilio-status endpoint with enhanced logging and error handling
fastify.post("/twilio-status", async (request, reply) => {
  //console.log("📞 [TWILIO STATUS] Status update received");

  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;
  const callErrorCode = request.body.ErrorCode;
  const callErrorMessage = request.body.ErrorMessage;
  const accountSid = request.body.AccountSid; // Para identificar subcuentas

  // Datos opcionales del webhook (si Twilio los envía)
  const toNumberFromWebhook = request.body.To || request.body.Called || null;
  const toCountryFromWebhook =
    request.body.CalledCountry || request.body.ToCountry || null;
  const priceFromWebhook = request.body.CallPrice || request.body.Price || null;
  const priceUnitFromWebhook = request.body.PriceUnit || null;

  //console.log(
  //  `📱 [TWILIO STATUS] Call ${callSid}: ${callStatus} (${callDuration}s)`
  //);

  // Log si la llamada viene de una subcuenta
  if (accountSid && accountSid !== TWILIO_ACCOUNT_SID) {
    //console.log(`📱 [TWILIO STATUS] Call from subaccount: ${accountSid}`);
  }

  try {
    // Get call info from global tracking
    const callInfo = globalActiveCalls.get(callSid);

    // First, let's check if the call exists in the database
    console.log(`[TWILIO STATUS] Looking for call with call_sid: ${callSid}`);

    // Try exact match first
    console.log(
      `[TWILIO STATUS] Executing query: SELECT * FROM calls WHERE call_sid = '${callSid}'`
    );

    let { data: existingCall, error: checkError } = await supabase
      .from("calls")
      .select("*")
      .eq("call_sid", callSid)
      .order("created_at", { ascending: false })
      .limit(1);

    console.log(`[TWILIO STATUS] Query result:`, {
      callSid: callSid,
      data: existingCall,
      error: checkError,
      dataLength: existingCall?.length || 0,
      dataType: typeof existingCall,
    });

    // If not found, try case-insensitive search
    if (!existingCall || existingCall.length === 0) {
      console.log(
        `[TWILIO STATUS] Call not found with exact match, trying case-insensitive search`
      );

      const { data: caseInsensitiveCall, error: caseError } = await supabase
        .from("calls")
        .select("*")
        .ilike("call_sid", callSid)
        .order("created_at", { ascending: false })
        .limit(1);

      if (caseInsensitiveCall && caseInsensitiveCall.length > 0) {
        console.log(
          `[TWILIO STATUS] Found call with case-insensitive search:`,
          {
            callSid: callSid,
            foundCallSid: caseInsensitiveCall[0].call_sid,
            match: callSid === caseInsensitiveCall[0].call_sid,
          }
        );
        existingCall = caseInsensitiveCall;
      } else {
        // Debug: Let's see what call_sid values are in the database
        console.log(
          `[TWILIO STATUS] Call not found, checking recent calls in database`
        );
        const { data: recentCalls, error: recentError } = await supabase
          .from("calls")
          .select("call_sid, user_id, status, created_at")
          .order("created_at", { ascending: false })
          .limit(10);

        console.log(`[TWILIO STATUS] Recent calls in database:`, {
          callSid: callSid,
          recentCalls:
            recentCalls?.map((call) => ({
              call_sid: call.call_sid,
              user_id: call.user_id,
              status: call.status,
              created_at: call.created_at,
            })) || [],
        });
      }
    }

    if (checkError) {
      console.error(
        "[TWILIO STATUS] Error checking existing call:",
        checkError
      );
      // Return 200 OK even if call not found to avoid Twilio errors
      return reply.code(200).send();
    }

    console.log(`[TWILIO STATUS] Call lookup result:`, {
      callSid,
      existingCall:
        existingCall && existingCall.length > 0
          ? {
              id: existingCall[0].id,
              user_id: existingCall[0].user_id,
              call_sid: existingCall[0].call_sid,
              status: existingCall[0].status,
              created_at: existingCall[0].created_at,
            }
          : null,
      found: !!(existingCall && existingCall.length > 0),
      dataLength: existingCall?.length || 0,
    });

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
    // Guardar info de destino del webhook si está disponible
    if (toNumberFromWebhook) updateData.to_number = toNumberFromWebhook;
    if (toCountryFromWebhook) updateData.to_country = toCountryFromWebhook;

    // Add error information if available
    if (callErrorCode || callErrorMessage) {
      updateData.error_code = callErrorCode;
      updateData.error_message = callErrorMessage;
    }

    await supabase.from("calls").update(updateData).eq("call_sid", callSid);

    // Enriquecer con costo y destino desde Twilio al completar
    // Enriquecer con costo y destino desde Twilio al completar
    if (callStatus === "completed") {
      try {
        // Get user data to determine which Twilio client to use
        let twilioClientToUse = twilioClient; // Default to main account

        if (
          existingCall &&
          existingCall.length > 0 &&
          existingCall[0].user_id
        ) {
          const { data: userData, error: userError } = await supabase
            .from("users")
            .select("twilio_subaccount_sid, twilio_auth_token")
            .eq("id", existingCall[0].user_id)

            .order("created_at", { ascending: false })
            .limit(1);

          if (
            !userError &&
            userData &&
            userData[0]?.twilio_subaccount_sid &&
            userData[0]?.twilio_auth_token
          ) {
            // Use subaccount client
            twilioClientToUse = new Twilio(
              userData[0]?.twilio_subaccount_sid,
              userData[0]?.twilio_auth_token
            );
            console.log(
              `🔍 [TWILIO STATUS] Using subaccount client for call ${callSid}: ${userData[0]?.twilio_subaccount_sid}`
            );
          } else {
            console.log(
              `🔍 [TWILIO STATUS] Using main account client for call ${callSid}`
            );
          }
        }

        const twilioRecord = await twilioClientToUse.calls(callSid).fetch();
        const callUri = twilioRecord.uri || null;
        //

        // Twilio devuelve price con signo (usualmente negativo), guarda valor absoluto
        const priceStr = twilioRecord.price;
        const fetchedPriceUnit =
          twilioRecord.priceUnit || priceUnitFromWebhook || null;
        const fetchedToNumber = twilioRecord.to || toNumberFromWebhook || null;
        const callPrice = priceStr
          ? Math.abs(parseFloat(priceStr))
          : priceFromWebhook
          ? Math.abs(parseFloat(priceFromWebhook))
          : null;

        const enrichUpdate = { updated_at: new Date().toISOString() };
        if (fetchedToNumber) enrichUpdate.to_number = fetchedToNumber;
        if (toCountryFromWebhook)
          enrichUpdate.to_country = toCountryFromWebhook;
        if (callPrice != null && !Number.isNaN(callPrice))
          enrichUpdate.call_price = callPrice;
        // if (fetchedPriceUnit) enrichUpdate.call_price_unit = fetchedPriceUnit;
        // 👉 NUEVO: guardar la URI de la llamada
        if (callUri) enrichUpdate.call_uri = callUri;

        await supabase
          .from("calls")
          .update(enrichUpdate)
          .eq("call_sid", callSid);
        // �� Iniciar proceso asíncrono para obtener precio si no está disponible
        // 🔄 Siempre calcular créditos basándose en duración/
        console.log(
          "�� [TWILIO STATUS] Iniciando proceso asíncrono para obtener precio de llamada"
        );
        fetchCallPriceAsync(callSid, callUri, twilioClientToUse);
      } catch (err) {
        console.warn(
          "⚠️ [TWILIO STATUS] Error fetching Twilio call record for pricing:",
          err?.message || err
        );

        // Fallback: try to save at least the call_uri if we can construct it
        try {
          // Get user data to determine the correct account SID
          let accountSidToUse = process.env.TWILIO_ACCOUNT_SID; // Default to main account

          if (existingCall && existingCall.user_id) {
            const { data: userData, error: userError } = await supabase
              .from("users")
              .select("twilio_subaccount_sid")
              .eq("id", existingCall.user_id)
              .single();

            if (!userError && userData?.twilio_subaccount_sid) {
              accountSidToUse = userData.twilio_subaccount_sid;
              console.log(
                `🔍 [TWILIO STATUS] Using subaccount for fallback call_uri: ${accountSidToUse}`
              );
            }
          }

          const fallbackCallUri = `/2010-04-01/Accounts/${accountSidToUse}/Calls/${callSid}.json`;
          console.log(
            "🔄 [TWILIO STATUS] Using fallback call_uri:",
            fallbackCallUri
          );

          await supabase
            .from("calls")
            .update({
              call_uri: fallbackCallUri,
              updated_at: new Date().toISOString(),
            })
            .eq("call_sid", callSid);
        } catch (fallbackErr) {
          console.error(
            "❌ [TWILIO STATUS] Fallback call_uri save also failed:",
            fallbackErr?.message || fallbackErr
          );
        }
      }
    } else {
      // For non-completed calls, still try to save call_uri if we can construct it
      try {
        // Get user data to determine the correct account SID
        let accountSidToUse = process.env.TWILIO_ACCOUNT_SID; // Default to main account

        if (existingCall && existingCall.user_id) {
          const { data: userData, error: userError } = await supabase
            .from("users")
            .select("twilio_subaccount_sid")
            .eq("id", existingCall.user_id)
            .single();

          if (!userError && userData?.twilio_subaccount_sid) {
            accountSidToUse = userData.twilio_subaccount_sid;
            console.log(
              `🔍 [TWILIO STATUS] Using subaccount for non-completed call_uri: ${accountSidToUse}`
            );
          }
        }

        const fallbackCallUri = `/2010-04-01/Accounts/${accountSidToUse}/Calls/${callSid}.json`;
        console.log(
          "🔄 [TWILIO STATUS] Saving call_uri for non-completed call:",
          fallbackCallUri
        );

        await supabase
          .from("calls")
          .update({
            call_uri: fallbackCallUri,
            updated_at: new Date().toISOString(),
          })
          .eq("call_sid", callSid);
      } catch (fallbackErr) {
        console.warn(
          "⚠️ [TWILIO STATUS] Could not save fallback call_uri:",
          fallbackErr?.message || fallbackErr
        );
      }
    }

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

    // Debug logging for userActiveCalls cleanup
    console.log(
      `[TWILIO STATUS] Cleaning up userActiveCalls for call ${callSid}:`,
      {
        existingCall: existingCall
          ? {
              id: existingCall.id,
              user_id: existingCall[0].user_id,
              call_sid: existingCall.call_sid,
              status: existingCall.status,
            }
          : null,
        userActiveCallsBefore: Object.fromEntries(userActiveCalls),
        globalActiveCallsSize: globalActiveCalls.size,
      }
    );

    if (existingCall && existingCall[0].user_id) {
      const currentCount = userActiveCalls.get(existingCall[0].user_id) || 0;
      console.log(
        `[TWILIO STATUS] User ${existingCall[0].user_id} has ${currentCount} active calls`
      );

      if (currentCount <= 1) {
        userActiveCalls.delete(existingCall[0].user_id);
        console.log(
          `[TWILIO STATUS] Removed user ${existingCall[0].user_id} from userActiveCalls`
        );
      } else {
        userActiveCalls.set(existingCall[0].user_id, currentCount - 1);
        console.log(
          `[TWILIO STATUS] Decreased user ${
            existingCall[0].user_id
          } active calls to ${currentCount - 1}`
        );
      }
    } else {
      console.log(
        `[TWILIO STATUS] Cannot clean up userActiveCalls: existingCall is null or has no user_id`
      );
    }
    activeCalls--;

    // ⚠️ ELIMINADO: Deducción de créditos del webhook de status
    // La deducción de créditos ahora solo ocurre en fetchCallPriceAsync
    // para evitar doble deducción

    // Deduct minutes from user's available time if call was successful
    if (
      existingCall &&
      existingCall[0].user_id &&
      callDuration > 0 &&
      result === "success"
    ) {
      try {
        console.log(
          `[TWILIO STATUS] Deducting ${callDuration} seconds from user ${existingCall[0].user_id}`
        );

        // Get current user data
        const { data: userData, error: userError } = await supabase
          .from("users")
          .select("available_minutes")
          .eq("id", existingCall[0].user_id)

          .order("created_at", { ascending: false })
          .limit(1);

        if (userError) {
          console.error("[TWILIO STATUS] Error fetching user data:", userError);
        } else if (userData) {
          // available_minutes stores the value in seconds
          const totalAvailableSeconds = userData[0]?.available_minutes || 0;

          // Segundos: SIEMPRE restar la duración completa de la llamada
          const remainingSeconds = Math.max(
            0,
            totalAvailableSeconds - callDuration
          );

          console.log("[TWILIO STATUS] Post-call deduction (minutes only):", {
            callDuration,
            before: {
              seconds: totalAvailableSeconds,
              minutes: Math.floor(totalAvailableSeconds / 60),
            },
            after: {
              seconds: remainingSeconds,
              minutes: Math.floor(remainingSeconds / 60),
            },
          });

          // Actualizar saldos (solo minutos, créditos se descuentan en fetchCallPriceAsync)
          const { error: updateError } = await supabase
            .from("users")
            .update({
              available_minutes: remainingSeconds,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCall[0].user_id);

          if (updateError) {
            console.error(
              "[TWILIO STATUS] Error updating user time:",
              updateError
            );
          } else {
            console.log(
              `[TWILIO STATUS] Successfully deducted ${callDuration} seconds from user ${existingCall[0].user_id}`
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
    if (existingCall && existingCall.queue_id && callStatus === "completed") {
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

          .order("created_at", { ascending: false })
          .limit(1);
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

    // Release worker after call completion (this is the main worker release point)
    const twilioCallInfo = globalActiveCalls.get(callSid);
    if (twilioCallInfo && twilioCallInfo.workerId) {
      const released = releaseWorker(
        twilioCallInfo.workerId,
        "twilio_status_complete"
      );
      if (released) {
        globalActiveCalls.delete(callSid);
        console.log(
          `[Queue] ✅ Worker ${twilioCallInfo.workerId} successfully released after Twilio status update`
        );
      }
    } else {
      console.log(
        `[Queue] ⚠️ No worker found for call ${callSid} in globalActiveCalls`,
        {
          globalActiveCallsKeys: Array.from(globalActiveCalls.keys()),
          callSid: callSid,
        }
      );
    }

    // Note: Webhook will be sent from ElevenLabs webhook after transcript processing
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

// Emergency endpoint to clean stuck calls for a specific user
fastify.post("/emergency-cleanup-user/:userId", async (request, reply) => {
  const { userId } = request.params;

  try {
    console.log(`[EMERGENCY CLEANUP] Starting cleanup for user: ${userId}`);

    // Get all calls for this user that are stuck in "In Progress" status
    const { data: stuckCalls, error: callsError } = await supabase
      .from("calls")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "In Progress");

    if (callsError) {
      console.error(
        "[EMERGENCY CLEANUP] Error fetching stuck calls:",
        callsError
      );
      return reply.code(500).send({ error: "Database error" });
    }

    if (!stuckCalls || stuckCalls.length === 0) {
      console.log(
        `[EMERGENCY CLEANUP] No stuck calls found for user ${userId}`
      );
      return reply.send({ message: "No stuck calls found", cleaned: 0 });
    }

    console.log(
      `[EMERGENCY CLEANUP] Found ${stuckCalls.length} stuck calls for user ${userId}`
    );

    let cleanedCount = 0;

    for (const call of stuckCalls) {
      try {
        // Update call status to failed
        const { error: updateError } = await supabase
          .from("calls")
          .update({
            status: "failed",
            result: "failed",
            error_code: "EMERGENCY_CLEANUP",
            error_message: "Call cleaned up by emergency endpoint",
            updated_at: new Date().toISOString(),
          })
          .eq("id", call.id);

        if (updateError) {
          console.error(
            `[EMERGENCY CLEANUP] Error updating call ${call.id}:`,
            updateError
          );
        } else {
          console.log(
            `[EMERGENCY CLEANUP] Successfully updated call ${call.id}`
          );
          cleanedCount++;
        }

        // Remove from global tracking
        globalActiveCalls.delete(call.call_sid);

        // Update queue item if exists
        if (call.queue_id) {
          await supabase
            .from("call_queue")
            .update({
              status: "failed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", call.queue_id);
        }
      } catch (callError) {
        console.error(
          `[EMERGENCY CLEANUP] Error processing call ${call.id}:`,
          callError
        );
      }
    }

    // Force reset userActiveCalls for this user
    userActiveCalls.delete(userId);

    console.log(
      `[EMERGENCY CLEANUP] Cleanup completed for user ${userId}. Cleaned ${cleanedCount} calls.`
    );

    return reply.send({
      message: "Emergency cleanup completed",
      userId,
      cleaned: cleanedCount,
      userActiveCalls: Object.fromEntries(userActiveCalls),
    });
  } catch (error) {
    console.error("[EMERGENCY CLEANUP] Error:", error);
    return reply.code(500).send({ error: "Internal server error" });
  }
});

// Twilio incoming call endpoint for AI assistant
fastify.all("/twilio/incoming-call", async (request, reply) => {
  try {
    const toNumber = request.body?.To;
    const fromNumber = request.body?.From;
    const callSid = request.body?.CallSid;

    console.log("📞 [TWILIO INCOMING] Incoming call details:", {
      toNumber,
      fromNumber,
      callSid,
    });

    // Retornar TwiML para conectar con ElevenLabs Agent
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${RAILWAY_PUBLIC_DOMAIN}/incoming-media-stream" interruptible="true">
      <Parameter name="callSid" value="${callSid || "unknown"}"/>
      <Parameter name="fromNumber" value="${fromNumber || "unknown"}"/>
      <Parameter name="toNumber" value="${toNumber || "unknown"}"/>
    </Stream>
  </Connect>
</Response>`;

    console.log("✅ [TWILIO INCOMING] Connecting to ElevenLabs Agent:", {
      toNumber,
      fromNumber,
      callSid,
    });

    reply.type("text/xml").send(twiml);
  } catch (error) {
    console.error(
      "❌ [TWILIO INCOMING] Error processing incoming call:",
      error
    );
    reply.code(500).send({ error: "Internal server error" });
  }
});

// Twilio redirect call endpoint for purchased phone numbers
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
          <Say voice="alice" language="es-MX">
            Lo sentimos, no pudimos procesar su llamada. Por favor intente más tarde.
          </Say>
        </Response>`;

      return reply.type("text/xml").send(defaultResponse);
    }

    const phoneConfig = phoneConfigs[0]; // Tomar el primer resultado
    const user = phoneConfig.users;

    console.log("✅ [TWILIO REDIRECT] Found phone configuration:", {
      phoneNumber: toNumber,
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
          <Say voice="alice" language="es-MX">
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

    console.log("✅ [TWILIO REDIRECT] Redirecting call:", {
      from: fromNumber,
      to: toNumber,
      redirectTo: redirectNumber,
      owner: `${user.first_name} ${user.last_name}`,
    });

    // Retornar TwiML para redirigir la llamada
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>${redirectNumber}</Dial>
</Response>`;

    reply.type("text/xml").send(twiml);
  } catch (error) {
    console.error("❌ [TWILIO REDIRECT] Error processing redirect:", error);
    reply.code(500).send({ error: "Internal server error" });
  }
});

// Emergency endpoint to sync userActiveCalls with database
fastify.post("/emergency-sync-user-active-calls", async (request, reply) => {
  try {
    console.log(
      `[EMERGENCY SYNC] Starting sync of userActiveCalls with database`
    );

    // Get all calls that are currently "In Progress" in the database
    const { data: activeCallsInDB, error: callsError } = await supabase
      .from("calls")
      .select("user_id, call_sid")
      .eq("status", "In Progress");

    if (callsError) {
      console.error(
        "[EMERGENCY SYNC] Error fetching active calls:",
        callsError
      );
      return reply.code(500).send({ error: "Database error" });
    }

    // Count active calls per user from database
    const userActiveCallsFromDB = new Map();
    activeCallsInDB?.forEach((call) => {
      if (call.user_id) {
        userActiveCallsFromDB.set(
          call.user_id,
          (userActiveCallsFromDB.get(call.user_id) || 0) + 1
        );
      }
    });

    console.log(`[EMERGENCY SYNC] Active calls from database:`, {
      totalActiveCalls: activeCallsInDB?.length || 0,
      userActiveCallsFromDB: Object.fromEntries(userActiveCallsFromDB),
      currentUserActiveCalls: Object.fromEntries(userActiveCalls),
    });

    // Update userActiveCalls to match database
    userActiveCalls.clear();
    userActiveCallsFromDB.forEach((count, userId) => {
      userActiveCalls.set(userId, count);
    });

    console.log(
      `[EMERGENCY SYNC] Sync completed. New userActiveCalls:`,
      Object.fromEntries(userActiveCalls)
    );

    return reply.send({
      message: "User active calls synced with database",
      before: Object.fromEntries(userActiveCallsFromDB),
      after: Object.fromEntries(userActiveCalls),
      totalActiveCalls: activeCallsInDB?.length || 0,
    });
  } catch (error) {
    console.error("[EMERGENCY SYNC] Error:", error);
    return reply.code(500).send({ error: "Internal server error" });
  }
});

// Monitoring endpoint for worker pool and queue status
fastify.get("/queue/workers", async (request, reply) => {
  try {
    console.log("[Queue] Worker state requested");

    // Get queue statistics
    const { data: queueStats, error: queueError } = await supabase
      .from("call_queue")
      .select("status");

    if (queueError) {
      console.error("[Queue] Error fetching queue stats:", queueError);
      return reply.code(500).send({ error: "Error fetching queue stats" });
    }

    const stats = {};
    queueStats?.forEach((item) => {
      stats[item.status] = (stats[item.status] || 0) + 1;
    });

    const workerState = {
      workers: {
        size: workerPool.size,
        maxSize: QUEUE_CONFIG.workerPoolSize,
        workers: Array.from(workerPool),
      },
      queue: {
        pending: stats.pending || 0,
        in_progress: stats.in_progress || 0,
        completed: stats.completed || 0,
        failed: stats.failed || 0,
        cancelled: stats.cancelled || 0,
      },
      configuration: {
        maxConcurrentCalls: QUEUE_CONFIG.maxConcurrentCalls,
        maxCallsPerUser: QUEUE_CONFIG.maxCallsPerUser,
        queueCheckInterval: QUEUE_CONFIG.queueCheckInterval,
        workerPoolSize: QUEUE_CONFIG.workerPoolSize,
      },
      activeCalls: {
        global: globalActiveCalls.size,
        userActiveCalls: Object.fromEntries(userActiveCalls),
      },
      timestamp: new Date().toISOString(),
    };

    reply.send(workerState);
  } catch (error) {
    console.error("[Queue] Error getting worker state:", error);
    reply.code(500).send({ error: "Error getting worker state" });
  }
});
// Add webhook endpoint for ElevenLabs
// ElevenLabs webhook endpoint
fastify.post("/webhook/elevenlabs", async (request, reply) => {
  try {
    console.log("🎤 [ELEVENLABS] Webhook received");

    // Log all headers to see what ElevenLabs is sending
    console.log(
      "🔍 [ELEVENLABS] All headers:",
      JSON.stringify(request.headers, null, 2)
    );

    // Check for different possible signature header names
    const signatureX = request.headers["x-elevenlabs-signature"];
    const signatureElevenLabs = request.headers["elevenlabs-signature"];
    const signatureElevenLabsCap = request.headers["ElevenLabs-Signature"];

    console.log("🔍 [ELEVENLABS] Signature headers found:");
    console.log("  - x-elevenlabs-signature:", signatureX);
    console.log("  - elevenlabs-signature:", signatureElevenLabs);
    console.log("  - ElevenLabs-Signature:", signatureElevenLabsCap);

    const rawBody = request.rawBody;
    const rawBodyString = rawBody ? rawBody.toString("utf8") : null;
    console.log(
      "🔍 [ELEVENLABS] Raw body length:",
      rawBody ? rawBody.length : "undefined"
    );

    // Try different signature headers
    let signature = signatureElevenLabsCap || signatureElevenLabs || signatureX;

    console.log(" [ELEVENLABS] Using signature:", signature);

    // Verify signature
    if (!verifyElevenLabsSignature(rawBodyString, signature)) {
      console.error("❌ [ELEVENLABS] Invalid signature");

      // TEMPORAL: Permitir webhook sin verificación mientras debuggeamos
      console.warn(
        "⚠️ [ELEVENLABS] TEMPORAL: Allowing webhook despite signature mismatch for debugging"
      );

      // Comentar la línea siguiente para permitir que continúe
      // return reply.code(401).send({ error: "Invalid signature" });
    }

    // Parse the webhook data from rawBodyString instead of request.body
    let webhookData;
    try {
      webhookData = JSON.parse(rawBodyString);
      if (webhookData?.data?.conversation_config_override?.conversation) {
        console.log(
          "🌐 [ELEVENLABS WEBHOOK] Idioma recibido:",
          webhookData.data.conversation_config_override.conversation
        );
      }
    } catch (parseError) {
      console.error("❌ [ELEVENLABS] Error parsing webhook data:", parseError);
      console.log(
        "🔍 [ELEVENLABS] Raw body that failed to parse:",
        rawBodyString
      );
      return reply.code(400).send({ error: "Invalid JSON in webhook body" });
    }

    // Extract data from the correct structure
    const event_type = webhookData.type;
    const conversation_id = webhookData.data?.conversation_id;
    const transcript = webhookData.data?.transcript;
    const transcript_summary = webhookData.data?.analysis?.transcript_summary;
    const end_reason = webhookData.data?.metadata?.termination_reason;
    const connection_status = webhookData.data?.status;
    const duration = webhookData.data?.metadata?.call_duration_secs;
    const turn_count = webhookData.data?.transcript?.length || 0;
    const call_successful = webhookData.data?.analysis?.call_successful;
    const calendar_event_id = null; // Not available in this structure

    // Handle different event types
    switch (event_type) {
      case "conversation_initiation_metadata":
        console.log(
          "🚀 [ELEVENLABS] Conversation initiation metadata received"
        );
        break;

      case "audio_chunk":
        console.log(" [ELEVENLABS] Audio chunk received");
        break;

      case "agent_tool_response":
        console.log(" [ELEVENLABS] Agent tool response received");
        break;

      case "conversation_ended":
        console.log("🏁 [ELEVENLABS] Conversation ended");
        break;

      case "post_call_transcription":
        console.log("📝 [ELEVENLABS] Post call transcription received");
        break;

      default:
        console.log(`ℹ️ [ELEVENLABS] Unhandled event type: ${event_type}`);
    }

    // Process post_call_transcription events (this is where the transcript comes)
    if (event_type !== "post_call_transcription") {
      return reply.send({ success: true, message: "Event processed" });
    }

    console.log("🎯 [ELEVENLABS] Processing post call transcription event");

    // Get call data - Only search by conversation_id if it exists
    console.log(
      "🔍 [ELEVENLABS] Processing webhook with conversation_id:",
      conversation_id
    );

    let call = null;
    let callError = null;

    if (conversation_id) {
      // Only search by conversation_id if it exists (successful calls)
      console.log(
        "🔍 [ELEVENLABS] Searching for call with conversation_id:",
        conversation_id
      );

      const { data: callByConversation, error: callByConversationError } =
        await supabase
          .from("calls")
          .select("*, call_sid")
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: false })
          .limit(1);

      call = callByConversation;
      callError = callByConversationError;

      if (call && call.length > 0) {
        console.log(
          "✅ [ELEVENLABS] Found call by conversation_id:",
          conversation_id
        );
      }
    }

    // If no conversation_id or call not found, this might be a failed call that never reached ElevenLabs
    if (!conversation_id || !call || call.length === 0) {
      console.log(
        "ℹ️ [ELEVENLABS] No conversation_id or call not found - this might be a failed call"
      );
      console.log(
        "ℹ️ [ELEVENLABS] Skipping call processing for failed calls (line_busy, no_answer, etc.)"
      );

      // For failed calls, we don't need to process anything
      // The worker will be released in the finally block of processQueueItemWithRetry
      return reply.send({
        success: true,
        message:
          "Webhook processed - call was likely a failure (no conversation_id)",
        conversation_id: conversation_id,
      });
    }

    console.log("🔍 [ELEVENLABS] Call search result:", {
      found: !!call,
      error: callError,
      conversation_id: conversation_id,
    });

    if (callError || !call) {
      console.error("❌ [ELEVENLABS] Call not found:", callError);

      // Release worker if call not found
      const callInfo = globalActiveCalls.get(call?.call_sid);
      if (callInfo && callInfo.workerId) {
        const released = releaseWorker(callInfo.workerId, "call_not_found");
        if (released) {
          globalActiveCalls.delete(call?.call_sid);
          console.log(
            `[Queue] ✅ Worker ${callInfo.workerId} released due to call not found`
          );
        }
      }

      return reply.code(404).send({ error: "Call not found" });
    }

    console.log("📞 [ELEVENLABS] Call data:", {
      id: call.id,
      conversation_id: call.conversation_id,
      call_sid: call.call_sid,
      status: call.status,
      duration: call.duration,
      lead_id: call.lead_id,
      user_id: call.user_id,
    });

    console.log("🔍 [ELEVENLABS] Full call object keys:", Object.keys(call));

    // Update call with final data
    const updateData = {
      status: "completed",
      conversation_id: conversation_id, // Add conversation_id to the call record
      end_reason: end_reason || call.end_reason,
      connection_status: connection_status || call.connection_status,
      duration: duration || call.duration,
      turn_count: turn_count || call.turn_count,
      call_successful: call_successful || call.call_successful,
      calendar_event_id: calendar_event_id || call.calendar_event_id,
      updated_at: new Date().toISOString(),
    };

    // Save transcript data if available
    if (transcript && transcript.length > 0) {
      updateData.transcript = JSON.stringify(transcript);
      console.log(
        "📝 [ELEVENLABS] Saving transcript with",
        transcript.length,
        "turns"
      );
    }

    if (transcript_summary) {
      updateData.transcript_summary = transcript_summary;
      console.log(
        "📋 [ELEVENLABS] Saving transcript summary:",
        transcript_summary.substring(0, 100) + "..."
      );
    }

    const { error: updateError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("conversation_id", conversation_id);

    if (updateError) {
      console.error("❌ [ELEVENLABS] Error updating call:", updateError);

      // Release worker if update fails
      const callInfo = globalActiveCalls.get(call.call_sid);
      if (callInfo && callInfo.workerId) {
        const released = releaseWorker(callInfo.workerId, "update_failed");
        if (released) {
          globalActiveCalls.delete(call.call_sid);
          console.log(
            `[Queue] ✅ Worker ${callInfo.workerId} released due to update failure`
          );
        }
      }

      return reply.code(500).send({ error: "Failed to update call" });
    }

    console.log("✅ [ELEVENLABS] Call updated successfully");

    //  ANALYZE TRANSCRIPT AND GENERATE INSIGHTS
    try {
      // Check if we have transcript data to analyze
      if (transcript && transcript.length > 0) {
        console.log(
          "🔍 [ANALYSIS] Analyzing transcript and generating insights"
        );

        // Obtener las preguntas personalizadas para el análisis
        let questions = null;
        try {
          // Primero necesitamos obtener el user_id de la llamada
          const { data: callDataForUser, error: callUserError } = await supabase
            .from("calls")
            .select("user_id")
            .eq("conversation_id", conversation_id)
            .single();

          if (!callUserError && callDataForUser) {
            const { data: questionsData, error: questionsError } =
              await supabase
                .from("user_agent_responses")
                .select(
                  `
                response_boolean,
                agent_questions!user_agent_responses_question_id_fkey(
                  question_text,
                  question_type,
                  is_required,
                  order_index
                )
              `
                )
                .eq("user_id", callDataForUser.user_id)
                .eq("response_boolean", true)
                .order("agent_questions.order_index", { ascending: true });

            if (!questionsError && questionsData && questionsData.length > 0) {
              questions = questionsData.map((q) => q.agent_questions);
              console.log(
                `🔍 [ANALYSIS] Found ${questionsData.length} questions for analysis`
              );
            } else {
              console.log(
                "⚠️ [ANALYSIS] No custom questions found for analysis"
              );
            }
          } else {
            console.log("⚠️ [ANALYSIS] Could not get user_id from call data");
          }
        } catch (questionsError) {
          console.log(
            `❌ [ANALYSIS] Error getting questions for analysis: ${questionsError.message}`
          );
        }

        const { summary, commercialSuggestion, detailedResult } =
          await analyzeTranscriptAndGenerateInsights(
            transcript,
            transcript_summary,
            {
              end_reason,
              connection_status,
              duration,
              turn_count,
              call_successful,
              calendar_event_id,
            },
            questions
          );

        if (summary || commercialSuggestion || detailedResult) {
          // Update call with analysis results
          const analysisUpdateData = {
            updated_at: new Date().toISOString(),
          };

          if (summary) {
            analysisUpdateData.transcript_summary_es = summary;
          }

          if (commercialSuggestion) {
            analysisUpdateData.commercial_suggestion = commercialSuggestion;
          }

          if (detailedResult) {
            analysisUpdateData.detailed_result = detailedResult;
          }

          const { error: analysisError } = await supabase
            .from("calls")
            .update(analysisUpdateData)
            .eq("conversation_id", conversation_id);

          if (analysisError) {
            console.error(
              "❌ [ANALYSIS] Error saving analysis results:",
              analysisError
            );
          } else {
            console.log("✅ [ANALYSIS] Analysis results saved successfully");
            if (summary) {
              console.log(
                " [ANALYSIS] Summary saved:",
                summary.substring(0, 100) + "..."
              );
            }
            if (commercialSuggestion) {
              console.log(
                "💡 [ANALYSIS] Commercial suggestion saved:",
                commercialSuggestion.substring(0, 100) + "..."
              );
            }
            if (detailedResult) {
              console.log(
                "🔍 [ANALYSIS] Detailed result type:",
                typeof detailedResult
              );
              console.log(
                "🔍 [ANALYSIS] Detailed result length:",
                detailedResult.length
              );
              console.log(
                "🔍 [ANALYSIS] Detailed result trimmed:",
                `"${detailedResult.trim()}"`
              );
            }

            // 🆕 ENVIAR WEBHOOK DESPUÉS DE GUARDAR EL ANÁLISIS COMPLETO
            console.log(
              "📤 [ANALYSIS] Sending webhook with complete data including transcript_summary_es"
            );

            // Obtener call_sid para enviar el webhook
            const { data: callForWebhook, error: webhookError } = await supabase
              .from("calls")
              .select("call_sid")
              .eq("conversation_id", conversation_id)
              .single();

            if (callForWebhook && callForWebhook.call_sid) {
              console.log(
                "📤 [ANALYSIS] Call SID found:",
                callForWebhook.call_sid
              );
              sendCallCompletionData(supabase, callForWebhook.call_sid);
            } else {
              console.warn("⚠️ [ANALYSIS] Call SID not found for webhook");
              if (webhookError) {
                console.error("❌ [ANALYSIS] Webhook error:", webhookError);
              }
            }
          }
        }
      } else {
        console.log("⚠️ [ANALYSIS] No transcript available for analysis");
      }
    } catch (analysisError) {
      console.error("❌ [ANALYSIS] Error analyzing transcript:", analysisError);
    }

    //  Update call metrics
    try {
      const { data: callData } = await supabase
        .from("calls")
        .select("*")
        .eq("conversation_id", conversation_id)

        .order("created_at", { ascending: false })
        .limit(1);

      if (callData) {
        console.log("📊 [METRICS] Call completed:", {
          conversation_id: callData.conversation_id,
          duration: callData.duration,
          turn_count: callData.turn_count,
          detailed_result: callData.detailed_result,
          commercial_suggestion:
            callData.commercial_suggestion?.substring(0, 50) + "...",
        });
      }
    } catch (metricsError) {
      console.error("❌ [METRICS] Error logging call metrics:", metricsError);
    }

    // Check for scheduled call and create calendar event
    try {
      console.log(
        "📅 [CALENDAR] Checking for scheduled call in webhook data..."
      );
      const scheduledCallInfo = await checkForScheduledCall(webhookData, call);

      if (scheduledCallInfo) {
        console.log(
          "✅ [CALENDAR] Scheduled call detected, creating calendar event..."
        );
        await createCalendarEvent(scheduledCallInfo, call);
      } else {
        console.log("ℹ️ [CALENDAR] No scheduled call detected in webhook data");
      }
    } catch (calendarError) {
      console.error(
        "❌ [CALENDAR] Error processing calendar event:",
        calendarError
      );
    }

    // Note: Worker is released in Twilio status webhook, not here
    console.log(
      "ℹ️ [ELEVENLABS] Call processing complete - worker will be released by Twilio status webhook"
    );

    // Webhook ya enviado después de guardar el análisis completo

    return reply.send({
      success: true,
      message: "Webhook processed successfully",
      conversation_id: conversation_id,
    });
  } catch (error) {
    console.error("❌ [ELEVENLABS] Error processing webhook:", error);
    return reply.code(500).send({ error: "Internal server error" });
  }
});

// API Integration endpoints for leads
// API Integration endpoints for leads
fastify.post("/api/integration/leads", async (request, reply) => {
  try {
    console.log("�� [API] POST /api/integration/leads - Creating lead");

    // Obtener API key del header
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers.authorization?.replace("Bearer ", "");

    console.log(
      "🔍 [API KEY DEBUG] API Key received:",
      apiKey ? "Present" : "Missing"
    );

    if (!apiKey) {
      return reply.code(401).send({
        error: "API key requerida",
        message:
          "Incluye tu API key en el header: x-api-key o Authorization: Bearer <api_key>",
      });
    }

    // Validar API key
    console.log("🔍 [API KEY DEBUG] Searching for API key in database...");
    const { data: apiKeyData, error: apiKeyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .order("created_at", { ascending: false })
      .limit(1);

    console.log("🔍 [API KEY DEBUG] Query result:", {
      hasData: !!apiKeyData,
      error: apiKeyError,
      apiKeyData: apiKeyData,
    });

    if (
      apiKeyError ||
      !apiKeyData ||
      apiKeyData.length === 0 ||
      !apiKeyData[0].is_active
    ) {
      console.log("❌ [API KEY DEBUG] API key validation failed");
      return reply.code(401).send({
        error: "API key inválida o inactiva",
        message: "Verifica que tu API key sea correcta y esté activa",
      });
    }

    const userId = apiKeyData[0].user_id;
    console.log("✅ [API KEY DEBUG] API key validated for user:", userId);

    // Obtener datos del body
    const body = request.body;
    console.log("🔍 [API] Body recibido:", JSON.stringify(body, null, 2));
    console.log("🔍 [API] Tipo de body:", typeof body);
    console.log("🔍 [API] Es array:", Array.isArray(body));

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
      console.log(
        `🔍 [API] Lead ${i} data:`,
        JSON.stringify(leadData, null, 2)
      );
      const {
        name,
        phone,
        email,
        auto_call,
        source = "api",
        notes,
        external_id,
        language = "es",
      } = leadData;

      // Normalizar auto_call para manejar diferentes tipos de entrada
      const normalizedAutoCall =
        auto_call === true ||
        auto_call === "true" ||
        auto_call === "TRUE" ||
        auto_call === "True" ||
        auto_call === 1 ||
        auto_call === "1";

      console.log(
        `🔍 [API] Lead ${i}: auto_call original: ${auto_call}, tipo: ${typeof auto_call}, normalizado: ${normalizedAutoCall}`
      );

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
          auto_call: normalizedAutoCall,
          source,
          notes: notes || null,
          external_id: external_id || null,
          language,
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
                  name: data.name.trim().split(" ")[0],
                  phone: data.phone,
                  auto_call: data.auto_call,
                  source: data.source,
                  notes: data.notes,
                  external_id: data.external_id,
                  language: data.language,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", existingLead.id)
                .select();

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
                console.log(
                  `🔍 [API] Auto_call es true para lead existente ${existingLead.id}, verificando cola...`
                );
                // Buscar si ya está en la cola pendiente
                const { data: queueItem, error: queueError } = await supabase
                  .from("call_queue")
                  .select("id")
                  .eq("user_id", userId)
                  .eq("lead_id", existingLead.id)
                  .eq("status", "pending")
                  .maybeSingle();

                if (queueError) {
                  console.error(
                    `❌ [API] Error al verificar cola para lead ${existingLead.id}:`,
                    queueError
                  );
                }

                if (!queueItem) {
                  console.log(
                    `📋 [API] Lead ${existingLead.id} no está en cola, agregando...`
                  );
                  // Obtener la última posición en la cola
                  const { data: existingQueue, error: queueQueryError } =
                    await supabase
                      .from("call_queue")
                      .select("queue_position")
                      .order("queue_position", { ascending: false })
                      .limit(1);

                  if (queueQueryError) {
                    console.error(
                      `❌ [API] Error al consultar cola existente:`,
                      queueQueryError
                    );
                  }

                  const nextPosition =
                    existingQueue && existingQueue.length > 0
                      ? (existingQueue[0]?.queue_position || 0) + 1
                      : 1;

                  console.log(
                    `📋 [API] Próxima posición en cola: ${nextPosition}`
                  );

                  const { data: queueInsertData, error: queueInsertError } =
                    await supabase.from("call_queue").insert({
                      user_id: userId,
                      lead_id: existingLead.id,
                      queue_position: nextPosition,
                      status: "pending",
                      created_at: new Date().toISOString(),
                    });

                  if (queueInsertError) {
                    console.error(
                      `❌ [API] Error al agregar lead ${existingLead.id} a la cola:`,
                      queueInsertError
                    );
                  } else {
                    console.log(
                      `✅ [API] Lead ${existingLead.id} agregado a la cola en posición ${nextPosition}`
                    );
                  }
                } else {
                  console.log(
                    `ℹ️ [API] Lead ${existingLead.id} ya está en cola pendiente`
                  );
                }
              } else {
                console.log(
                  `ℹ️ [API] Auto_call es false para lead existente ${existingLead.id}, no se agrega a cola`
                );
              }

              return {
                index,
                success: true,
                data: updatedLead,
                action: "updated",
              };
            } else {
              // Crear nuevo lead
              console.log(
                `🔍 [API] Creando nuevo lead con auto_call: ${data.auto_call}`
              );
              const { data: newLeadData, error: insertError } = await supabase
                .from("leads")
                .insert({
                  user_id: userId,
                  name: data.name.trim().split(" ")[0],
                  phone: data.phone,
                  email: data.email,
                  auto_call: data.auto_call,
                  source: data.source,
                  notes: data.notes,
                  external_id: data.external_id,
                  language: data.language,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .select();

              console.log(`🔍 [API] Lead creado:`, newLeadData);
              console.log(`🔍 [API] Lead ID:`, newLeadData?.[0]?.id);

              if (insertError) {
                console.error(`❌ [API] Error al crear lead:`, insertError);
                return {
                  index,
                  success: false,
                  error: "Error al crear lead",
                  details: insertError.message,
                };
              }

              if (!newLeadData || newLeadData.length === 0) {
                console.error(
                  `❌ [API] No se pudo obtener el ID del lead creado`
                );
                return {
                  index,
                  success: false,
                  error: "No se pudo obtener el ID del lead creado",
                };
              }

              const newLead = newLeadData[0];
              console.log(`🔍 [API] Lead ID extraído:`, newLead.id);

              // NUEVO: Si auto_call es true, agregar a la cola automáticamente
              if (data.auto_call) {
                console.log(
                  `🔍 [API] Auto_call es true para lead ${newLead.id}, agregando a cola...`
                );
                try {
                  // Obtener la última posición en la cola
                  const { data: existingQueue, error: queueQueryError } =
                    await supabase
                      .from("call_queue")
                      .select("queue_position")
                      .order("queue_position", { ascending: false })
                      .limit(1);

                  if (queueQueryError) {
                    console.error(
                      `❌ [API] Error al consultar cola existente:`,
                      queueQueryError
                    );
                  }

                  const nextPosition =
                    existingQueue && existingQueue.length > 0
                      ? (existingQueue[0]?.queue_position || 0) + 1
                      : 1;

                  console.log(
                    `📋 [API] Próxima posición en cola: ${nextPosition}`
                  );

                  const { data: queueInsertData, error: queueInsertError } =
                    await supabase.from("call_queue").insert({
                      user_id: userId,
                      lead_id: newLead.id,
                      queue_position: nextPosition,
                      status: "pending",
                      created_at: new Date().toISOString(),
                    });

                  if (queueInsertError) {
                    console.error(
                      `❌ [API] Error al agregar lead ${newLead.id} a la cola:`,
                      queueInsertError
                    );
                  } else {
                    console.log(
                      `✅ [API] Lead ${newLead.id} agregado automáticamente a la cola de llamadas en posición ${nextPosition}`
                    );
                  }
                } catch (queueError) {
                  console.error(
                    `❌ [API] Error al agregar lead ${newLead.id} a la cola:`,
                    queueError
                  );
                  // No fallamos la creación del lead por un error en la cola
                }
              } else {
                console.log(
                  `ℹ️ [API] Auto_call es false para lead ${newLead.id}, no se agrega a cola`
                );
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
      .order("created_at", { ascending: false })
      .limit(1);

    if (
      apiKeyError ||
      !apiKeyData ||
      apiKeyData.length === 0 ||
      !apiKeyData[0].is_active
    ) {
      return reply.code(401).send({
        error: "API key inválida o inactiva",
        message: "Verifica que tu API key sea correcta y esté activa",
      });
    }

    const userId = apiKeyData[0].user_id;

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

// Endpoint para obtener estado de la cola
fastify.get("/api/queue-status", async (request, reply) => {
  try {
    const { data: pendingCount, error: pendingError } = await supabase
      .from("call_queue")
      .select("id", { count: "exact" })
      .eq("status", "pending");

    const { data: inProgressCount, error: inProgressError } = await supabase
      .from("call_queue")
      .select("id", { count: "exact" })
      .eq("status", "in_progress");

    if (pendingError || inProgressError) {
      throw new Error("Error fetching queue status");
    }

    // Obtener estadísticas detalladas de usuarios activos
    const userStats = [];
    for (const [userId, activeCalls] of userActiveCalls) {
      if (activeCalls > 0) {
        userStats.push({
          user_id: userId,
          active_calls: activeCalls,
          max_calls_per_user: QUEUE_CONFIG.maxCallsPerUser,
        });
      }
    }

    return {
      pending: pendingCount || 0,
      in_progress: inProgressCount || 0,
      active_calls: globalActiveCalls.size,
      max_concurrent: QUEUE_CONFIG.maxConcurrentCalls,
      is_processing: isProcessingQueue,
      processing_items: processingQueueItems.size,
      worker_pool_size: workerPool.size,
      user_stats: userStats,
      queue_config: {
        max_concurrent_calls: QUEUE_CONFIG.maxConcurrentCalls,
        max_calls_per_user: QUEUE_CONFIG.maxCallsPerUser,
        queue_check_interval: QUEUE_CONFIG.queueCheckInterval,
        retry_attempts: QUEUE_CONFIG.retryAttempts,
        retry_delay: QUEUE_CONFIG.retryDelay,
      },
      last_check: new Date().toISOString(),
    };
  } catch (error) {
    reply.code(500).send({ error: error.message });
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
    // console.log("📞 [CALENDAR] Call SID:", call.call_sid);
    // console.log("👤 [CALENDAR] User ID:", call.user_id);
    // console.log("📋 [CALENDAR] Lead ID:", call.lead_id);
    // console.log("📊 [CALENDAR] Call Status:", call.status);
    // console.log(
    //   "✅ [CALENDAR] Call Successful:",
    //   webhookData.data.analysis?.call_successful
    // );

    // Get the transcript summary from ElevenLabs
    const summary = webhookData.data.analysis?.transcript_summary || "";
    // console.log("📄 [CALENDAR] Summary length:", summary.length);
    // console.log(
    //   "📄 [CALENDAR] Summary preview:",
    //   summary.substring(0, 200) + (summary.length > 200 ? "..." : "")
    // );

    if (!summary || summary.trim() === "") {
      // console.log(
      //   "❌ [CALENDAR] No summary available - skipping calendar check"
      // );
      return null;
    }

    // Check if call was successful (this indicates successful scheduling)
    const isCallSuccessful =
      webhookData.data.analysis?.call_successful === "success";
    // console.log("🎯 [CALENDAR] Call successful indicator:", isCallSuccessful);

    // If call is successful, proceed directly to extract date/time from summary
    if (isCallSuccessful) {
      // console.log(
      //   "✅ [CALENDAR] Call marked as successful - proceeding with date/time extraction"
      // );
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

      // console.log("🔍 [CALENDAR] Checking for scheduling keywords...");
      const foundKeywords = [];

      schedulingKeywords.forEach((keyword) => {
        if (summary.toLowerCase().includes(keyword.toLowerCase())) {
          foundKeywords.push(keyword);
        }
      });

      // console.log("🎯 [CALENDAR] Found keywords:", foundKeywords);

      if (foundKeywords.length === 0) {
        // console.log(
        //   "❌ [CALENDAR] No scheduling keywords found and call not marked as successful - skipping calendar check"
        // );
        return null;
      }

      // console.log(
      //   "✅ [CALENDAR] Scheduling keywords detected - proceeding with date/time extraction"
      // );
    }

    // Extract date and time using direct text parsing
    const dateTimeInfo = await extractDateTimeFromSummary(summary);

    if (dateTimeInfo) {
      //  console.log(
      //   "✅ [CALENDAR] Date/time extracted successfully:",
      //   dateTimeInfo
      // );

      // Get lead information
      console.log("🔍 [CALENDAR] Lead ID from call:", call.lead_id);
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("name, phone, email")
        .eq("id", call.lead_id)

        .order("created_at", { ascending: false })
        .limit(1);

      if (leadError || !lead) {
        console.error("❌ [CALENDAR] Error fetching lead:", leadError);
        return null;
      }

      // console.log("✅ [CALENDAR] Lead information retrieved:", {
      //   name: lead.name,
      //   phone: lead.phone,
      //   email: lead.email,
      // });

      const result = {
        ...dateTimeInfo,
        lead: lead,
        call: call,
        summary: summary,
      };

      //  console.log("🎉 [CALENDAR] ===== FINAL RESULT =====");
      // console.log("📅 [CALENDAR] Date:", result.date);
      // console.log("⏰ [CALENDAR] Time:", result.time);
      // console.log("🌍 [CALENDAR] Timezone:", result.timezone);
      // console.log("👤 [CALENDAR] Lead:", result.lead.name);
      // console.log("📞 [CALENDAR] Phone:", result.lead.phone);
      // console.log("📧 [CALENDAR] Email:", result.lead.email);
      // console.log(
      //   "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
      // );

      return result;
    } else {
      // console.log("❌ [CALENDAR] Could not extract date/time from summary");
      // console.log(
      //   "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
      // );
    }

    return null;
  } catch (error) {
    // console.error("❌ [CALENDAR] Error checking for scheduled call:", error);
    // console.log(
    //   "🔍 [CALENDAR] ===== FIN DE BÚSQUEDA DE LLAMADA PROGRAMADA (ERROR) ====="
    // );
    return null;
  }
}

// Function to extract date and time from summary using direct text parsing
async function extractDateTimeFromSummary(summary) {
  try {
    // console.log(
    //   "🔍 [CALENDAR][EXTRACT] ===== INICIO DE EXTRACCIÓN DE FECHA/HORA ====="
    // );
    // console.log("📄 [CALENDAR][EXTRACT] Summary to analyze:", summary);

    if (!summary || summary.trim() === "") {
      // console.log("❌ [CALENDAR][EXTRACT] No summary available");
      return null;
    }

    const text = summary.toLowerCase();
    // console.log(
    //   "📝 [CALENDAR][EXTRACT] Normalized text (first 300 chars):",
    //   text.substring(0, 300)
    // );

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
      // Spanish format: "21 de agosto"
      {
        pattern:
          /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi,
        type: "day_month_spanish",
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

      case "day_month_spanish":
        const daySpanish = parseInt(match[1]);
        const monthNameSpanish = match[2].toLowerCase();
        const monthSpanish = getMonthNumber(monthNameSpanish);
        if (monthSpanish === -1 || daySpanish < 1 || daySpanish > 31)
          return null;

        return `${currentYear}-${monthSpanish
          .toString()
          .padStart(2, "0")}-${daySpanish.toString().padStart(2, "0")}`;

      case "date_slash":
        const monthSlash = parseInt(match[1]);
        const daySlash = parseInt(match[2]);
        const yearSlash = match[3] ? parseInt(match[3]) : currentYear;
        if (monthSlash < 1 || monthSlash > 12 || daySlash < 1 || daySlash > 31)
          return null;

        return `${yearSlash}-${monthSlash
          .toString()
          .padStart(2, "0")}-${daySlash.toString().padStart(2, "0")}`;

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
      .order("created_at", { ascending: false })
      .limit(1);

    if (settingsError || !calendarSettings || calendarSettings.length === 0) {
      console.error(
        "❌ [CALENDAR] No calendar settings found for user:",
        call.user_id
      );
      return;
    }

    // Obtener la configuración más reciente (primer elemento del array)
    const calendarConfig = calendarSettings[0];

    if (!calendarConfig.calendar_enabled) {
      console.log("ℹ️ [CALENDAR] Calendar not enabled for user:", call.user_id);
      return;
    }

    // Verify and refresh token if needed
    try {
      const tokenInfoResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${calendarConfig.access_token}`,
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
          access_token: calendarConfig.access_token,
          refresh_token: calendarConfig.refresh_token,
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
              credentials.refresh_token || calendarConfig.refresh_token,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", call.user_id);

        calendarConfig.access_token = credentials.access_token;
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
      access_token: calendarConfig.access_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Get user timezone (default to America/New_York if not specified)
    const userTimeZone =
      scheduledCallInfo.timezone ||
      calendarConfig.calendar_timezone ||
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

    // console.log("📅 [CALENDAR] Creating event:", {
    //   title: event.summary,
    //   start: event.start.dateTime,
    //   end: event.end.dateTime,
    //   timezone: userTimeZone,
    //   attendees: event.attendees.length,
    // });

    const calendarResponse = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      sendUpdates: "all",
    });

    // console.log("✅ [CALENDAR] Event created successfully:", {
    //   eventId: calendarResponse.data.id,
    //   htmlLink: calendarResponse.data.htmlLink,
    //   start: calendarResponse.data.start,
    //   end: calendarResponse.data.end,
    // });

    // Update call with calendar event info
    await supabase
      .from("calls")
      .update({
        calendar_event_id: calendarResponse.data.id,
        calendar_event_link: calendarResponse.data.htmlLink,
        updated_at: new Date().toISOString(),
      })
      .eq("conversation_id", call.conversation_id);

    // console.log("✅ [CALENDAR] Call updated with calendar event info");
  } catch (error) {
    // console.error("❌ [CALENDAR] Error creating calendar event:", error);
  }
}

// Función auxiliar para obtener el cliente de Twilio correcto para un usuario
async function getTwilioClientForUser(userId) {
  try {
    if (!userId) {
      console.log("🔍 [TWILIO CLIENT] No user ID provided, using main account");
      return { client: twilioClient, accountInfo: "Main account" };
    }

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("twilio_subaccount_sid, twilio_auth_token")
      .eq("id", userId)
      .single();

    if (
      userError ||
      !userData?.twilio_subaccount_sid ||
      !userData?.twilio_auth_token
    ) {
      console.log(
        `🔍 [TWILIO CLIENT] No subaccount for user ${userId}, using main account`
      );
      return { client: twilioClient, accountInfo: "Main account" };
    }

    // Use subaccount client
    const userClient = new Twilio(
      userData.twilio_subaccount_sid,
      userData.twilio_auth_token
    );

    console.log(
      `🔍 [TWILIO CLIENT] Using subaccount for user ${userId}: ${userData.twilio_subaccount_sid}`
    );

    return {
      client: userClient,
      accountInfo: `Subaccount: ${userData.twilio_subaccount_sid}`,
    };
  } catch (error) {
    console.error(
      `❌ [TWILIO CLIENT] Error getting client for user ${userId}:`,
      error
    );
    return { client: twilioClient, accountInfo: "Main account (fallback)" };
  }
}

// Función para reanudar la llamada después de pausa
const resumeTwilioCall = async (callSid, delayMs = 1000) => {
  if (!callSid) return;
  setTimeout(async () => {
    try {
      // Get call data to find the user
      const { data: callData, error: callError } = await supabase
        .from("calls")
        .select("user_id")
        .eq("call_sid", callSid)
        .single();

      // Get the correct Twilio client
      const { client: twilioClientToUse, accountInfo } =
        await getTwilioClientForUser(callData?.user_id);

      await twilioClientToUse.calls(callSid).update({
        url: `https://${RAILWAY_PUBLIC_DOMAIN}/twiml/resume`,
        method: "POST",
      });
      console.log(
        `🔄 [TWILIO] Llamada reanudada para callSid: ${callSid} usando ${accountInfo}`
      );
    } catch (err) {
      console.error("❌ [TWILIO] Error reanudando llamada:", err);
    }
  }, delayMs);
};

// Function to analyze transcript and generate Spanish summary and commercial suggestion
async function analyzeTranscriptAndGenerateInsights(
  transcript,
  originalSummary,
  callData = null, // Agregar parámetro opcional para datos de la llamada
  questions = null // Agregar parámetro para las preguntas enviadas
) {
  try {
    console.log(
      "🔍 [ANALYSIS] Starting transcript analysis and insight generation"
    );

    if (!transcript || transcript.length === 0) {
      console.log("❌ [ANALYSIS] No transcript to analyze");
      return {
        summary: null,
        commercialSuggestion: null,
        detailedResult: null,
      };
    }

    const { OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });

    // Prepare the full transcript text
    const fullTranscript = transcript
      .map((turn) => `${turn.role}: ${turn.message}`)
      .join("\n");

    console.log(
      "📝 [ANALYSIS] Full transcript length:",
      fullTranscript.length,
      "characters"
    );

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un asistente experto que analiza el RESULTADO FINAL de llamadas comerciales.
        
        INSTRUCCIONES:
        1. Lee la transcripción completa
        2. Analiza los DATOS ADICIONALES (razón de fin, duración, etc.)
        3. Determina el RESULTADO FINAL basado en lo que REALMENTE PASÓ
        4. Genera un resumen CONCISO que incluya las respuestas a las preguntas enviadas (máximo 250 palabras)
        5. Sugiere el próximo paso comercial (máximo 50 palabras)
        
        IMPORTANTE PARA EL RESUMEN:
        - El resumen DEBE incluir las respuestas específicas que dio el cliente a las preguntas
        - Menciona qué información proporcionó el cliente (presupuesto, ubicación, tiempo, etc.)
        - Incluye detalles relevantes sobre sus necesidades o preferencias
        - Si el cliente no respondió ciertas preguntas, indícalo
        - El resumen debe ser útil para el seguimiento comercial
        
        PREGUNTAS ENVIADAS AL CLIENTE:
        ${
          questions
            ? questions
                .map((q, index) => `${index + 1}. ${q.question_text}`)
                .join("\n")
            : "No se especificaron preguntas personalizadas"
        }
        
        INSTRUCCIONES ESPECÍFICAS:
        - Identifica en la transcripción las respuestas a cada pregunta enviada
        - En el resumen, menciona específicamente qué respondió el cliente a cada pregunta
        - Si el cliente no respondió alguna pregunta, indícalo claramente
        - Organiza la información de manera clara y estructurada
        
        CRITERIOS ESPECÍFICOS PARA CADA RESULTADO:
        
        🎯 "Buzón de Voz" - SOLO cuando:
        - Se escucha un mensaje de buzón de voz
        - No hay conversación humana
        
        🎯 "No Contestó" - SOLO cuando:
        - El teléfono suena pero nadie contesta
        - No hay conversación ni buzón de voz
        
        🎯 "Línea Ocupada" - SOLO cuando:
        - Se escucha tono de ocupado
        - end_reason indica línea ocupada
        
        🎯 "Teléfono Inválido" - SOLO cuando:
        - El número no existe o está mal formado
        - end_reason indica número inválido
        
        🎯 "Llamada Cortada" - SOLO cuando:
        - La llamada se corta abruptamente
        - end_reason indica desconexión inesperada
        - Duración muy corta sin conversación
        
        🎯 "Cita Agendada" - SOLO cuando:
        - Se confirma que se agendó una cita
        - calendar_event_id existe
        - El cliente aceptó agendar
        
        🎯 "Cliente No Interesado" - SOLO cuando:
        - El cliente dice EXPLÍCITAMENTE que no está interesado
        - Rechaza la oferta de forma clara
        - Dice "no me interesa", "no quiero", etc.
        
        🎯 "Cliente Interesado" - SOLO cuando:
        - El cliente muestra interés claro
        - Pregunta por detalles, precios, etc.
        - Dice que le interesa pero no agenda
        
        🎯 "Cliente con Objeciones" - SOLO cuando:
        - El cliente está indeciso o tiene dudas
        - Menciona objeciones pero no rechaza completamente
        - Dice "déjame pensarlo", "no estoy seguro", etc.
        - Muestra interés pero no se compromete
        

        
        🎯 "Conversación Falló" - SOLO cuando:
        - Hubo un fallo técnico en la llamada
        - Problemas de conexión o audio
        - Error en el sistema que impidió la conversación
        - Fallo en la tecnología de la llamada
        
        REGLAS IMPORTANTES:
        - Analiza PRIMERO los DATOS ADICIONALES (end_reason, duración, etc.)
        - El end_reason "Client disconnected: 1005" indica que el cliente colgó
        - Si el cliente colgó durante la conversación, considera el contexto
        - Duración corta (<30 seg) sin conversación = "No Contestó"
        - Duración media con conversación = analiza el contenido
        - Duración larga con conversación = analiza el resultado final
        - Si el cliente mostró interés = "Cliente Interesado"
        - Si el cliente está indeciso = "Cliente con Objeciones"
        - Si el cliente rechazó = "Cliente No Interesado"
        
        Formato EXACTO:
        RESUMEN:
        [resultado simple y directo de la llamada]
        
        SUGERENCIA:
        [próximo paso específico]
        
        RESULTADO:
        [uno de los resultados posibles listados arriba]`,
        },

        {
          role: "user",
          content: `Analiza el resultado de esta llamada:
        
        TRANSCRIPCIÓN:
        ${fullTranscript}
        
        RESUMEN ORIGINAL:
        ${originalSummary || "No disponible"}
        
        DATOS ADICIONALES:
        ${
          callData
            ? `
        Razón de fin: ${callData.end_reason || "No disponible"}
        Estado de conexión: ${callData.connection_status || "No disponible"}
        Duración: ${callData.duration || 0} segundos
        Turnos de conversación: ${callData.turn_count || 0}
        Llamada exitosa: ${callData.call_successful || "No disponible"}
        Cita agendada: ${callData.calendar_event_id ? "Sí" : "No"}
        `
            : "No disponibles"
        }`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const analysisResult = response.choices[0]?.message?.content?.trim();

    if (analysisResult) {
      console.log("✅ [ANALYSIS] Analysis completed successfully");
      console.log("🔍 [ANALYSIS] Raw OpenAI response:", analysisResult);

      // Parse the response to extract summary, commercial suggestion, and detailed result
      const summaryMatch = analysisResult.match(
        /RESUMEN:\s*([\s\S]*?)(?=SUGERENCIA:|RESULTADO:|$)/i
      );
      const suggestionMatch = analysisResult.match(
        /SUGERENCIA:\s*([\s\S]*?)(?=RESULTADO:|$)/i
      );
      const resultMatch = analysisResult.match(/RESULTADO:\s*([\s\S]*?)$/i);

      const summary = summaryMatch ? summaryMatch[1].trim() : null;
      const commercialSuggestion = suggestionMatch
        ? suggestionMatch[1].trim()
        : null;
      const detailedResult = resultMatch ? resultMatch[1].trim() : null;

      console.log("🔍 [ANALYSIS] Summary match:", !!summaryMatch);
      console.log("🔍 [ANALYSIS] Suggestion match:", !!suggestionMatch);
      console.log("🔍 [ANALYSIS] Result match:", !!resultMatch);

      console.log(
        "📝 [ANALYSIS] Summary length:",
        summary?.length || 0,
        "characters"
      );
      console.log(
        "💡 [ANALYSIS] Commercial suggestion length:",
        commercialSuggestion?.length || 0,
        "characters"
      );
      console.log("🎯 [ANALYSIS] Detailed result:", detailedResult);

      return { summary, commercialSuggestion, detailedResult };
    } else {
      console.log("❌ [ANALYSIS] No analysis result received from OpenAI");
      return {
        summary: null,
        commercialSuggestion: null,
        detailedResult: null,
      };
    }
  } catch (error) {
    console.error("❌ [ANALYSIS] Error analyzing transcript:", error);
    return { summary: null, commercialSuggestion: null, detailedResult: null };
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
    // 1. Extraer userId de metadata
    let userId = session?.metadata?.userId || null;
    let user = null;
    let foundBy = null;

    // 2. Buscar usuario por userId
    if (userId) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();
      if (data) {
        user = data;
        foundBy = "userId";
      }
    }
    // 3. Si no, buscar por email
    if (!user && session?.customer_email) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("email", session.customer_email)
        .single();
      if (data) {
        user = data;
        foundBy = "email";
      }
    }
    // 4. Si no, buscar por stripe_customer_id
    if (!user && session?.customer) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("stripe_customer_id", session.customer)
        .single();
      if (data) {
        user = data;
        foundBy = "stripe_customer_id";
      }
    }
    if (!user) {
      console.error(
        "[STRIPE] No se encontró usuario para checkout.session.completed",
        {
          userId,
          email: session?.customer_email,
          stripeCustomerId: session?.customer,
          session,
        }
      );
      return;
    }

    // 5. Actualizar usuario con los datos de Stripe
    await supabase
      .from("users")
      .update({
        stripe_customer_id: session.customer,
        email: session.customer_email,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);
    // Asegúrate de que user.stripe_customer_id esté actualizado en memoria
    user.stripe_customer_id = session.customer;

    // 6. Actualizar o crear user_subscriptions
    if (session.subscription) {
      // Obtener detalles de la suscripción de Stripe
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription
      );
      const stripePriceId = subscription?.items?.data?.[0]?.plan?.id || null;
      let planUuid = null;
      if (stripePriceId) {
        const { data: planData } = await supabase
          .from("subscription_plans")
          .select("id")
          .eq("stripe_price_id", stripePriceId)
          .single();
        planUuid = planData?.id || null;
      }
      // Resetear créditos del usuario según el plan
      const planCredits = await getPlanCredits(stripePriceId);
      // Obtener el precio de la suscripción de Stripe
      let subscriptionPrice = 159.2; // Valor por defecto
      if (subscription?.items?.data?.[0]?.price?.unit_amount) {
        subscriptionPrice = subscription.items.data[0].price.unit_amount / 100; // Convertir de centavos a dólares
      } else if (subscription?.items?.data?.[0]?.price?.unit_amount_decimal) {
        subscriptionPrice =
          parseFloat(subscription.items.data[0].price.unit_amount_decimal) /
          100; // Convertir de centavos a dólares
      }

      // Obtener fechas del período actual
      const currentPeriodStart = subscription?.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : new Date().toISOString();
      const currentPeriodEnd = subscription?.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 días por defecto

      console.log("💰 [STRIPE] Guardando precio de suscripción:", {
        userId: user.id,
        subscriptionPrice,
        stripePriceId,
        planCredits,
        currentPeriodStart,
        currentPeriodEnd,
      });

      await supabase.from("user_subscriptions").upsert(
        {
          user_id: user.id,
          stripe_subscription_id: session.subscription,
          plan_id: planUuid,
          status: subscription.status,
          stripe_customer_id: user.stripe_customer_id || session.customer,
          credits_per_month: planCredits,
          price_per_month: subscriptionPrice, // <-- Agregar precio mensual
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
        },
        { onConflict: "user_id" }
      );
      await supabase
        .from("users")
        .update({
          available_call_credits: planCredits,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      console.log(
        "[STRIPE] Créditos reseteados para usuario",
        user.id,
        "a",
        planCredits
      );
    }

    console.log("[STRIPE] Usuario y suscripción actualizados correctamente", {
      userId: user.id,
      foundBy,
      subscription: session.subscription,
    });
  } catch (error) {
    console.error("[STRIPE] Error in handleCheckoutSessionCompleted:", error);
  }
}
// Handle invoice.payment_succeeded event
async function handleInvoicePaymentSucceeded(invoice, stripe) {
  try {
    console.log("✅ [STRIPE] Processing invoice.payment_succeeded");

    // 1. Obtener subscriptionId de varias rutas posibles
    let subscriptionId = invoice.subscription;
    if (!subscriptionId) {
      // Opción 1: parent.subscription_details.subscription
      subscriptionId = invoice?.parent?.subscription_details?.subscription;
    }
    if (!subscriptionId && invoice?.lines?.data?.length > 0) {
      // Opción 2: lines.data[0].parent.subscription_item_details.subscription
      subscriptionId =
        invoice.lines.data[0]?.parent?.subscription_item_details?.subscription;
    }
    if (!subscriptionId) {
      console.error("[STRIPE] No subscriptionId in invoice");
      return;
    }

    // 2. Obtener la suscripción de Stripe para extraer el userId y plan
    let subscription = null;
    let userIdFromMeta =
      invoice?.parent?.subscription_details?.metadata?.userId || null;
    let stripePriceId = null;
    if (!userIdFromMeta) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        userIdFromMeta = subscription?.metadata?.userId || null;
        stripePriceId = subscription?.items?.data?.[0]?.plan?.id || null;
      } catch (err) {
        console.error("[STRIPE] Error fetching subscription for userId:", err);
      }
    } else {
      // Si ya tenemos userIdFromMeta, igual necesitamos el stripePriceId
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        stripePriceId = subscription?.items?.data?.[0]?.plan?.id || null;
      } catch (err) {
        console.error("[STRIPE] Error fetching subscription for planId:", err);
      }
    }

    // 3. Buscar usuario por userId, email o stripe_customer_id
    let user = null;
    let foundBy = null;
    const email = invoice?.customer_email || null;
    const stripeCustomerId = invoice?.customer || null;

    if (userIdFromMeta) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("id", userIdFromMeta)
        .single();
      if (data) {
        user = data;
        foundBy = "userId";
      }
    }
    if (!user && email) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();
      if (data) {
        user = data;
        foundBy = "email";
      }
    }
    if (!user && stripeCustomerId) {
      const { data } = await supabase
        .from("users")
        .select("*")
        .eq("stripe_customer_id", stripeCustomerId)
        .single();
      if (data) {
        user = data;
        foundBy = "stripe_customer_id";
      }
    }
    if (!user) {
      console.error(
        "❌ [STRIPE] User not found for event",
        invoice?.id,
        JSON.stringify(invoice, null, 2)
      );
      return;
    }

    // 4. Si no tienes la suscripción, obténla aquí para el stripePriceId y status
    if (!subscription) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
      stripePriceId = subscription?.items?.data?.[0]?.plan?.id || null;
    }

    // Buscar el UUID del plan
    let planUuid = null;
    if (stripePriceId) {
      const { data: planData } = await supabase
        .from("subscription_plans")
        .select("id")
        .eq("stripe_price_id", stripePriceId)
        .single();
      planUuid = planData?.id || null;
    }

    // Antes del upsert, asegúrate de que user.stripe_customer_id esté actualizado
    if (!user.stripe_customer_id && invoice.customer) {
      await supabase
        .from("users")
        .update({ stripe_customer_id: invoice.customer })
        .eq("id", user.id);
      user.stripe_customer_id = invoice.customer;
    }

    // 5. Upsert en user_subscriptions (solo si hay user y planUuid)
    if (user && planUuid) {
      const planCredits = await getPlanCredits(stripePriceId);

      // Obtener el precio de la suscripción de Stripe
      let subscriptionPrice = 159.2; // Valor por defecto
      if (subscription?.items?.data?.[0]?.price?.unit_amount) {
        subscriptionPrice = subscription.items.data[0].price.unit_amount / 100; // Convertir de centavos a dólares
      } else if (subscription?.items?.data?.[0]?.price?.unit_amount_decimal) {
        subscriptionPrice =
          parseFloat(subscription.items.data[0].price.unit_amount_decimal) /
          100; // Convertir de centavos a dólares
      }

      // Obtener fechas del período actual
      const currentPeriodStart = subscription?.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : new Date().toISOString();
      const currentPeriodEnd = subscription?.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 días por defecto

      const { data: upsertData, error: upsertError } = await supabase
        .from("user_subscriptions")
        .upsert(
          {
            user_id: user.id,
            stripe_subscription_id: subscriptionId,
            plan_id: planUuid,
            status: subscription?.status || null,
            stripe_customer_id: user.stripe_customer_id || invoice.customer,
            credits_per_month: planCredits,
            price_per_month: subscriptionPrice, // <-- Agregar precio mensual
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
          },
          { onConflict: "user_id" }
        );
      if (upsertError) {
        console.error(
          "[STRIPE] Error upserting user_subscriptions:",
          upsertError
        );
      } else {
        console.log("[STRIPE] user_subscriptions upserted:", upsertData);
      }
    } else {
      console.warn(
        "[STRIPE] No se pudo hacer upsert en user_subscriptions: falta user o planUuid",
        { user: user?.id, planUuid }
      );
    }

    // 6. Resetear créditos del usuario según el plan
    const planCredits = await getPlanCredits(stripePriceId);
    await supabase
      .from("users")
      .update({
        available_call_credits: planCredits,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    console.log(
      "[STRIPE] Créditos reseteados para usuario",
      user.id,
      "a",
      planCredits
    );
  } catch (error) {
    console.error("[STRIPE] Error in handleInvoicePaymentSucceeded:", error);
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

    // --- Lógica de búsqueda de usuario robusta (para ambos handlers) ---
    let user = null;
    let foundBy = null;
    let stripeCustomerId = invoice?.customer || null;
    let userIdFromMeta =
      invoice?.parent?.subscription_details?.metadata?.userId || null;
    let email = invoice?.customer_email || null;

    // 1. Buscar por userId (metadata)
    if (userIdFromMeta) {
      const { data: userById } = await supabase
        .from("users")
        .select("*")
        .eq("id", userIdFromMeta)
        .order("created_at", { ascending: false })
        .limit(1);
      if (userById) {
        user = userById;
        foundBy = "userId";
      }
    }
    // 2. Buscar por email
    if (!user && email) {
      const { data: userByEmail } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .order("created_at", { ascending: false })
        .limit(1);
      if (userByEmail) {
        user = userByEmail;
        foundBy = "email";
      }
    }
    // 3. Buscar por stripe_customer_id
    if (!user && stripeCustomerId) {
      const { data: userByStripeId } = await supabase
        .from("users")
        .select("*")
        .eq("stripe_customer_id", stripeCustomerId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (userByStripeId) {
        user = userByStripeId;
        foundBy = "stripe_customer_id";
      }
    }
    // Si no hay usuario, loguear y retornar
    if (!user) {
      console.error("❌ [STRIPE] User not found for event", invoice?.id);
      return;
    }
    // Si el stripe_customer_id no coincide, actualizarlo
    if (stripeCustomerId && user.stripe_customer_id !== stripeCustomerId) {
      await supabase
        .from("users")
        .update({
          stripe_customer_id: stripeCustomerId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      console.log(
        "✅ [STRIPE] Updated user stripe_customer_id for user:",
        user.id
      );
    }

    // Get the user subscription record
    const { data: userSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select("user_id, minutes_per_month, plan_id")
      .eq("stripe_subscription_id", subscription.id)
      .order("created_at", { ascending: false })
      .limit(1);

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

        .order("created_at", { ascending: false })
        .limit(1);

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
      .order("created_at", { ascending: false })
      .limit(1);

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
      .order("created_at", { ascending: false })
      .limit(1);

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
      .order("created_at", { ascending: false })
      .limit(1);

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
      .order("created_at", { ascending: false })
      .limit(1);

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

        .order("created_at", { ascending: false })
        .limit(1);

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
        // referred_credits: userSubscription.credits_per_month || 0, // Comentado: columna no existe
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
    console.log(
      "🎙️ [TWILIO RECORDING] Body:",
      JSON.stringify(request.body, null, 2)
    );

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
      // console.log(
      //   `🎙️ [TWILIO RECORDING] Recording from subaccount: ${AccountSid}`
      // );
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
      .order("created_at", { ascending: false })
      .limit(1);

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

    // callData es un array, tomar el primer elemento
    const call = callData && callData.length > 0 ? callData[0] : null;

    console.log(`🎙️ [RECORDING DOWNLOAD] Call data from DB for ${callSid}:`, {
      callDataLength: callData ? callData.length : 0,
      call: call
        ? {
            user_id: call.user_id,
            users: call.users
              ? {
                  twilio_subaccount_sid: call.users.twilio_subaccount_sid
                    ? call.users.twilio_subaccount_sid.substring(0, 10) + "..."
                    : null,
                  has_twilio_auth_token: !!call.users.twilio_auth_token,
                  auth_token_length: call.users.twilio_auth_token
                    ? call.users.twilio_auth_token.length
                    : 0,
                }
              : null,
          }
        : null,
    });

    if (call?.users?.twilio_subaccount_sid && call?.users?.twilio_auth_token) {
      // Usar las credenciales de la subcuenta del usuario
      accountSid = call.users.twilio_subaccount_sid;
      authToken = call.users.twilio_auth_token;
      twilioClientToUse = new Twilio(accountSid, authToken);

      console.log(
        `🎙️ [RECORDING DOWNLOAD] Using user's subaccount for call ${callSid}:`,
        {
          userId: call.user_id,
          subaccountSid: accountSid,
          hasAuthToken: !!authToken,
          authTokenLength: authToken ? authToken.length : 0,
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

    console.log(`🎙️ [RECORDING DOWNLOAD] Recording info for ${callSid}:`, {
      recordingSid,
      accountSid,
      recordingUri: recording.uri,
      mediaFormat: recording.mediaFormat,
      extension,
    });

    // Usar la URL original que viene de Twilio
    const actualRecordingUrl = `https://api.twilio.com${recording.uri.replace(
      ".json",
      `.${extension}`
    )}`;

    console.log(`🎙️ [RECORDING DOWNLOAD] Using URL: ${actualRecordingUrl}`);

    console.log(
      `🎙️ [RECORDING DOWNLOAD] Attempting download with credentials:`,
      {
        accountSid: accountSid.substring(0, 10) + "...",
        authTokenLength: authToken.length,
        url: actualRecordingUrl,
      }
    );

    const response = await fetch(actualRecordingUrl, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      },
    });

    console.log(`🎙️ [RECORDING DOWNLOAD] Download response:`, {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
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

    // Subir a Supabase    // Subir a Supabase Storage
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
// 🆕 Función asíncrona para obtener precio de llamada con reintentos
async function fetchCallPriceAsync(callSid, callUri, twilioClientToUse = null) {
  const MAX_RETRIES = 50;
  const RETRY_DELAY = 10000; // 10 segundos

  // Verificar duración de la llamada antes de procesar
  try {
    const { data: callRecord, error: callError } = await supabase
      .from("calls")
      .select("duration, to_country, to_number")
      .eq("call_sid", callSid)
      .limit(1);

    if (callError) {
      console.error(
        `❌ [CREDITS] Error obteniendo datos de llamada para CallSid ${callSid}:`,
        callError
      );
      return;
    }

    if (!callRecord || callRecord.length === 0) {
      console.warn(
        `⚠️ [CREDITS] No se encontró registro de llamada para CallSid ${callSid}`
      );
      return;
    }

    const callDuration = parseInt(callRecord[0]?.duration || "0", 10);
    const countryCode = callRecord[0]?.to_country; // Viene como "AR" de Twilio
    const toNumber = callRecord[0]?.to_number;

    // 🚫 No procesar llamadas de menos de 5 segundos
    if (callDuration < 5) {
      console.log(
        `⏱️ [CREDITS] Llamada de ${callDuration} segundos (< 5s) - No se procesan créditos para CallSid: ${callSid}`
      );

      // Marcar la llamada como no cobrable
      await supabase
        .from("calls")
        .update({
          call_price: 0,
          call_price_unit: "USD",
          call_price_per_minute: 0,
          call_duration_minutes: 0,
          call_credits_cost: 0,
          call_pricing_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("call_sid", callSid);

      return;
    }

    console.log(`✅ [CREDITS] Procesando créditos para CallSid: ${callSid}`, {
      duration: callDuration,
      country: countryCode,
      toNumber: toNumber,
    });

    // 🌍 Buscar tarifa basada en país y prefijo de teléfono
    let selectedTariff = null;
    let searchMethod = "";

    if (countryCode && toNumber) {
      // 1️⃣ Buscar por país exacto + prefijo más específico
      const phonePrefix = extractPhonePrefix(toNumber);
      console.log(
        ` [CREDITS] Buscando tarifa para país: ${countryCode}, prefijo: ${phonePrefix}`
      );

      // Obtener todas las tarifas que coincidan con el país base (AR_1, AR_2, etc.)
      const { data: pricingData, error: pricingError } = await supabase
        .from("country_call_pricing")
        .select("*")
        .or(
          `country_code.eq.${countryCode},country_code.like.${countryCode}_%`
        );

      if (pricingError) {
        console.error(
          `❌ [CREDITS] Error obteniendo tarifas para ${countryCode}:`,
          pricingError
        );
      } else if (pricingData && pricingData.length > 0) {
        console.log(
          `📊 [CREDITS] Encontradas ${pricingData.length} tarifas para ${countryCode}`
        );

        // Filtrar tarifas que tengan prefijos de teléfono
        const tariffsWithPrefixes = pricingData.filter((t) => t.prefixes);

        if (tariffsWithPrefixes.length > 0) {
          // Buscar el prefijo más específico (más largo) que coincida
          const matchingPrefixes = [];
          const cleanNumber = toNumber.replace(/\D/g, "");

          console.log(
            `🔍 [CREDITS] Buscando coincidencias para número: ${toNumber} (limpio: ${cleanNumber})`
          );

          for (const tariff of tariffsWithPrefixes) {
            const prefixList = tariff.prefixes.split(",").map((p) => p.trim());
            console.log(
              `🔍 [CREDITS] Tarifa ${
                tariff.country_code
              } tiene prefijos: ${prefixList.join(", ")}`
            );

            for (const prefix of prefixList) {
              if (cleanNumber.startsWith(prefix)) {
                console.log(
                  `✅ [CREDITS] ¡Coincidencia encontrada! Prefijo ${prefix} coincide con ${cleanNumber}`
                );
                matchingPrefixes.push({
                  ...tariff,
                  matchedPrefix: prefix,
                });
              } else {
                console.log(
                  `❌ [CREDITS] Prefijo ${prefix} NO coincide con ${cleanNumber}`
                );
              }
            }
          }

          // Ordenar por longitud del prefijo (más específico primero)
          matchingPrefixes.sort(
            (a, b) => b.matchedPrefix.length - a.matchedPrefix.length
          );

          if (matchingPrefixes.length > 0) {
            selectedTariff = matchingPrefixes[0];
            searchMethod = `prefijo_específico_${selectedTariff.matchedPrefix}`;
            console.log(
              `🎯 [CREDITS] Tarifa encontrada por prefijo específico:`,
              {
                country: selectedTariff.country_code,
                prefix: selectedTariff.matchedPrefix,
                price_per_credit: selectedTariff.price_per_credit,
                number: toNumber,
              }
            );
          }
        }

        // Si no se encontró por prefijo, usar la tarifa más baja del grupo
        if (!selectedTariff) {
          selectedTariff = pricingData.reduce((lowest, current) =>
            current.price_per_credit < lowest.price_per_credit
              ? current
              : lowest
          );
          searchMethod = "tarifa_más_baja_grupo";
          console.log(`🎯 [CREDITS] Usando tarifa más baja del grupo:`, {
            country: selectedTariff.country_code,
            price_per_credit: selectedTariff.price_per_credit,
          });
        }
      }
    }

    // Si no se encontró tarifa, usar una tarifa por defecto razonable
    if (!selectedTariff) {
      console.log(
        `🔄 [CREDITS] No se encontró tarifa específica, buscando tarifa por defecto`
      );

      // Buscar una tarifa por defecto (US o la más baja disponible)
      const { data: defaultPricing, error: pricingError } = await supabase
        .from("country_call_pricing")
        .select("*")
        .or("country_code.eq.US,country_code.eq.MX,country_code.eq.AR")
        .order("price_per_credit", { ascending: true }) // Ordenar de menor a mayor
        .limit(1);

      if (pricingError || !defaultPricing || defaultPricing.length === 0) {
        // Si no hay tarifas por defecto, usar una tarifa mínima fija
        console.log(
          `⚠️ [CREDITS] No se encontraron tarifas por defecto, usando tarifa mínima fija`
        );
        selectedTariff = {
          id: null,
          country_code: "DEFAULT",
          price_per_credit: 0.02, // 2 centavos por crédito (muy bajo)
          price_per_minute: 0.02,
        };
        searchMethod = "tarifa_mínima_fija";
      } else {
        selectedTariff = defaultPricing[0];
        searchMethod = "tarifa_por_defecto";
        console.log(`🎯 [CREDITS] Usando tarifa por defecto:`, {
          country: selectedTariff.country_code,
          price_per_credit: selectedTariff.price_per_credit,
        });
      }
    }

    // Calcular créditos
    const minutesRounded = Math.ceil(callDuration / 60);
    const totalCredits = Math.ceil(
      selectedTariff.price_per_credit * minutesRounded
    );

    console.log(` [CREDITS] Créditos calculados:`, {
      callSid,
      duration: callDuration,
      minutes: minutesRounded,
      price_per_credit: selectedTariff.price_per_credit,
      totalCredits,
      searchMethod,
    });

    // Actualizar la base de datos
    const updateData = {
      call_price: null, // No obtenemos precio real de Twilio
      call_price_unit: "USD",
      call_price_per_minute: selectedTariff.price_per_credit,
      call_duration_minutes: minutesRounded,
      call_credits_cost: totalCredits,
      call_pricing_id: selectedTariff.id,
      call_pricing_search_method: searchMethod, // Guardar el método de búsqueda usado
      updated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("call_sid", callSid);

    if (updateError) {
      console.error(
        `❌ [CREDITS] Error actualizando BD para CallSid ${callSid}:`,
        updateError
      );
      return;
    }

    console.log(
      `✅ [CREDITS] Precio y créditos guardados para CallSid ${callSid}:`,
      updateData
    );

    // 🔥 DEDUCIR CRÉDITOS DEL USUARIO
    try {
      // Obtener el user_id de la llamada
      const { data: callData, error: callError } = await supabase
        .from("calls")
        .select("user_id")
        .eq("call_sid", callSid)
        .limit(1);

      if (callError) {
        console.error(
          `❌ [CREDITS] Error obteniendo user_id para CallSid ${callSid}:`,
          callError
        );
        return;
      }

      if (callData && callData[0]?.user_id) {
        const userId = callData[0].user_id;

        // Obtener créditos actuales del usuario
        const { data: userData, error: userError } = await supabase
          .from("users")
          .select("available_call_credits")
          .eq("id", userId)
          .limit(1);

        if (userError) {
          console.error(
            `❌ [CREDITS] Error obteniendo créditos del usuario ${userId}:`,
            userError
          );
          return;
        }

        if (userData) {
          const currentCredits = userData[0]?.available_call_credits || 0;
          const newCredits = Math.max(0, currentCredits - totalCredits);

          console.log(
            `💳 [CREDITS] Deduciendo créditos para usuario ${userId}:`,
            {
              callSid,
              totalCredits,
              before: currentCredits,
              after: newCredits,
              deducted: currentCredits - newCredits,
              searchMethod,
            }
          );

          // Actualizar créditos del usuario
          const { error: creditUpdateError } = await supabase
            .from("users")
            .update({
              available_call_credits: newCredits,
              updated_at: new Date().toISOString(),
            })
            .eq("id", userId);

          if (creditUpdateError) {
            console.error(
              `❌ [CREDITS] Error actualizando créditos del usuario ${userId}:`,
              creditUpdateError
            );
          } else {
            console.log(
              `✅ [CREDITS] Créditos deducidos exitosamente para usuario ${userId}: ${totalCredits} créditos`
            );
          }
        }
      } else {
        console.warn(
          `⚠️ [CREDITS] No se encontró user_id para CallSid ${callSid}`
        );
      }
    } catch (deductionError) {
      console.error(
        `❌ [CREDITS] Error durante la deducción de créditos para CallSid ${callSid}:`,
        deductionError
      );
    }
  } catch (error) {
    console.error(
      `❌ [CREDITS] Error general en fetchCallPriceAsync para CallSid ${callSid}:`,
      error
    );
  }
}

// 🆕 Función auxiliar para extraer prefijo de teléfono (simplificada)
function extractPhonePrefix(phoneNumber) {
  if (!phoneNumber) return "";

  // Remover caracteres no numéricos y retornar el número completo
  // La lógica de búsqueda de prefijos se hace directamente en el código principal
  return phoneNumber.replace(/\D/g, "");
}
async function getPlanCredits(stripePriceId) {
  if (!stripePriceId) return 0;
  const { data, error } = await supabase
    .from("subscription_plans")
    .select("credits_per_month")
    .eq("stripe_price_id", stripePriceId)
    .single();
  if (error || !data) {
    console.error("[STRIPE] Error fetching plan credits:", error);
    return 0;
  }
  return data.credits_per_month || 0;
}
