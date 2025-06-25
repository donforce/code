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
  // Google Calendar configuration
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  // OpenAI configuration
  OPENAI_API_KEY,
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
  !OPENAI_API_KEY
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
    console.log("[Queue] 🔄 Starting queue processing...");
    console.log(
      `[Queue] 📊 Current active calls: ${globalActiveCalls.size}/${QUEUE_CONFIG.maxConcurrentCalls}`
    );

    // Check if we can process more calls
    if (globalActiveCalls.size >= QUEUE_CONFIG.maxConcurrentCalls) {
      console.log(
        "[Queue] ⏸️ Max concurrent calls reached, skipping processing"
      );
      return;
    }

    // Get all pending queue items with optimized query
    console.log("[Queue] 🔍 Fetching pending queue items...");
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
      console.error("[Queue] ❌ Error fetching pending queues:", error);
      return;
    }

    if (!pendingQueues || pendingQueues.length === 0) {
      console.log("[Queue] ℹ️ No pending queues found");
      return;
    }

    console.log(`[Queue] 📋 Found ${pendingQueues.length} pending queue items`);

    // Get user data in single query for all users
    const userIds = [...new Set(pendingQueues.map((item) => item.user_id))];
    console.log(
      `[Queue] 👥 Fetching data for ${userIds.length} users:`,
      userIds
    );

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

    console.log(`[Queue] ✅ Found ${usersData?.length || 0} users with data`);

    // Create optimized user lookup map
    const usersMap = new Map(usersData?.map((user) => [user.id, user]) || []);

    // Filter eligible items efficiently
    const eligibleItems = [];
    const processedUsers = new Set();

    for (const item of pendingQueues) {
      const user = usersMap.get(item.user_id);
      console.log(
        `[Queue] 🔍 Checking item ${item.id} for user ${item.user_id}:`,
        {
          hasUser: !!user,
          availableMinutes: user?.available_minutes || 0,
          hasActiveCall: userActiveCalls.has(item.user_id),
          alreadyProcessed: processedUsers.has(item.user_id),
        }
      );

      if (!user || user.available_minutes <= 0) {
        console.log(
          `[Queue] ❌ User ${item.user_id} not eligible: no user data or no minutes`
        );
        continue;
      }
      if (userActiveCalls.has(item.user_id)) {
        console.log(
          `[Queue] ❌ User ${item.user_id} not eligible: already has active call`
        );
        continue;
      }
      if (processedUsers.has(item.user_id)) {
        console.log(
          `[Queue] ❌ User ${item.user_id} not eligible: already processed`
        );
        continue;
      }

      eligibleItems.push(item);
      processedUsers.add(item.user_id);
      console.log(
        `[Queue] ✅ Item ${item.id} for user ${item.user_id} is eligible`
      );
    }

    if (eligibleItems.length === 0) {
      console.log("[Queue] ℹ️ No eligible items found");
      return;
    }

    console.log(`[Queue] 🎯 Found ${eligibleItems.length} eligible items`);

    // Process items concurrently with optimized batch size
    const itemsToProcess = eligibleItems.slice(
      0,
      QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size
    );

    console.log(
      `[Queue] 🚀 Processing ${itemsToProcess.length} items concurrently`
    );

    // Process items concurrently without waiting for all to complete
    itemsToProcess.forEach(async (item) => {
      console.log(`[Queue] 🔄 Starting processing for item ${item.id}`);
      processQueueItemWithRetry(item).catch((error) => {
        console.error(`[Queue] ❌ Error processing item ${item.id}:`, error);
      });
    });
  } catch (error) {
    console.error("[Queue] ❌ Error in queue processing:", error);
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
      console.log(
        `[Calendar][SUMMARY] Obteniendo eventos de Google Calendar...`
      );
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
      console.log(
        `[Calendar][SUMMARY] Rango de fechas: ${now.toISOString()} a ${twoWeeksFromNow.toISOString()}`
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
        console.log(
          `[Calendar][SUMMARY][EVENT] ${dayKey}: ${
            event.summary || "Sin título"
          } (${start.toISOString()} - ${end.toISOString()})`
        );
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
        `[Calendar][SUMMARY] Días ocupados: ${summary.busyDays.length} | Días libres: ${summary.freeDays.length}`
      );
      console.log(`[Calendar][SUMMARY] Días ocupados:`, summary.busyDays);
      console.log(`[Calendar][SUMMARY] Días libres:`, summary.freeDays);

      // Mostrar resumen detallado por consola
      console.log("=".repeat(80));
      console.log("📅 RESUMEN DETALLADO DE DISPONIBILIDAD DEL CALENDARIO");
      console.log("=".repeat(80));
      console.log(`👤 Usuario: ${userId}`);
      console.log(`🌍 Zona horaria: ${summary.timezone}`);
      console.log(
        `📅 Período: ${now.toLocaleDateString()} - ${twoWeeksFromNow.toLocaleDateString()} (14 días)`
      );
      console.log(`📊 Total de eventos: ${summary.totalEvents}`);
      console.log(`✅ Días libres: ${summary.freeDays.length}`);
      console.log(`📅 Días ocupados: ${summary.busyDays.length}`);
      console.log("");

      // Mostrar disponibilidad por día
      console.log("📋 DISPONIBILIDAD POR DÍA:");
      console.log("-".repeat(50));
      Object.keys(summary.availabilityByDay)
        .sort()
        .forEach((dayKey) => {
          const dayInfo = summary.availabilityByDay[dayKey];
          console.log(`\n📅 ${dayInfo.dayName}:`);

          if (dayInfo.isFree) {
            console.log(`   ✅ DÍA LIBRE - Disponible todo el día`);
            dayInfo.freeSlots.forEach((slot, index) => {
              console.log(
                `      ${index + 1}. ${slot.start} - ${slot.end}: ${
                  slot.description
                }`
              );
            });
          } else {
            console.log(
              `   📅 DÍA OCUPADO - ${dayInfo.totalBusyTime} minutos ocupados`
            );
            console.log(`   📋 Eventos programados:`);
            dayInfo.busySlots.forEach((slot, index) => {
              if (slot.isAllDay) {
                console.log(
                  `      ${index + 1}. 🌅 ${slot.title} (Todo el día)`
                );
              } else {
                console.log(
                  `      ${index + 1}. ⏰ ${slot.title} (${slot.start} - ${
                    slot.end
                  })`
                );
              }
            });

            if (dayInfo.freeSlots.length > 0) {
              console.log(`   ✅ Horarios disponibles:`);
              dayInfo.freeSlots.forEach((slot, index) => {
                console.log(
                  `      ${index + 1}. ${slot.start} - ${slot.end}: ${
                    slot.description
                  }`
                );
              });
            }
          }
        });

      console.log("\n📊 RESUMEN ESTADÍSTICO:");
      console.log("-".repeat(50));
      console.log(`✅ Días completamente libres: ${summary.freeDays.length}`);
      console.log(`📅 Días con eventos: ${summary.busyDays.length}`);
      console.log(
        `📊 Promedio de eventos por día: ${(summary.totalEvents / 14).toFixed(
          1
        )}`
      );

      if (summary.freeDays.length > 0) {
        console.log("\n🎯 DÍAS LIBRES:");
        summary.freeDays.forEach((dayKey) => {
          const dayInfo = summary.availabilityByDay[dayKey];
          console.log(`   ✅ ${dayInfo.dayName}`);
        });
      }

      console.log("=".repeat(80));
      console.log(
        "[Calendar][SUMMARY] ===== FIN DE RESUMEN DE DISPONIBILIDAD ====="
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
          timezone: "America/New_York",
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
          timezone: calendarSummary.timezone,
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
    userActiveCalls.set(queueItem.user_id, true);

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

      const availabilityParam = encodeURIComponent(availabilityText);

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
        )}&agent_firstname=${encodeURIComponent(
          agentFirstName
        )}&agent_name=${encodeURIComponent(
          agentName
        )}&assistant_name=${encodeURIComponent(
          userData.assistant_name
        )}&calendar_availability=${availabilityParam}`,
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
      )}&agent_firstname=${encodeURIComponent(
        agentFirstName
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
    agent_firstname,
    agent_name,
    assistant_name,
    calendar_availability,
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
          <Parameter name="agent_firstname" value="${agent_firstname}" />
          <Parameter name="agent_name" value="${agent_name}" />
          <Parameter name="assistant_name" value="${assistant_name}" />
          <Parameter name="calendar_availability" value="${
            calendar_availability || "Disponible todos los dias"
          }" />
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
      let sentAudioChunks = new Set(); // Para evitar audio duplicado
      let audioChunkCounter = 0; // Contador para limpiar el Set periódicamente

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
                agent_firstname: customParameters?.agent_firstname || "Agente",
                agent_name: customParameters?.agent_name || "Daniela",
                assistant_name:
                  customParameters?.assistant_name || "Asistente de Ventas",
                calendar_availability:
                  customParameters?.calendar_availability ||
                  "Disponible todos los dias",
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
            console.log(
              "📅 [ElevenLabs] calendar_availability value:",
              initialConfig.dynamic_variables.calendar_availability
            );
            console.log(
              "📋 [ElevenLabs] Full dynamic_variables:",
              JSON.stringify(initialConfig.dynamic_variables, null, 2)
            );
            console.log(JSON.stringify(initialConfig, null, 2));

            // Verificar que el WebSocket esté abierto antes de enviar
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify(initialConfig));

              // No enviar audio inicial vacío para evitar duplicados
            } else {
              console.error(
                "[ElevenLabs] WebSocket not ready, state:",
                elevenLabsWs.readyState
              );
            }

            elevenLabsWs.on("message", async (data) => {
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

                      // Verificar si este audio ya fue enviado
                      if (!sentAudioChunks.has(audioPayload)) {
                        sentAudioChunks.add(audioPayload);
                        audioChunkCounter++;

                        // Limpiar el Set cada 10 chunks para evitar problemas de memoria
                        if (audioChunkCounter > 10) {
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
                      } else {
                        console.log(
                          "[ElevenLabs Audio] Skipping duplicate audio chunk"
                        );
                      }
                    }
                    break;

                  case "agent_response":
                    console.log("🤖 [AGENT] Speaking");
                    break;

                  case "user_speaking":
                    const speakingDuration =
                      message.user_speaking_event?.duration || 0;
                    const shouldInterrupt =
                      message.user_speaking_event?.should_interrupt;

                    console.log(
                      `🎤 [USER] Speaking - Duration: ${speakingDuration}s, Should Interrupt: ${shouldInterrupt}`
                    );

                    // Imprimir el mensaje completo del evento
                    console.log(
                      "📋 [USER_SPEAKING] Full message:",
                      JSON.stringify(message, null, 2)
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
                    console.log(
                      "📊 [INTERRUPTION] Details:",
                      JSON.stringify(message, null, 2)
                    );
                    break;

                  case "interruption":
                    console.log(
                      "🚨 [INTERRUPTION] Interruption event received"
                    );
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
                      console.log(
                        `[ElevenLabs] Unknown event: ${message.type}`
                      );
                    }
                }
              } catch (error) {
                console.error("[ElevenLabs] Error processing message:", error);
              }
            });

            elevenLabsWs.on("error", (error) => {
              console.error("[ElevenLabs] WebSocket error:", error);

              // Limpiar chunks de audio en caso de error
              sentAudioChunks.clear();
              audioChunkCounter = 0;
              console.log("[Audio] Cleaned audio chunks on ElevenLabs error");
            });

            elevenLabsWs.on("close", async () => {
              console.log("[ElevenLabs] Disconnected");

              // Limpiar chunks de audio al desconectar ElevenLabs
              sentAudioChunks.clear();
              audioChunkCounter = 0;
              console.log(
                "[Audio] Cleaned audio chunks on ElevenLabs disconnect"
              );

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

              console.log(
                "🔍 [WebSocket] Received customParameters from Twilio:"
              );
              console.log(
                "📋 customParameters:",
                JSON.stringify(customParameters, null, 2)
              );
              console.log(
                "📅 calendar_availability:",
                customParameters?.calendar_availability
              );

              // Setup ElevenLabs AFTER receiving customParameters
              setupElevenLabs();
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioChunk = Buffer.from(
                  msg.media.payload,
                  "base64"
                ).toString("base64");

                // Verificar si este chunk de audio ya fue enviado
                if (!sentAudioChunks.has(audioChunk)) {
                  sentAudioChunks.add(audioChunk);
                  audioChunkCounter++;

                  // Limpiar el Set cada 10 chunks para evitar problemas de memoria
                  if (audioChunkCounter > 10) {
                    sentAudioChunks.clear();
                    audioChunkCounter = 0;
                    console.log("[Audio] Cleaned audio chunks cache");
                  }

                  elevenLabsWs.send(
                    JSON.stringify({
                      type: "user_audio_chunk",
                      user_audio_chunk: audioChunk,
                    })
                  );
                } else {
                  console.log("[Audio] Skipping duplicate audio chunk");
                }
              }
              break;

            case "stop":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              // Limpiar chunks de audio al finalizar la llamada
              sentAudioChunks.clear();
              audioChunkCounter = 0;
              console.log("[Audio] Cleaned audio chunks on call stop");
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
        // Limpiar chunks de audio al cerrar el WebSocket
        sentAudioChunks.clear();
        audioChunkCounter = 0;
        console.log("[Audio] Cleaned audio chunks on WebSocket close");
      });
    }
  );
});

// Function to clean up stuck calls
async function cleanupStuckCalls() {
  try {
    console.log("[CLEANUP] Starting cleanup of stuck calls...");

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
      console.log("[CLEANUP] No stuck calls found");
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
          await supabase
            .from("calls")
            .update({
              status: twilioCall.status,
              duration: twilioCall.duration || 0,
              result: twilioCall.status === "completed" ? "success" : "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("call_sid", call.call_sid);

          // Remove from global tracking
          globalActiveCalls.delete(call.call_sid);
          if (call.user_id) userActiveCalls.delete(call.user_id);
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
          // Check if call has been running too long (more than 10 minutes)
          const callStartTime = new Date(call.created_at);
          const now = new Date();
          const durationMinutes = (now - callStartTime) / (1000 * 60);

          if (durationMinutes > 10) {
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
              await supabase
                .from("calls")
                .update({
                  status: "completed",
                  duration: Math.round(durationMinutes * 60),
                  result: "failed",
                  error_code: "TIMEOUT",
                  error_message: "Call hung up due to timeout (10+ minutes)",
                  updated_at: new Date().toISOString(),
                })
                .eq("call_sid", call.call_sid);

              // Remove from global tracking
              globalActiveCalls.delete(call.call_sid);
              if (call.user_id) userActiveCalls.delete(call.user_id);
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
        if (call.user_id) userActiveCalls.delete(call.user_id);
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
  console.log("=".repeat(80));
  console.log("📞 [TWILIO STATUS] Status update received from Twilio");
  console.log("=".repeat(80));

  // Log request details
  console.log("📋 Request Headers:", request.headers);
  console.log("📋 Request Body Type:", typeof request.body);
  console.log("📋 Request Body:", request.body);

  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;
  const callErrorCode = request.body.ErrorCode;
  const callErrorMessage = request.body.ErrorMessage;

  console.log("📱 Call Details:");
  console.log(`   • Call SID: ${callSid}`);
  console.log(`   • Status: ${callStatus}`);
  console.log(`   • Duration: ${callDuration} seconds`);
  console.log(`   • Error Code: ${callErrorCode || "None"}`);
  console.log(`   • Error Message: ${callErrorMessage || "None"}`);
  console.log("=".repeat(80));

  try {
    // Get call info from global tracking
    const callInfo = globalActiveCalls.get(callSid);
    console.log("[Twilio] Global call info:", callInfo);

    // First, let's check if the call exists in the database
    console.log("[Twilio] Checking if call exists in database...");
    const { data: existingCall, error: checkError } = await supabase
      .from("calls")
      .select("*")
      .eq("call_sid", callSid)
      .single();

    if (checkError) {
      console.error("[Twilio] Error checking existing call:", checkError);
      console.log("[Twilio] Call SID being searched:", callSid);
      // Let's also check what calls exist in the database
      const { data: allCalls, error: allCallsError } = await supabase
        .from("calls")
        .select("call_sid, status, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      if (!allCallsError) {
        console.log("[Twilio] Recent calls in database:", allCalls);
      } else {
        console.error("[Twilio] Error fetching recent calls:", allCallsError);
      }
      // Return 200 OK even if call not found to avoid Twilio errors
      return reply.code(200).send();
    } else {
      console.log("[Twilio] Existing call found:", existingCall);
    }

    // Determine the result based on Twilio status
    let result = "initiated";
    if (callStatus === "completed" && callDuration > 0) {
      result = "success";
    } else if (
      ["failed", "busy", "no-answer", "canceled"].includes(callStatus)
    ) {
      result = "failed";
    }

    // Update call status in database
    const updateData = {
      status: callStatus,
      duration: callDuration || 0,
      result: result,
      updated_at: new Date().toISOString(),
    };

    // Add error information if available
    if (callErrorCode || callErrorMessage) {
      updateData.error_code = callErrorCode;
      updateData.error_message = callErrorMessage;
    }

    await supabase.from("calls").update(updateData).eq("call_sid", callSid);

    // Remove from global tracking
    globalActiveCalls.delete(callSid);
    if (existingCall && existingCall.user_id)
      userActiveCalls.delete(existingCall.user_id);
    activeCalls--;

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
    console.log("=".repeat(80));
    console.log("🔔 [ELEVENLABS WEBHOOK] Post-call webhook received");
    console.log("=".repeat(80));

    console.log("📋 Webhook Headers:", request.headers);
    console.log("📄 Request Body:", request.body);

    const webhookData = request.body;
    console.log("📊 Webhook Data Structure:", {
      hasWebhookData: !!webhookData,
      hasData: !!webhookData?.data,
      hasConversationId: !!webhookData?.data?.conversation_id,
      webhookDataKeys: webhookData ? Object.keys(webhookData) : [],
      dataKeys: webhookData?.data ? Object.keys(webhookData.data) : [],
    });

    // Check for ElevenLabs specific structure
    if (
      !webhookData ||
      !webhookData.data ||
      !webhookData.data.conversation_id
    ) {
      console.error("❌ Invalid webhook data structure");
      console.log("📊 Received data:", JSON.stringify(webhookData, null, 2));
      return reply.code(400).send({ error: "Invalid webhook data" });
    }

    const { conversation_id, analysis, transcript, metadata } =
      webhookData.data;

    console.log("🔍 Processing webhook for conversation:", conversation_id);
    console.log(
      "📊 Analysis data:",
      analysis ? Object.keys(analysis) : "No analysis"
    );
    console.log(
      "📊 Transcript length:",
      transcript ? transcript.length : "No transcript"
    );
    console.log(
      "📊 Metadata:",
      metadata ? Object.keys(metadata) : "No metadata"
    );

    // Find the call by conversation_id
    const { data: call, error: callError } = await supabase
      .from("calls")
      .select("*")
      .eq("conversation_id", conversation_id)
      .single();

    if (callError || !call) {
      console.error("❌ Call not found for conversation:", conversation_id);
      console.log(
        "🔍 Searching for calls with conversation_id:",
        conversation_id
      );

      // Let's check what calls exist in the database
      const { data: allCalls, error: allCallsError } = await supabase
        .from("calls")
        .select("call_sid, conversation_id, created_at")
        .order("created_at", { ascending: false })
        .limit(10);

      if (!allCallsError) {
        console.log("📋 Recent calls in database:", allCalls);
      } else {
        console.error("❌ Error fetching recent calls:", allCallsError);
      }

      return reply.code(404).send({ error: "Call not found" });
    }

    console.log("✅ Found call:", call.call_sid);

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

    console.log("📝 Updating call with data:", updateData);

    const { error: updateError } = await supabase
      .from("calls")
      .update(updateData)
      .eq("conversation_id", conversation_id);

    if (updateError) {
      console.error("❌ Error updating call:", updateError);
      return reply.code(500).send({ error: "Failed to update call" });
    }

    console.log("✅ Call updated successfully");

    // 🔍 ANALYZE CALL WITH OPENAI
    console.log("🤖 [OPENAI] Starting call analysis...");
    try {
      const openAIAnalysis = await analyzeCallWithOpenAI(webhookData, call);

      if (openAIAnalysis) {
        console.log("✅ [OPENAI] Analysis completed successfully");

        // Update call with OpenAI analysis
        const { error: openAIUpdateError } = await supabase
          .from("calls")
          .update({
            openai_analysis: openAIAnalysis,
            updated_at: new Date().toISOString(),
          })
          .eq("conversation_id", conversation_id);

        if (openAIUpdateError) {
          console.error(
            "❌ Error updating call with OpenAI analysis:",
            openAIUpdateError
          );
        } else {
          console.log("✅ Call updated with OpenAI analysis");
        }
      }
    } catch (openAIError) {
      console.error("❌ Error analyzing call with OpenAI:", openAIError);
    }

    console.log("=".repeat(80));

    reply.send({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("❌ Error processing webhook:", error);
    reply.code(500).send({ error: "Internal server error" });
  }
});

// Function to analyze call with OpenAI
async function analyzeCallWithOpenAI(webhookData, call) {
  try {
    console.log("🤖 [OPENAI] Preparing analysis request...");

    const { conversation_id, analysis, transcript, metadata } =
      webhookData.data;

    // Prepare the conversation transcript for analysis
    let fullTranscript = "";
    if (transcript && transcript.length > 0) {
      fullTranscript = transcript
        .map((turn) => {
          const speaker = turn.speaker === "user" ? "Cliente" : "Agente";
          const text = turn.text || "";
          return `${speaker}: ${text}`;
        })
        .join("\n");
    }

    // Prepare analysis prompt
    const analysisPrompt = `
