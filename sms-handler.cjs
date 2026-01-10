// Download the helper library from https://www.twilio.com/docs/node/install
const twilio = require("twilio"); // Or, for ESM: import twilio from "twilio";
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Configuración de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// El cliente de Supabase se pasa como parámetro desde server.js (mismo patrón que webhook-handlers.js)

// Find your Account SID and Auth Token at twilio.com/console
// and set the environment variables. See http://twil.io/secure
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Función para validar webhook de Twilio
function validateTwilioWebhook(request, webhookUrl) {
  try {
    const twilioSignature = request.headers["x-twilio-signature"];
    if (!twilioSignature) {
      console.warn("⚠️ [SMS] No se encontró firma de Twilio");
      return false;
    }

    const params = request.body;
    const requestIsValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      webhookUrl,
      params
    );

    if (!requestIsValid) {
      console.warn("⚠️ [SMS] Firma de Twilio no válida");
      return false;
    }

    return true;
  } catch (error) {
    console.error("❌ [SMS] Error validando firma de Twilio:", error);
    return false;
  }
}

// Función para procesar mensajes entrantes de SMS
async function handleSMSMessage(supabase, request, reply) {
  try {
    console.log("📱 [SMS] Mensaje recibido de SMS");

    // Validar webhook de Twilio (opcional pero recomendado)
    const webhookUrl = `${request.protocol}://${request.hostname}${request.url}`;
    if (
      process.env.SMS_WEBHOOK_SECRET &&
      !validateTwilioWebhook(request, webhookUrl)
    ) {
      return reply.code(401).send({
        success: false,
        message: "Webhook no autorizado",
      });
    }

    // Twilio puede enviar datos como body (POST) o query params (GET)
    // Priorizar body, pero también verificar query params
    const body = request.body || {};
    const query = request.query || {};

    // Combinar datos del body y query params
    const messageData = { ...query, ...body };

    // Verificar que sea un mensaje de SMS
    if (messageData.From && messageData.Body && messageData.To) {
      const fromNumber = body.From;
      const toNumber = body.To;
      const messageBody = body.Body;
      const messageId = body.MessageSid;

      console.log("📱 [SMS] Datos del mensaje:", {
        from: fromNumber,
        to: toNumber,
        message: messageBody,
        messageId: messageId,
      });

      // Obtener user_id del request (puede venir del token JWT)
      const userId = request.user?.id || null;

      // Buscar o crear conversación en la base de datos
      const conversation = await getOrCreateConversation(
        supabase,
        fromNumber,
        toNumber,
        userId
      );

      // Generar respuesta con OpenAI
      const aiResponse = await generateAIResponse(
        supabase,
        messageBody,
        conversation
      );

      // Guardar mensaje entrante en la base de datos
      await saveMessage(
        supabase,
        conversation.id,
        fromNumber,
        messageBody,
        "incoming",
        messageId
      );

      try {
        // Enviar respuesta por SMS
        await sendSMSMessage(toNumber, fromNumber, aiResponse);

        // Guardar respuesta de IA en la base de datos
        await saveMessage(
          supabase,
          conversation.id,
          toNumber,
          aiResponse,
          "outgoing",
          null
        );

        // Actualizar conversación
        await updateConversation(supabase, conversation.id, aiResponse);

        console.log("✅ [SMS] Respuesta enviada y guardada exitosamente");
      } catch (sendError) {
        console.error("❌ [SMS] Error enviando respuesta:", sendError);

        // Guardar respuesta de IA aunque falle el envío
        await saveMessage(
          supabase,
          conversation.id,
          toNumber,
          aiResponse,
          "outgoing",
          null
        );

        // Actualizar conversación
        await updateConversation(supabase, conversation.id, aiResponse);

        // No fallar completamente, solo loggear el error
        console.warn("⚠️ [SMS] Respuesta guardada pero no enviada");
      }

      console.log("✅ [SMS] Mensaje procesado exitosamente");

      return reply.code(200).send({
        success: true,
        message: "Mensaje procesado",
        conversation_id: conversation.id,
      });
    } else {
      console.log("⚠️ [SMS] Mensaje no válido o incompleto");
      return reply.code(400).send({
        success: false,
        message: "Mensaje no válido",
      });
    }
  } catch (error) {
    console.error("❌ [SMS] Error procesando mensaje:", error);
    return reply.code(500).send({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
    });
  }
}

