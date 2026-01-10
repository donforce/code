import crypto from "crypto";

// Función para enviar datos a webhooks de forma asíncrona
async function sendWebhookData(supabase, callData, leadData, userData) {
  try {
    // Obtener todas las integraciones webhook activas del usuario (excluyendo Meta Events)
    const { data: integrations, error } = await supabase
      .from("webhook_integrations")
      .select("*")
      .eq("user_id", userData.id)
      .eq("is_active", true)
      .eq("include_meta_events", false) // Solo webhooks que NO sean de Meta Events
      .order("order_index", { ascending: true });

    if (error) {
      console.error("[WEBHOOK] Error fetching integrations:", error);
      return;
    }

    if (!integrations || integrations.length === 0) {
      console.log(
        "[WEBHOOK] No active webhook integrations found (excluding Meta Events)"
      );
      return;
    }

    // Preparar el payload de datos para webhooks
    const webhookPayload = {
      call: {
        id: callData.id,
        call_sid: callData.call_sid,
        status: callData.status,
        duration: callData.duration,
        result: callData.detailed_result || callData.result,
        connection_status: callData.connection_status,
        connection_failure_reason: callData.connection_failure_reason,
        created_at: callData.created_at,
        updated_at: callData.updated_at,
        error_code: callData.error_code,
        error_message: callData.error_message,
        transcript_summary_es: callData.transcript_summary_es, // 🆕 Resumen de IA en español
        recording_sid: callData.recording_sid || null, // 🆕 SID de la grabación
        // 🆕 Información de cita agendada (si existe)
        appointment:
          callData.appointment_datetime ||
          callData.appointment_date ||
          callData.appointment_time
            ? {
                date: callData.appointment_date || null,
                time: callData.appointment_time || null,
                datetime: callData.appointment_datetime || null,
              }
            : null,
      },
      lead: {
        id: leadData.id,
        name: leadData.name,
        email: leadData.email,
        phone: leadData.phone,
        company: leadData.company,
        position: leadData.position,
        source: leadData.source,
        status: leadData.status,
        notes: leadData.notes,
        created_at: leadData.created_at,
        updated_at: leadData.updated_at,
      },
      user: {
        id: userData.id,
        email: userData.email,
        full_name: userData.full_name,
      },
      event_type: "call_completed",
      timestamp: new Date().toISOString(),
    };

    // 🆕 FUNCIÓN PARA LOGGING ASÍNCRONO DE WEBHOOKS
    const logWebhookCall = async (
      integration,
      response,
      error,
      executionTime
    ) => {
      try {
        const logData = {
          user_id: userData.id,
          webhook_integration_id: integration.id,
          webhook_name: integration.name,
          webhook_url: integration.webhook_url,
          call_id: callData.id,
          call_sid: callData.call_sid,
          lead_id: leadData.id,
          request_payload: webhookPayload,
          execution_time_ms: executionTime,
          created_at: new Date().toISOString(),
        };

        if (error) {
          logData.error_message = error.message || error.toString();
          logData.response_status = null;
          logData.response_body = null;
          logData.response_headers = null;
        } else if (response) {
          logData.response_status = response.status;
          logData.response_body = response.body || null;
          logData.response_headers = response.headers || null;
          logData.error_message = null;
        }

        // 🆕 INSERTAR LOG DE FORMA ASÍNCRONA (no esperar respuesta)
        setImmediate(async () => {
          try {
            const { error: logError } = await supabase
              .from("webhook_logs")
              .insert(logData);

            if (logError) {
              console.error(
                `[WEBHOOK LOG] Error saving log for ${integration.name}:`,
                logError
              );
            } else {
              console.log(
                `[WEBHOOK LOG] Log saved for ${integration.name} - Status: ${
                  logData.response_status || "ERROR"
                }`
              );
            }
          } catch (logErr) {
            console.error(
              `[WEBHOOK LOG] Exception saving log for ${integration.name}:`,
              logErr
            );
          }
        });
      } catch (logErr) {
        console.error(
          `[WEBHOOK LOG] Error preparing log for ${integration.name}:`,
          logErr
        );
      }
    };

    // Enviar a cada webhook de forma asíncrona
    const webhookPromises = integrations.map(async (integration) => {
      const startTime = Date.now();
      let response = null;
      let error = null;

      try {
        console.log(
          `[WEBHOOK] Sending to ${integration.name}: ${integration.webhook_url}`
        );

        // Preparar headers
        const headers = {
          "Content-Type": integration.content_type || "application/json",
          "User-Agent": "Clear-CRM-Webhook/1.0",
        };

        // Agregar autenticación si está configurada
        if (integration.auth_type !== "none") {
          if (
            integration.auth_type === "basic" &&
            integration.auth_username &&
            integration.auth_password
          ) {
            const auth = Buffer.from(
              `${integration.auth_username}:${integration.auth_password}`
            ).toString("base64");
            headers["Authorization"] = `Basic ${auth}`;
          } else if (
            integration.auth_type === "bearer" &&
            integration.auth_token
          ) {
            headers["Authorization"] = `Bearer ${integration.auth_token}`;
          } else if (
            integration.auth_type === "api_key" &&
            integration.auth_token
          ) {
            headers[integration.auth_header_name || "X-API-Key"] =
              integration.auth_token;
          }
        }

        // Enviar request con timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos timeout

        response = await fetch(integration.webhook_url, {
          method: "POST",
          headers,
          body: JSON.stringify(webhookPayload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseBody = await response.text();

        console.log(
          `[WEBHOOK] Response from ${integration.name}: ${
            response.status
          } - ${responseBody.substring(0, 100)}...`
        );

        // 🆕 LOGGING ASÍNCRONO - No esperar respuesta
        const executionTime = Date.now() - startTime;
        await logWebhookCall(
          integration,
          {
            status: response.status,
            body: responseBody,
            headers: Object.fromEntries(response.headers.entries()),
          },
          null,
          executionTime
        );
      } catch (err) {
        error = err;
        const executionTime = Date.now() - startTime;

        console.error(
          `[WEBHOOK] Error sending to ${integration.name}:`,
          err.message
        );

        // 🆕 LOGGING ASÍNCRONO DEL ERROR - No esperar respuesta
        await logWebhookCall(integration, null, err, executionTime);
      }
    });

    // 🆕 EJECUTAR TODOS LOS WEBHOOKS EN PARALELO SIN ESPERAR RESPUESTAS
    Promise.allSettled(webhookPromises).then((results) => {
      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      console.log(
        `[WEBHOOK] Completed: ${successful} successful, ${failed} failed webhook calls`
      );
    });
  } catch (error) {
    console.error("[WEBHOOK] Error in sendWebhookData:", error);
  }
}

// Función para enviar eventos a Meta/Facebook de forma asíncrona
async function sendMetaEvents(supabase, callData, leadData, userData) {
  try {
    // Obtener integraciones con Meta Events activas
    const { data: integrations, error } = await supabase
      .from("webhook_integrations")
      .select("*")
      .eq("user_id", userData.id)
      .eq("is_active", true)
      .eq("include_meta_events", true)
      .not("meta_access_token", "is", null)
      .not("meta_pixel_id", "is", null);

    if (error) {
      console.error("[META] Error fetching Meta integrations:", error);
      return;
    }

    if (!integrations || integrations.length === 0) {
      console.log(
        "[META] No active Meta integrations found for user:",
        userData.id
      );
      console.log(
        "[META] To enable Meta events, create an integration with include_meta_events=true"
      );
      return;
    }

    console.log(
      `[META] Found ${integrations.length} active Meta integration(s) for user ${userData.id}`
    );

    // Determinar el evento y valor basado en detailed_result para optimización de campañas
    // Usar detailed_result si está disponible, sino usar result
    const detailedResult =
      callData.detailed_result || callData.result || "unknown";

    let eventName = "Lead"; // Por defecto
    let eventValue = 0; // Valor del evento para optimización
    let shouldSendEvent = true; // Si debemos enviar el evento

    // Mapear detailed_result a eventos de Meta para mejor optimización
    // Usando eventos estándar recomendados por Meta para optimización de campañas
    switch (detailedResult) {
      case "Cita Agendada":
        // Schedule es el evento perfecto para citas agendadas (Booking/Appointment)
        eventName = "Schedule";
        eventValue = 100; // Alto valor - conversión principal
        break;

      case "Cliente Interesado":
        // CompleteRegistration indica que el cliente completó un paso importante (mostró interés)
        eventName = "CompleteRegistration";
        eventValue = 50; // Valor medio-alto - lead calificado
        break;

      case "Cliente con Objeciones":
        // Lead estándar para leads con potencial pero que necesitan seguimiento
        eventName = "Lead";
        eventValue = 25; // Valor bajo-medio
        break;

      case "Conversación Exitosa":
        // Contact es para contacto efectivo entre cliente y negocio
        eventName = "Contact";
        eventValue = 30; // Valor medio
        break;

      case "Cliente No Interesado":
      case "Buzón de Voz":
      case "No Contestó":
      case "Sin Respuesta":
      case "Llamada Cortada":
      case "Línea Ocupada":
      case "Teléfono Inválido":
      case "Conversación Falló":
        // No enviar eventos de baja calidad para no contaminar la optimización
        shouldSendEvent = false;
        console.log(
          `[META] Skipping event for low-quality result: ${detailedResult}`
        );
        break;

      default:
        // Para otros casos (success básico, etc.), enviar Lead estándar
        eventName = "Lead";
        eventValue = 10; // Valor bajo - lead básico
        break;
    }

    // Si no debemos enviar el evento, salir temprano
    if (!shouldSendEvent) {
      console.log(
        `[META] Not sending event for result: ${detailedResult} (low quality)`
      );
      return;
    }

    console.log(
      `[META] Event mapping - Result: "${detailedResult}" → Event: "${eventName}" (Value: ${eventValue})`
    );

    // Preparar el payload de Meta Events
    // Validar que event_time no esté en el futuro (Meta rechaza eventos > 7 días en el futuro o > 1 hora en el pasado)
    const currentTime = Math.floor(Date.now() / 1000);
    const maxPastTime = currentTime - 1 * 60 * 60; // Máximo 1 hora en el pasado
    const maxFutureTime = currentTime + 7 * 24 * 60 * 60; // Máximo 7 días en el futuro

    // Usar el tiempo actual si el timestamp está fuera del rango válido
    // Meta acepta eventos hasta 7 días en el futuro o 1 hora en el pasado
    let validEventTime = currentTime;

    // Si callData tiene created_at, intentar usarlo (pero validado)
    if (callData.created_at) {
      const callTime = Math.floor(
        new Date(callData.created_at).getTime() / 1000
      );
      if (callTime >= maxPastTime && callTime <= maxFutureTime) {
        validEventTime = callTime;
      } else {
        console.warn(
          `[META] Call timestamp ${callTime} out of valid range (${maxPastTime} - ${maxFutureTime}), using current time ${currentTime}`
        );
      }
    }

    // Construir user_data y limpiar campos undefined (Meta rechaza campos undefined)
    const userDataPayload = {};

    // Datos básicos (hasheados)
    if (leadData.email) {
      userDataPayload.em = hashEmail(leadData.email);
    }
    if (leadData.phone) {
      userDataPayload.ph = hashPhone(leadData.phone);
    }

    // Nombre y apellido (hash) - +15% calidad cada uno
    // first_name viene del campo 'name' en la BD
    if (leadData.name) {
      userDataPayload.fn = hashEmail(leadData.name.split(" ")[0]); // Primera palabra del nombre
    }
    if (leadData.last_name) {
      userDataPayload.ln = hashEmail(leadData.last_name);
    }

    // Identificador externo: ID de la BD del lead (sin hash) - +28% calidad
    userDataPayload.external_id = leadData.id; // UUID del lead en nuestra BD

    // event_id es el ID de la llamada
    const callEventId = callData.id || callData.call_sid;

    const metaPayload = {
      data: [
        {
          event_name: eventName,
          event_time: validEventTime, // Timestamp en formato Unix (validado)
          event_id: callEventId, // ID de la llamada
          action_source: "phone_call",
          event_source_url: "https://orquest-ai.com/", // URL requerida para algunos eventos
          user_data: userDataPayload,
          custom_data: {
            // Valor del evento para optimización de campañas
            value: eventValue,
            currency: "USD", // O configurable por usuario

            // Información del lead
            lead_event_source: "OAI",
            event_source: "Orquesta",
            lead_id: leadData.id,

            // Métricas de la llamada
            call_duration: callData.duration || 0,
            call_result: callData.result || "unknown",
            detailed_result: detailedResult, // Resultado detallado para análisis
            call_status: callData.status || "unknown",

            // Calidad del lead (para análisis avanzado)
            lead_quality:
              detailedResult === "Cita Agendada"
                ? "high"
                : detailedResult === "Cliente Interesado"
                ? "medium-high"
                : detailedResult === "Cliente con Objeciones"
                ? "medium"
                : detailedResult === "Conversación Exitosa"
                ? "medium-low"
                : "low",
          },
        },
      ],
    };

    // Logging detallado del payload completo antes de enviarlo
    console.log(
      `[META] 📤 Sending event payload for call ${
        callData.call_sid || callData.id
      }:`,
      {
        event_name: eventName,
        event_time: validEventTime,
        event_time_readable: new Date(validEventTime * 1000).toISOString(),
        event_id: callEventId,
        user_data: userDataPayload,
        user_data_keys: Object.keys(userDataPayload),
        lead_data: {
          id: leadData.id,
          name: leadData.name,
          last_name: leadData.last_name || "N/A",
          email: leadData.email ? "***" : "N/A",
          phone: leadData.phone ? "***" : "N/A",
        },
        custom_data_value: eventValue,
        detailed_result: detailedResult,
      }
    );

    // 🆕 FUNCIÓN PARA LOGGING ASÍNCRONO DE META EVENTS
    const logMetaEvent = async (
      integration,
      response,
      error,
      executionTime
    ) => {
      try {
        const logData = {
          user_id: userData.id,
          webhook_integration_id: integration.id,
          webhook_name: `${integration.name} (Meta Pixel)`,
          webhook_url: `https://graph.facebook.com/v20.0/${integration.meta_pixel_id}/events`,
          call_id: callData.id,
          call_sid: callData.call_sid,
          lead_id: leadData.id,
          request_payload: metaPayload,
          execution_time_ms: executionTime,
          created_at: new Date().toISOString(),
        };

        if (error) {
          logData.error_message = error.message || error.toString();
          logData.response_status = null;
          logData.response_body = null;
          logData.response_headers = null;
        } else if (response) {
          logData.response_status = response.status;
          logData.response_body = response.body || null;
          logData.response_headers = response.headers || null;
          logData.error_message = null;
        }

        // 🆕 INSERTAR LOG DE FORMA ASÍNCRONA (no esperar respuesta)
        setImmediate(async () => {
          try {
            const { error: logError } = await supabase
              .from("webhook_logs")
              .insert(logData);

            if (logError) {
              console.error(
                `[META LOG] Error saving log for ${integration.name}:`,
                logError
              );
            } else {
              console.log(
                `[META LOG] Log saved for ${integration.name} - Status: ${
                  logData.response_status || "ERROR"
                }`
              );
            }
          } catch (logErr) {
            console.error(
              `[META LOG] Exception saving log for ${integration.name}:`,
              logErr
            );
          }
        });
      } catch (logErr) {
        console.error(
          `[META LOG] Error preparing log for ${integration.name}:`,
          logErr
        );
      }
    };

    // Enviar a cada integración de Meta de forma asíncrona
    const metaPromises = integrations.map(async (integration) => {
      const startTime = Date.now();
      let response = null;
      let error = null;

      try {
        console.log(
          `[META] 📤 Sending event to pixel ${integration.meta_pixel_id} for integration: ${integration.name}`
        );
        console.log(
          `[META] Integration ID: ${integration.id}, User ID: ${userData.id}`
        );
        console.log(
          `[META] 📋 Full payload being sent:`,
          JSON.stringify(metaPayload, null, 2)
        );

        const metaUrl = `https://graph.facebook.com/v20.0/${integration.meta_pixel_id}/events?access_token=${integration.meta_access_token}`;

        // Enviar request con timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos timeout

        response = await fetch(metaUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(metaPayload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseBody = await response.text();

        if (response.ok) {
          const result = JSON.parse(responseBody);
          console.log(
            `[META] ✅ Successfully sent event to pixel ${integration.meta_pixel_id}:`,
            result
          );
          console.log(`[META] 📊 Event details:`, {
            event_name: eventName,
            events_received: result.events_received,
            fbtrace_id: result.fbtrace_id,
            pixel_id: integration.meta_pixel_id,
            note: "Events may take a few minutes to appear in Meta Events Manager",
          });

          // 🆕 LOGGING ASÍNCRONO - No esperar respuesta
          const executionTime = Date.now() - startTime;
          await logMetaEvent(
            integration,
            {
              status: response.status,
              body: responseBody,
              headers: Object.fromEntries(response.headers.entries()),
            },
            null,
            executionTime
          );
        } else {
          // Intentar parsear el error de Meta para mejor debugging
          let errorDetails = responseBody;
          try {
            const errorJson = JSON.parse(responseBody);
            errorDetails = JSON.stringify(errorJson, null, 2);
            console.error(
              `[META] Failed to send event to pixel ${integration.meta_pixel_id}: ${response.status} ${response.statusText}`,
              errorDetails
            );
          } catch (e) {
            console.error(
              `[META] Failed to send event to pixel ${integration.meta_pixel_id}: ${response.status} ${response.statusText}`,
              responseBody
            );
          }

          // 🆕 LOGGING ASÍNCRONO DEL ERROR - No esperar respuesta
          const executionTime = Date.now() - startTime;
          await logMetaEvent(
            integration,
            {
              status: response.status,
              body: responseBody,
              headers: Object.fromEntries(response.headers.entries()),
            },
            null,
            executionTime
          );
        }
      } catch (err) {
        error = err;
        const executionTime = Date.now() - startTime;

        console.error(
          `[META] Error sending event to pixel ${integration.meta_pixel_id}:`,
          err.message
        );

        // 🆕 LOGGING ASÍNCRONO DEL ERROR - No esperar respuesta
        await logMetaEvent(integration, null, err, executionTime);
      }
    });

    // 🆕 EJECUTAR TODOS LOS META EVENTS EN PARALELO SIN ESPERAR RESPUESTAS
    Promise.allSettled(metaPromises).then((results) => {
      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      console.log(
        `[META] Completed: ${successful} successful, ${failed} failed Meta events`
      );
    });
  } catch (error) {
    console.error("[META] Error in sendMetaEvents:", error);
  }
}

// Función auxiliar para hashear email
function hashEmail(email) {
  return crypto
    .createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex");
}

// Función auxiliar para hashear teléfono
function hashPhone(phone) {
  // Remover todos los caracteres no numéricos
  const cleanPhone = phone.replace(/\D/g, "");
  return crypto.createHash("sha256").update(cleanPhone).digest("hex");
}

// Función principal para enviar datos de forma asíncrona después de completar una llamada
async function sendCallCompletionData(supabase, callSid) {
  try {
    console.log(`[WEBHOOK/META] Starting async data send for call ${callSid}`);

    // Obtener datos de la llamada
    const { data: callData, error: callError } = await supabase
      .from("calls")
      .select("*")
      .eq("call_sid", callSid)
      .single();

    if (callError || !callData) {
      console.error("[WEBHOOK/META] Error fetching call data:", callError);
      return;
    }

    // Obtener datos del lead
    const { data: leadData, error: leadError } = await supabase
      .from("leads")
      .select("*")
      .eq("id", callData.lead_id)
      .single();

    if (leadError || !leadData) {
      console.error("[WEBHOOK/META] Error fetching lead data:", leadError);
      return;
    }

    // Obtener datos del usuario
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", callData.user_id)
      .single();

    if (userError || !userData) {
      console.error("[WEBHOOK/META] Error fetching user data:", userError);
      return;
    }

    // Enviar datos de forma asíncrona (no esperar respuesta)
    setImmediate(async () => {
      try {
        // Enviar a webhooks
        await sendWebhookData(supabase, callData, leadData, userData);

        // Enviar a Meta Events
        await sendMetaEvents(supabase, callData, leadData, userData);

        console.log(
          `[WEBHOOK/META] Completed async data send for call ${callSid}`
        );
      } catch (error) {
        console.error(
          `[WEBHOOK/META] Error in async data send for call ${callSid}:`,
          error
        );
      }
    });
  } catch (error) {
    console.error(
      `[WEBHOOK/META] Error in sendCallCompletionData for call ${callSid}:`,
      error
    );
  }
}

export {
  sendCallCompletionData,
  sendWebhookData,
  sendMetaEvents,
  hashEmail,
  hashPhone,
};