Analiza la siguiente conversación de ventas inmobiliarias y proporciona un análisis detallado:

CONVERSACIÓN:
${fullTranscript}

METADATOS DE LA LLAMADA:
- Duración: ${metadata?.call_duration_secs || 0} segundos
- Turnos de conversación: ${transcript?.length || 0}
- Éxito de la llamada: ${analysis?.call_successful ? "Sí" : "No"}

Por favor proporciona un análisis estructurado que incluya:

1. RESUMEN EJECUTIVO (2-3 oraciones)
2. PUNTOS CLAVE DE LA CONVERSACIÓN
3. INTERÉS DEL CLIENTE (Alto/Medio/Bajo)
4. OBJECIONES IDENTIFICADAS
5. SIGUIENTES PASOS RECOMENDADOS
6. CALIFICACIÓN DE LA OPORTUNIDAD (1-10)
7. OBSERVACIONES ADICIONALES

Responde en formato JSON con la siguiente estructura:
{
  "resumen_ejecutivo": "string",
  "puntos_clave": ["string"],
  "interes_cliente": "Alto/Medio/Bajo",
  "objeciones": ["string"],
  "siguientes_pasos": ["string"],
  "calificacion_oportunidad": number,
  "observaciones": "string"
}
`;

    // Call OpenAI API
    const openAIResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Eres un analista experto en ventas inmobiliarias. Analiza conversaciones de ventas y proporciona insights valiosos en formato JSON.",
            },
            {
              role: "user",
              content: analysisPrompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      }
    );

    if (!openAIResponse.ok) {
      throw new Error(
        `OpenAI API error: ${openAIResponse.status} ${openAIResponse.statusText}`
      );
    }

    const openAIData = await openAIResponse.json();
    const analysisContent = openAIData.choices[0]?.message?.content;

    if (!analysisContent) {
      throw new Error("No analysis content received from OpenAI");
    }

    // Log the complete OpenAI response for debugging
    console.log("🤖 [OPENAI] Complete response from OpenAI:");
    console.log("📄 Raw analysis content:");
    console.log(analysisContent);
    console.log("📊 Response structure:", {
      model: openAIData.model,
      usage: openAIData.usage,
      finish_reason: openAIData.choices[0]?.finish_reason,
    });

    // Try to parse JSON response
    try {
      let jsonContent = analysisContent;

      // Check if response is wrapped in markdown code blocks
      if (analysisContent.includes("```json")) {
        console.log(
          "🔍 [OPENAI] Detected markdown code block, extracting JSON..."
        );
        const jsonMatch = analysisContent.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
          jsonContent = jsonMatch[1].trim();
          console.log(
            "✅ [OPENAI] Successfully extracted JSON from markdown block"
          );
        } else {
          console.warn(
            "⚠️ [OPENAI] Could not extract JSON from markdown block"
          );
        }
      }

      const parsedAnalysis = JSON.parse(jsonContent);
      console.log("✅ [OPENAI] Analysis parsed successfully:", {
        resumen_ejecutivo:
          parsedAnalysis.resumen_ejecutivo?.substring(0, 100) + "...",
        interes_cliente: parsedAnalysis.interes_cliente,
        calificacion_oportunidad: parsedAnalysis.calificacion_oportunidad,
      });
      return parsedAnalysis;
    } catch (parseError) {
      console.warn(
        "⚠️ [OPENAI] Could not parse JSON response, returning raw text"
      );
      console.error("❌ [OPENAI] JSON Parse Error:", parseError.message);
      console.log("🔍 [OPENAI] Attempted to parse this content:");
      console.log(analysisContent);
      return {
        raw_analysis: analysisContent,
        parse_error: parseError.message,
      };
    }
  } catch (error) {
    console.error("❌ [OPENAI] Error in analysis:", error);
    throw error;
  }
}