// Función para obtener o crear una conversación
async function getOrCreateConversation(
  supabase,
  fromNumber,
  toNumber,
  userId = null
) {
  try {
    // Buscar conversación existente
    const { data: existingConversation, error: searchError } = await supabase
      .from("sms_conversations")
      .select("*")
      .eq("phone_number", fromNumber)
      .eq("twilio_number", toNumber)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // SIEMPRE buscar usuario por número de teléfono para contexto
    let userData = null;
    if (!userId) {
      try {
        // Normalizar el número de teléfono (remover prefijos comunes)
        let normalizedNumber = fromNumber;

        // Remover prefijo "sms:" si existe
        if (normalizedNumber.startsWith("sms:")) {
          normalizedNumber = normalizedNumber.replace("sms:", "");
        }

        // Remover cualquier prefijo de país que empiece con +
        if (normalizedNumber.startsWith("+")) {
          // Remover solo el + y los primeros 1-3 dígitos (código de país)
          // Ejemplo: +17862989564 -> 7862989564
          normalizedNumber = normalizedNumber.substring(1); // Remover el +
          // Remover código de país (1-3 dígitos al inicio)
          normalizedNumber = normalizedNumber.replace(/^\d{1,3}/, "");
        }

        // Buscar usuario por número normalizado
        console.log("🔍 [SMS] Buscando usuario con números:", {
          normalizedNumber,
          fromNumber,
        });

        const { data: user, error: userError } = await supabase
          .from("users")
          .select(
            `
            id, 
            phone_number,
            first_name,
            last_name,
            email,
            subscription_plan,
            available_credits,
            total_credits,
            created_at
          `
          )
          .or(
            `phone_number.eq.${normalizedNumber},phone_number.eq.${fromNumber}`
          )
          .single();

        console.log("🔍 [SMS] Resultado búsqueda:", { user, userError });

        if (user && !userError) {
          userId = user.id;
          userData = user;
          console.log("✅ [SMS] Usuario encontrado por número:", {
            userId: user.id,
            name: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
            email: user.email,
            plan: user.subscription_plan,
            credits: `${user.available_credits || 0}/${
              user.total_credits || 0
            }`,
            phoneNumber: user.phone_number,
            fromNumber: fromNumber,
            normalizedNumber: normalizedNumber,
          });
        } else {
          console.log(
            "❌ [SMS] No se encontró usuario para el número:",
            fromNumber
          );
        }
      } catch (userSearchError) {
        console.log(
          "📱 [SMS] Error buscando usuario por número:",
          userSearchError.message
        );
        // Continuar sin userId
      }
    }

    // Si encontramos conversación existente, retornarla con contexto del usuario
    if (existingConversation && !searchError) {
      console.log(
        "📱 [SMS] Conversación existente encontrada:",
        existingConversation.id
      );
      // Agregar contexto del usuario a la conversación
      if (userData) {
        existingConversation.userContext = userData;
      }
      return existingConversation;
    }

    // Crear nueva conversación
    const { data: newConversation, error: createError } = await supabase
      .from("sms_conversations")
      .insert({
        user_id: userId, // Incluir user_id si está disponible
        phone_number: fromNumber,
        twilio_number: toNumber,
        status: "active",
        message_count: 0,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createError) {
      throw new Error(`Error creando conversación: ${createError.message}`);
    }

    console.log("📱 [SMS] Nueva conversación creada:", newConversation.id);

    // Agregar contexto del usuario a la nueva conversación
    if (userData) {
      newConversation.userContext = userData;
    }

    return newConversation;
  } catch (error) {
    console.error("❌ [SMS] Error en getOrCreateConversation:", error);
    throw error;
  }
}

// Función para generar respuesta con OpenAI (Responses + fine-tuned + memoria + datos de usuario + tools)
async function generateAIResponse(supabase, userMessage, conversation) {
  try {
    console.log("🤖 [OPENAI] Generando respuesta (Responses API + Tools)...");
    const modelName = process.env.OPENAI_MODEL || "gpt-5-mini";
    const BOOKING_LINK =
      process.env.ORQUESTAI_BOOKING_LINK ||
      "https://api.leadconnectorhq.com/widget/booking/xHzIB6FXahMqESj5Lf0e";

    // Importar tools
    const tools = require("./sms-tools.cjs");

    // Usar contexto del usuario de la conversación o buscar si no está disponible
    let userData = null;
    let userContext = "";

    // Primero intentar usar el contexto del usuario de la conversación
    if (conversation.userContext) {
      userData = conversation.userContext;
      console.log(
        "🔍 [OPENAI] Usando contexto del usuario de la conversación:",
        userData
      );
    } else if (conversation.user_id) {
      // Si no hay contexto, buscar datos del usuario por user_id
      try {
        const { data: user, error: userError } = await supabase
          .from("users")
          .select(
            `
            id,
            first_name,
            last_name,
            email,
            subscription_plan,
            available_credits,
            total_credits,
            created_at,
            phone_number
          `
          )
          .eq("id", conversation.user_id)
          .single();

        if (user && !userError) {
          userData = user;
          console.log("🔍 [OPENAI] Usuario encontrado por user_id:", userData);
        }
      } catch (error) {
        console.warn("⚠️ [OPENAI] Error obteniendo datos de usuario:", error);
      }
    }

    // Generar contexto del usuario si tenemos datos
    if (userData) {
      const fullName =
        `${userData.first_name || ""} ${userData.last_name || ""}`.trim() ||
        "Usuario";
      const registrationDate = userData.created_at
        ? new Date(userData.created_at).toLocaleDateString("es-ES")
        : "No disponible";

      userContext = `
CONTEXTO DEL USUARIO REGISTRADO:
- Nombre completo: ${fullName}
- Email: ${userData.email || "No disponible"}
- Plan de suscripción: ${userData.subscription_plan || "Sin plan"}
- Créditos disponibles: ${userData.available_credits || 0}
- Total de créditos: ${userData.total_credits || 0}
- Fecha de registro: ${registrationDate}
- Teléfono: ${userData.phone_number || "No disponible"}

IMPORTANTE: Usa SIEMPRE el nombre real del usuario (${fullName}) y sus datos específicos para personalizar la conversación.
`.trim();
    }

    console.log("🔍 [OPENAI] Contexto del usuario:", userContext);
    // Instrucciones "system/developer" persistentes
    let instructions = `
Eres el asistente virtual de OrquestAI atendiendo conversaciones por SMS.
OBJETIVO: convertir interés en una demo agendada de 30 min (CTA principal), sin sonar insistente.

ESTILO:
- Responde en 1–3 frases.
- Máximo 1 pregunta por mensaje.
- Tono profesional, claro y cercano.
- No expliques detalles técnicos (APIs, Twilio, webhooks, arquitectura, etc.).
- Los SMS tienen límite de caracteres, mantén las respuestas muy concisas.
- Mantén el hilo de la conversación: recuerda el contexto previo de mensajes anteriores, referencias a temas ya mencionados, y continúa la conversación de forma natural y coherente.

MANEJO DE MENSAJES AUTOMÁTICOS:
- Si recibes un mensaje que parece ser una respuesta automática del sistema (ej: confirmaciones de entrega, "Leído", notificaciones automáticas, mensajes de ausencia), responde de forma genérica y amigable: "Si tienes alguna duda o pregunta, no dudes en escribirme cuando gustes. Estoy aquí para ayudarte 😊"
- Solo responde con información específica o detallada a mensajes que sean preguntas directas, comentarios o solicitudes del cliente.
- Si el mensaje es ambiguo o parece automático, usa la respuesta genérica mencionada arriba.

PRODUCT FACTS (úsalos para responder; si algo no está aquí, invita a la demo):
- OrquestAI automatiza el contacto de leads en tiempo real y busca convertirlos en citas confirmadas.
- Cómo funciona (4 pasos): 1) conectas fuentes (Meta Ads/CRM/formularios), 2) contacto inmediato por llamada, 3) clasifica y agenda si hay intención, 4) en el dashboard ves métricas/ROI y puedes revisar el resultado: escuchar la llamada grabada, ver el resumen, el outcome y las citas agendadas.
- Características: calificación automática, agenda automática, recordatorios, dashboard, integraciones (Meta Ads, CRM, etc.).
- Sistema de llamadas: antes de llamar aplica reglas (créditos, horario permitido, zona horaria, país autorizado); luego registra resultado, transcripción y métricas. Tipos: directa, en cola, programada.
- Precios (solo "desde"): Profesional desde $199/mes (2,500 créditos). Empresarial desde $399/mes (6,000 créditos). Hay plan personalizado.
- No hay límites de leads.
- Sin costos ocultos en lo publicado. Puedes cambiar plan cuando quieras. Puedes pausar/cancelar desde el panel (datos 30 días).

POLÍTICA DE RESPUESTA:
- Si preguntan precio: responde con los "desde" y aclara que se confirma según volumen/uso en la demo.
- Siempre que haya intención (demo/precio/contratar/cómo funciona): cierra con
  "¿Quieres que te comparta el link para agendar una demo de 30 min?"
  Si el lead ya pidió el link, compártelo directamente: ${BOOKING_LINK}
- Usa el nombre de la persona en tus respuestas cuando esté disponible en el contexto. Personaliza el saludo y las respuestas incluyendo su nombre cuando sea apropiado.
- Si hay nombre del lead en el contexto, úsalo en el saludo inicial: "Hola [nombre]! 👋". Si no hay nombre, usa "Hola! 👋".
`.trim();

    // Agregar contexto del usuario si está registrado
    if (userContext) {
      instructions += `\n\n${userContext}\n\nIMPORTANTE: Usa el nombre del usuario y datos de su plan para personalizar la conversación.`;
    }

    // Build request con tools
    const req = {
      model: modelName,
      instructions,
      input: userMessage,
      // tools comentadas temporalmente para evitar errores de API
      /*
      tools: [
        {
          type: "function",
          name: "getUserInfo",
          description: "Obtener información completa del usuario registrado",
          parameters: {
            type: "object",
            properties: {
              userId: {
                type: "string",
                description: "ID del usuario",
              },
            },
            required: ["userId"],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "getUserLeadsStats",
          description:
            "Obtener estadísticas de leads del usuario (period opcional: 'week' o 'month', por defecto 'week')",
          parameters: {
            type: "object",
            properties: {
              userId: {
                type: "string",
                description: "ID del usuario",
              },
            },
            required: ["userId"],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "getPricingInfo",
          description:
            "Obtener información de precios y créditos por país (country opcional, por defecto 'US')",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "getCallQueueStatus",
          description: "Obtener estado de la cola de llamadas del usuario",
          parameters: {
            type: "object",
            properties: {
              userId: {
                type: "string",
                description: "ID del usuario",
              },
            },
            required: ["userId"],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "getUserBillingInfo",
          description: "Obtener información de facturación del usuario",
          parameters: {
            type: "object",
            properties: {
              userId: {
                type: "string",
                description: "ID del usuario",
              },
            },
            required: ["userId"],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "getAvailableDiscounts",
          description:
            "Obtener descuentos disponibles para el usuario (plan opcional, por defecto se detecta automáticamente)",
          parameters: {
            type: "object",
            properties: {
              userId: {
                type: "string",
                description: "ID del usuario",
              },
            },
            required: ["userId"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      */
      temperature: 0.7,
    };

    // Memoria de hilo: encadenar si hay último response
    if (conversation.last_response_id) {
      req.previous_response_id = conversation.last_response_id;
    }

    const r = await openai.responses.create(req);

    // Procesar tools si el modelo los usó
    let finalResponse =
      r.output_text ||
      (Array.isArray(r.output) && r.output[0]?.content?.[0]?.text) ||
      "Disculpa, ¿podrías repetir tu consulta?";

    // Persistir el nuevo response.id para la próxima vuelta
    await supabase
      .from("sms_conversations")
      .update({
        last_response_id: r.id,
        last_ai_response: finalResponse,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);

    console.log("🤖 [OPENAI] OK. response.id:", r.id);
    if (userData) {
      console.log(
        "👤 [USER] Respuesta personalizada para:",
        userData.first_name
      );
    }
    return finalResponse;
  } catch (error) {
    console.error("❌ [OPENAI] Error (Responses):", error);
    return "Disculpa, tuve un inconveniente técnico. ¿Puedes intentar de nuevo en unos minutos?";
  }
}

// Función para enviar mensaje por SMS
async function sendSMSMessage(toNumber, fromNumber, message) {
  try {
    console.log("📤 [SMS] Enviando mensaje a:", fromNumber);

    const response = await client.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber,
    });

    console.log("✅ [SMS] Mensaje enviado exitosamente:", response.sid);
    return response;
  } catch (error) {
    console.error("❌ [SMS] Error enviando mensaje:", error);
    throw error;
  }
}

