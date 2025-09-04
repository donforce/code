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
      console.warn("⚠️ [WHATSAPP] No se encontró firma de Twilio");
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
      console.warn("⚠️ [WHATSAPP] Firma de Twilio no válida");
      return false;
    }

    return true;
  } catch (error) {
    console.error("❌ [WHATSAPP] Error validando firma de Twilio:", error);
    return false;
  }
}

// Función para procesar mensajes entrantes de WhatsApp
async function handleWhatsAppMessage(supabase, request, reply) {
  try {
    console.log("📱 [WHATSAPP] ===== INICIO DE PROCESAMIENTO =====");
    console.log("📱 [WHATSAPP] URL:", request.url);
    console.log("📱 [WHATSAPP] Método:", request.method);
    console.log("📱 [WHATSAPP] Mensaje recibido");
    console.log("📱 [WHATSAPP] Supabase client type:", typeof supabase);
    console.log("📱 [WHATSAPP] Supabase client keys:", Object.keys(supabase || {}));
    console.log("📱 [WHATSAPP] Supabase client:", supabase);

    // Validar webhook de Twilio (opcional pero recomendado)
    const webhookUrl = `${request.protocol}://${request.hostname}${request.url}`;
    if (
      process.env.WHATSAPP_WEBHOOK_SECRET &&
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

    console.log("📱 [WHATSAPP] Body del mensaje:", body);
    console.log("📱 [WHATSAPP] Query params:", query);
    console.log("📱 [WHATSAPP] Datos combinados:", messageData);
    console.log("📱 [WHATSAPP] Headers:", request.headers);

    // Verificar que sea un mensaje de WhatsApp
    if (messageData.From && messageData.Body && messageData.To) {
      const fromNumber = body.From.replace("whatsapp:", "");
      const toNumber = body.To.replace("whatsapp:", "");
      const messageBody = body.Body;
      const messageId = body.MessageSid;

      console.log("📱 [WHATSAPP] Datos del mensaje:", {
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
        // Enviar respuesta por WhatsApp
        await sendWhatsAppMessage(toNumber, fromNumber, aiResponse);

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

        console.log("✅ [WHATSAPP] Respuesta enviada y guardada exitosamente");
      } catch (sendError) {
        console.error("❌ [WHATSAPP] Error enviando respuesta:", sendError);

        // Guardar respuesta de IA aunque falle el envío
        await saveMessage(
          conversation.id,
          toNumber,
          aiResponse,
          "outgoing",
          null
        );

        // Actualizar conversación
        await updateConversation(conversation.id, aiResponse);

        // No fallar completamente, solo loggear el error
        console.warn("⚠️ [WHATSAPP] Respuesta guardada pero no enviada");
      }

      console.log("✅ [WHATSAPP] Mensaje procesado exitosamente");

      return reply.code(200).send({
        success: true,
        message: "Mensaje procesado",
        conversation_id: conversation.id,
      });
    } else {
      console.log("⚠️ [WHATSAPP] Mensaje no válido o incompleto");
      return reply.code(400).send({
        success: false,
        message: "Mensaje no válido",
      });
    }
  } catch (error) {
    console.error("❌ [WHATSAPP] Error procesando mensaje:", error);
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
      .from("whatsapp_conversations")
      .select("*")
      .eq("phone_number", fromNumber)
      .eq("twilio_number", toNumber)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (existingConversation && !searchError) {
      console.log(
        "📱 [WHATSAPP] Conversación existente encontrada:",
        existingConversation.id
      );
      return existingConversation;
    }

    // Crear nueva conversación
    const { data: newConversation, error: createError } = await supabase
      .from("whatsapp_conversations")
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

    console.log("📱 [WHATSAPP] Nueva conversación creada:", newConversation.id);
    return newConversation;
  } catch (error) {
    console.error("❌ [WHATSAPP] Error en getOrCreateConversation:", error);
    throw error;
  }
}

// Función para generar respuesta con OpenAI
async function generateAIResponse(supabase, userMessage, conversation) {
  try {
    console.log(
      "🤖 [OPENAI] Generando respuesta para:",
      userMessage.substring(0, 100)
    );

    // Obtener historial de mensajes para contexto
    const { data: messageHistory, error: historyError } = await supabase
      .from("whatsapp_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(10); // Últimos 10 mensajes para contexto

    if (historyError) {
      console.warn("⚠️ [OPENAI] Error obteniendo historial:", historyError);
    }

    // Construir contexto para OpenAI
    let context =
      "Eres un asistente virtual amigable y profesional. Responde de manera clara y útil.";

    if (messageHistory && messageHistory.length > 0) {
      context += "\n\nHistorial de la conversación:\n";
      messageHistory.reverse().forEach((msg) => {
        const role = msg.direction === "incoming" ? "Usuario" : "Asistente";
        context += `${role}: ${msg.message_content}\n`;
      });
    }

    // Prompt para OpenAI
    const prompt = `${context}\n\nUsuario: ${userMessage}\n\nAsistente:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "Eres un asistente virtual profesional y amigable. Responde de manera clara, útil y natural. Mantén las respuestas concisas pero informativas.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content.trim();
    console.log("🤖 [OPENAI] Respuesta generada:", response.substring(0, 100));

    return response;
  } catch (error) {
    console.error("❌ [OPENAI] Error generando respuesta:", error);

    // Respuesta de fallback
    return "Disculpa, estoy teniendo dificultades técnicas en este momento. Por favor, intenta de nuevo en unos minutos o contacta con nuestro equipo de soporte.";
  }
}

// Función para enviar mensaje por WhatsApp
async function sendWhatsAppMessage(toNumber, fromNumber, message) {
  try {
    console.log("📤 [WHATSAPP] Enviando mensaje a:", fromNumber);

    const response = await client.messages.create({
      body: message,
      from: `whatsapp:${toNumber}`,
      to: `whatsapp:${fromNumber}`,
    });

    console.log("✅ [WHATSAPP] Mensaje enviado exitosamente:", response.sid);
    return response;
  } catch (error) {
    console.error("❌ [WHATSAPP] Error enviando mensaje:", error);
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
      .from("whatsapp_messages")
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

    console.log("💾 [WHATSAPP] Mensaje guardado:", savedMessage.id);
    return savedMessage;
  } catch (error) {
    console.error("❌ [WHATSAPP] Error guardando mensaje:", error);
    throw error;
  }
}

// Función para actualizar conversación
async function updateConversation(supabase, conversationId, lastMessage) {
  try {
    const { error: updateError } = await supabase
      .from("whatsapp_conversations")
      .update({
        message_count: supabase.sql`message_count + 1`,
        last_message_at: new Date().toISOString(),
        last_ai_response: lastMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (updateError) {
      throw new Error(
        `Error actualizando conversación: ${updateError.message}`
      );
    }

    console.log("🔄 [WHATSAPP] Conversación actualizada:", conversationId);
  } catch (error) {
    console.error("❌ [WHATSAPP] Error actualizando conversación:", error);
    throw error;
  }
}

// Función para obtener estadísticas de conversaciones
async function getWhatsAppStats(request, reply) {
  try {
    const { data: stats, error: statsError } = await supabase
      .from("whatsapp_conversations")
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
    console.error("❌ [WHATSAPP] Error obteniendo estadísticas:", error);
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
      .from("whatsapp_conversations")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (closeError) {
      throw new Error(`Error cerrando conversación: ${closeError.message}`);
    }

    console.log("🔒 [WHATSAPP] Conversación cerrada:", conversationId);

    return reply.code(200).send({
      success: true,
      message: "Conversación cerrada exitosamente",
    });
  } catch (error) {
    console.error("❌ [WHATSAPP] Error cerrando conversación:", error);
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
      .from("whatsapp_messages")
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
    console.error("❌ [WHATSAPP] Error obteniendo historial:", error);
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
      .from("whatsapp_conversations")
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
        .from("whatsapp_conversations")
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
        `🧹 [WHATSAPP] ${oldConversations.length} conversaciones antiguas eliminadas`
      );
      return oldConversations.length;
    }

    return 0;
  } catch (error) {
    console.error(
      "❌ [WHATSAPP] Error limpiando conversaciones antiguas:",
      error
    );
    throw error;
  }
}

// Función para obtener métricas de engagement
async function getEngagementMetrics(userId = null) {
  try {
    const { data: metrics, error: metricsError } = await supabase.rpc(
      "get_whatsapp_engagement_metrics",
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
    console.error(
      "❌ [WHATSAPP] Error obteniendo métricas de engagement:",
      error
    );
    throw error;
  }
}

console.log("📱 [WHATSAPP] Módulo de WhatsApp cargado exitosamente");

// Exportar funciones para uso en otros módulos
module.exports = {
  handleWhatsAppMessage,
  getWhatsAppStats,
  closeConversation,
  getConversationHistory,
  cleanupOldConversations,
  getEngagementMetrics,
  validateTwilioWebhook,
};
