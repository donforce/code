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

// Optimized queue processing with minimal logging
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
      console.error("[Queue] ❌ Error fetching pending queues:", error);
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
      console.error("[Queue] ❌ Error fetching users data:", usersError);
      return;
    }

    // Create optimized user lookup map
    const usersMap = new Map(usersData?.map((user) => [user.id, user]) || []);

    // Filter eligible items efficiently
    const eligibleItems = [];
    const processedUsers = new Set();

    for (const item of pendingQueues) {
      const user = usersMap.get(item.user_id);

      if (!user || user.available_minutes <= 0) {
        continue;
      }
      if (userActiveCalls.has(item.user_id)) {
        continue;
      }
      if (processedUsers.has(item.user_id)) {
        continue;
      }

      eligibleItems.push(item);
      processedUsers.add(item.user_id);
    }

    if (eligibleItems.length === 0) {
      return;
    }

    // Process items concurrently with optimized batch size
    const itemsToProcess = eligibleItems.slice(
      0,
      QUEUE_CONFIG.maxConcurrentCalls - globalActiveCalls.size
    );

    // Process items concurrently without waiting for all to complete
    itemsToProcess.forEach(async (item) => {
      processQueueItemWithRetry(item).catch((error) => {
        console.error(`[Queue] ❌ Error processing item ${item.id}:`, error);
      });
    });
  } catch (error) {
    console.error("[Queue] ❌ Error in queue processing:", error);
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
      const timezoneParam = encodeURIComponent(calendarTimezone);
      const clientPhoneParam = encodeURIComponent(queueItem.lead.phone);
      const clientEmailParam = encodeURIComponent(queueItem.lead.email);

      call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
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
        )}&calendar_availability=${availabilityParam}&calendar_timezone=${timezoneParam}`,
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
    calendar_timezone,
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
          <Parameter name="calendar_timezone" value="${
            calendar_timezone || "America/New_York"
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
                calendar_timezone:
                  customParameters?.calendar_timezone || "America/New_York",
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
              "🌍 [ElevenLabs] calendar_timezone value:",
              initialConfig.dynamic_variables.calendar_timezone
            );
            console.log(
              "📞 [ElevenLabs] client_phone value:",
              initialConfig.dynamic_variables.client_phone
            );
            console.log(
              "📧 [ElevenLabs] client_email value:",
              initialConfig.dynamic_variables.client_email
            );
            console.log(
              "📋 [ElevenLabs] Full dynamic_variables:",
              JSON.stringify(initialConfig.dynamic_variables, null, 2)
            );
            console.log(JSON.stringify(initialConfig, null, 2));

            // Log the first message that will be spoken
            if (customParameters?.first_message) {
              console.log(
                "🎯 [AGENT] First message to be spoken:",
                customParameters.first_message
              );
            }

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
                      } else {
                        console.log(
                          "[ElevenLabs Audio] Skipping duplicate audio chunk"
                        );
                      }
                    }
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
                    break;

                  case "interruption":
                    console.log(
                      "🚨 [INTERRUPTION] Interruption event received"
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

                    // Log user transcript in real-time
                    if (transcript) {
                      console.log("🎤 [USER] Said:", transcript);
                    }

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

                  // Limpiar el Set cada 100 chunks para evitar problemas de memoria
                  if (audioChunkCounter > 100) {
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

    reply.send({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("❌ Error processing webhook:", error);
    reply.code(500).send({ error: "Internal server error" });
  }
});

// Function to analyze call with OpenAI
// Comentado: Definición de analyzeCallWithOpenAI
// async function analyzeCallWithOpenAI(webhookData, call) {
//   ...
// }

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
      const cleanPhone = phone.replace(/[\s\-\(\)]/g, "");
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
            // Buscar lead existente por external_id o email
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

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log("✅ Server running");
  } catch (err) {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  }
};

start();

// Function to check for scheduled call in ElevenLabs summary
async function checkForScheduledCall(webhookData, call) {
  try {
    console.log(
      "🔍 [CALENDAR] ===== INICIO DE BÚSQUEDA DE LLAMADA PROGRAMADA ====="
    );
    console.log("📞 [CALENDAR] Call SID:", call.call_sid);
    console.log("👤 [CALENDAR] User ID:", call.user_id);
    console.log("📋 [CALENDAR] Lead ID:", call.lead_id);

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

    // Check if summary contains scheduling keywords
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
        "❌ [CALENDAR] No scheduling keywords found - skipping calendar check"
      );
      return null;
    }

    console.log(
      "✅ [CALENDAR] Scheduling keywords detected - proceeding with date/time extraction"
    );

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
      title: "Llamada programada",
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

    // Crear la fecha en UTC como base neutral
    const eventDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const endDate = new Date(eventDate.getTime() + 30 * 60 * 1000); // 30 minutos

    // Formatear fechas en formato ISO ajustado a la zona horaria del usuario
    const formatDateForGoogleCalendar = (date, timezone) => {
      try {
        const options = {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: timezone,
        };

        const formatter = new Intl.DateTimeFormat("en-CA", options);
        const parts = formatter.formatToParts(date);

        const get = (type) => parts.find((p) => p.type === type)?.value;

        const formatted = `${get("year")}-${get("month")}-${get("day")}T${get(
          "hour"
        )}:${get("minute")}:00`;
        return formatted;
      } catch (error) {
        console.error("❌ [CALENDAR] Error formatting date:", error);
        return date.toISOString().replace(/\.\d{3}Z$/, "");
      }
    };

    const startDateTime = formatDateForGoogleCalendar(eventDate, userTimeZone);
    const endDateTime = formatDateForGoogleCalendar(endDate, userTimeZone);

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
      description: `${scheduledCallInfo.description}\n\nCliente: ${scheduledCallInfo.lead.name}\nTeléfono: ${scheduledCallInfo.lead.phone}\nEmail: ${scheduledCallInfo.lead.email}\n\nResumen de la conversación: ${scheduledCallInfo.summary}`,
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