// Función para guardar mensaje en la base de datos
async function saveMessage(
  supabase,
  conversationId,
  phoneNumber,
  messageContent,
  direction,
  externalId
) {
  try {
    const { data: savedMessage, error: saveError } = await supabase
      .from("sms_messages")
      .insert({
        conversation_id: conversationId,
        phone_number: phoneNumber,
        message_content: messageContent,
        direction: direction, // 'incoming' o 'outgoing'
        external_message_id: externalId,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (saveError) {
      throw new Error(`Error guardando mensaje: ${saveError.message}`);
    }

    console.log("💾 [SMS] Mensaje guardado:", savedMessage.id);
    return savedMessage;
  } catch (error) {
    console.error("❌ [SMS] Error guardando mensaje:", error);
    throw error;
  }
}

// Función para actualizar conversación
async function updateConversation(supabase, conversationId, lastMessage) {
  try {
    // Primero obtener el conteo actual de mensajes
    const { data: currentConversation, error: fetchError } = await supabase
      .from("sms_conversations")
      .select("message_count")
      .eq("id", conversationId)
      .single();

    if (fetchError) {
      throw new Error(`Error obteniendo conversación: ${fetchError.message}`);
    }

    const newMessageCount = (currentConversation?.message_count || 0) + 1;

    const { error: updateError } = await supabase
      .from("sms_conversations")
      .update({
        message_count: newMessageCount,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (updateError) {
      throw new Error(
        `Error actualizando conversación: ${updateError.message}`
      );
    }

    console.log("🔄 [SMS] Conversación actualizada:", conversationId);
  } catch (error) {
    console.error("❌ [SMS] Error actualizando conversación:", error);
    throw error;
  }
}

// Función para obtener estadísticas de conversaciones
async function getSMSStats(request, reply) {
  try {
    const { data: stats, error: statsError } = await supabase
      .from("sms_conversations")
      .select("status, created_at")
      .gte(
        "created_at",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      ); // Últimas 24 horas

    if (statsError) {
      throw new Error(`Error obteniendo estadísticas: ${statsError.message}`);
    }

    const activeConversations = stats.filter(
      (s) => s.status === "active"
    ).length;
    const totalConversations = stats.length;

    return reply.code(200).send({
      success: true,
      stats: {
        active_conversations: activeConversations,
        total_conversations_24h: totalConversations,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("❌ [SMS] Error obteniendo estadísticas:", error);
    return reply.code(500).send({
      success: false,
      message: "Error obteniendo estadísticas",
      error: error.message,
    });
  }
}

// Función para cerrar conversación
async function closeConversation(request, reply) {
  try {
    const { conversationId } = request.params;

    const { error: closeError } = await supabase
      .from("sms_conversations")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (closeError) {
      throw new Error(`Error cerrando conversación: ${closeError.message}`);
    }

    console.log("🔒 [SMS] Conversación cerrada:", conversationId);

    return reply.code(200).send({
      success: true,
      message: "Conversación cerrada exitosamente",
    });
  } catch (error) {
    console.error("❌ [SMS] Error cerrando conversación:", error);
    return reply.code(500).send({
      success: false,
      message: "Error cerrando conversación",
      error: error.message,
    });
  }
}

// Función para obtener historial de conversación
async function getConversationHistory(request, reply) {
  try {
    const { conversationId } = request.params;

    const { data: messages, error: messagesError } = await supabase
      .from("sms_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (messagesError) {
      throw new Error(`Error obteniendo historial: ${messagesError.message}`);
    }

    return reply.code(200).send({
      success: true,
      conversation_id: conversationId,
      messages: messages,
      total_messages: messages.length,
    });
  } catch (error) {
    console.error("❌ [SMS] Error obteniendo historial:", error);
    return reply.code(500).send({
      success: false,
      message: "Error obteniendo historial",
      error: error.message,
    });
  }
}

// Función para limpiar conversaciones antiguas
async function cleanupOldConversations(daysToKeep = 30) {
  try {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const { data: oldConversations, error: selectError } = await supabase
      .from("sms_conversations")
      .select("id")
      .eq("status", "closed")
      .lt("closed_at", cutoffDate.toISOString());

    if (selectError) {
      throw new Error(
        `Error seleccionando conversaciones antiguas: ${selectError.message}`
      );
    }

    if (oldConversations && oldConversations.length > 0) {
      const { error: deleteError } = await supabase
        .from("sms_conversations")
        .delete()
        .in(
          "id",
          oldConversations.map((c) => c.id)
        );

      if (deleteError) {
        throw new Error(
          `Error eliminando conversaciones antiguas: ${deleteError.message}`
        );
      }

      console.log(
        `🧹 [SMS] ${oldConversations.length} conversaciones antiguas eliminadas`
      );
      return oldConversations.length;
    }

    return 0;
  } catch (error) {
    console.error("❌ [SMS] Error limpiando conversaciones antiguas:", error);
    throw error;
  }
}

// Función para obtener métricas de engagement
async function getEngagementMetrics(userId = null) {
  try {
    const { data: metrics, error: metricsError } = await supabase.rpc(
      "get_sms_engagement_metrics",
      { user_id_param: userId }
    );

    if (metricsError) {
      throw new Error(
        `Error obteniendo métricas de engagement: ${metricsError.message}`
      );
    }

    return (
      metrics[0] || {
        total_users: 0,
        active_users_24h: 0,
        active_users_7d: 0,
        avg_response_time_minutes: 0,
        total_ai_responses: 0,
        avg_messages_per_user: 0,
      }
    );
  } catch (error) {
    console.error("❌ [SMS] Error obteniendo métricas de engagement:", error);
    throw error;
  }
}

console.log("📱 [SMS] Módulo de SMS cargado exitosamente");

// Exportar funciones para uso en otros módulos
module.exports = {
  handleSMSMessage,
  getSMSStats,
  closeConversation,
  getConversationHistory,
  cleanupOldConversations,
  getEngagementMetrics,
  validateTwilioWebhook,
};