// Add test endpoint for webhook debugging
fastify.get("/webhook/elevenlabs/test", async (request, reply) => {
  console.log("🧪 [WEBHOOK TEST] Test endpoint accessed");
  return reply.send({
    status: "ok",
    message: "Webhook endpoint is accessible",
    timestamp: new Date().toISOString(),
    server: "code-production",
  });
});

// Add POST test endpoint for webhook debugging
fastify.post("/webhook/elevenlabs/test", async (request, reply) => {
  console.log("🧪 [WEBHOOK TEST] POST test endpoint accessed");
  console.log("📋 Headers:", request.headers);
  console.log("📄 Body:", request.body);
  return reply.send({
    status: "ok",
    message: "Webhook POST endpoint is accessible",
    received_data: request.body,
    timestamp: new Date().toISOString(),
    server: "code-production",
  });
});

// Start the server
const start = async () => {
  try {
    console.log("🚀 Starting server...");
    console.log("📊 Queue Configuration:", QUEUE_CONFIG);
    console.log("🔧 Environment Check:");
    console.log(
      `   • ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY ? "✅ Set" : "❌ Missing"}`
    );
    console.log(
      `   • ELEVENLABS_AGENT_ID: ${
        ELEVENLABS_AGENT_ID ? "✅ Set" : "❌ Missing"
      }`
    );
    console.log(
      `   • TWILIO_ACCOUNT_SID: ${TWILIO_ACCOUNT_SID ? "✅ Set" : "❌ Missing"}`
    );
    console.log(
      `   • RAILWAY_PUBLIC_DOMAIN: ${
        RAILWAY_PUBLIC_DOMAIN ? "✅ Set" : "❌ Missing"
      }`
    );
    console.log(
      `   • OPENAI_API_KEY: ${OPENAI_API_KEY ? "✅ Set" : "❌ Missing"}`
    );

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`✅ Server running on port ${PORT}`);
    console.log("🔄 Queue processing interval set to:", QUEUE_INTERVAL, "ms");
    console.log("🧹 Cleanup interval set to:", CLEANUP_INTERVAL, "ms");
  } catch (err) {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  }
};

start();
