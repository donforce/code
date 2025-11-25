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
      console.log("[META] No active Meta integrations found");
      return;
    }

    // Determinar el evento basado en el resultado de la llamada
    let eventName = "Lead";
    if (callData.result === "success") {
      eventName = "Lead";
    } else if (callData.result === "not_answered") {
      eventName = "Lead";
    } else if (callData.result === "failed") {
      eventName = "Lead";
    }

    // Preparar el payload de Meta Events
    const metaPayload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000), // Timestamp en formato Unix
          event_id: `${leadData.id}-${eventName}`,
          action_source: "phone_call",
          user_data: {
            em: leadData.email ? hashEmail(leadData.email) : undefined,
            ph: leadData.phone ? hashPhone(leadData.phone) : undefined,
            lead_id: leadData.id,
          },
          custom_data: {
            lead_event_source: "OAI",
            event_source: "Orquesta",
            call_duration: callData.duration,
            call_result: callData.result,
            call_status: callData.status,
          },
          original_event_data: {
            event_name: eventName,
          },
        },
      ],
    };

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
          webhook_url: `https://graph.facebook.com/v18.0/${integration.meta_pixel_id}/events`,
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
          `[META] Sending event to pixel ${integration.meta_pixel_id}`
        );

        const metaUrl = `https://graph.facebook.com/v18.0/${integration.meta_pixel_id}/events?access_token=${integration.meta_access_token}`;

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
            `[META] Successfully sent event to pixel ${integration.meta_pixel_id}:`,
            result
          );

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
          console.error(
            `[META] Failed to send event to pixel ${integration.meta_pixel_id}: ${response.status} ${response.statusText}`,
            responseBody
          );

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
