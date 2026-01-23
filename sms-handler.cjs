// Download the helper library from https://www.twilio.com/docs/node/install
const twilio = require("twilio"); // Or, for ESM: import twilio from "twilio";
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
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

// Función para pausar todas las secuencias activas de un lead
async function pauseLeadSequences(supabase, leadId) {
  try {
    console.log("⏸️ [SEQUENCES] Pausando secuencias para lead:", leadId);
    
    const now = new Date().toISOString();
    
    // Buscar todas las secuencias activas del lead
    const { data: activeSequences, error: findError } = await supabase
      .from("lead_sequences")
      .select("id, sequence_id")
      .eq("lead_id", leadId)
      .eq("status", "active");

    if (findError) {
      console.error("❌ [SEQUENCES] Error buscando secuencias activas:", findError);
      return;
    }

    if (!activeSequences || activeSequences.length === 0) {
      console.log("ℹ️ [SEQUENCES] No hay secuencias activas para pausar");
      return;
    }

    // Pausar todas las secuencias activas
    const sequenceIds = activeSequences.map((ls) => ls.id);
    const { error: updateError } = await supabase
      .from("lead_sequences")
      .update({
        status: "paused",
        paused_at: now,
        updated_at: now,
      })
      .in("id", sequenceIds);

    if (updateError) {
      console.error("❌ [SEQUENCES] Error pausando secuencias:", updateError);
      return;
    }

    console.log(
      `✅ [SEQUENCES] ${activeSequences.length} secuencia(s) pausada(s) para lead ${leadId}`
    );
  } catch (error) {
    console.error("❌ [SEQUENCES] Error en pauseLeadSequences:", error);
    throw error;
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

      // BOOKING_LINK para eventos Meta
      const BOOKING_LINK =
        process.env.ORQUESTAI_BOOKING_LINK ||
        "https://api.leadconnectorhq.com/widget/booking/xHzIB6FXahMqESj5Lf0e";

      // Buscar o crear conversación en la base de datos
      const conversation = await getOrCreateConversation(
        supabase,
        fromNumber,
        toNumber,
        userId
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

      // Pausar secuencias activas del lead si tiene lead_id
      if (conversation.lead_id) {
        try {
          await pauseLeadSequences(supabase, conversation.lead_id);
        } catch (pauseError) {
          console.error("❌ [SMS] Error pausando secuencias:", pauseError);
          // No fallar el webhook si hay error pausando secuencias
        }
      }

      // Verificar si la conversación tiene respuesta automática habilitada
      // Si auto_respond es false o null (por defecto null = true), solo guardamos el mensaje
      const shouldAutoRespond = conversation.auto_respond !== false;

      console.log("🤖 [SMS] Auto-respond configurado:", {
        conversationId: conversation.id,
        auto_respond: conversation.auto_respond,
        shouldAutoRespond: shouldAutoRespond,
      });

      if (!shouldAutoRespond) {
        console.log(
          "⏸️ [SMS] Respuesta automática desactivada. Mensaje guardado para respuesta manual."
        );
        return reply.code(200).send({
          success: true,
          message:
            "Mensaje recibido y guardado. Respuesta automática desactivada.",
          conversation_id: conversation.id,
          auto_respond: false,
        });
      }

      // Obtener mensajes desde el último que se envió a OpenAI
      // para incluir todo el contexto en la generación de la respuesta
      let conversationMessages = [];
      try {
        // Buscar el último mensaje de IA para saber desde dónde obtener el historial
        // Buscamos el mensaje saliente que coincide con last_ai_response
        const { data: lastAiConversation } = await supabase
          .from("sms_conversations")
          .select("last_response_id, last_ai_response")
          .eq("id", conversation.id)
          .single();

        let lastAiMessageTimestamp = null;

        // Si hay last_ai_response, buscar el mensaje saliente que coincide
        if (lastAiConversation?.last_ai_response) {
          const { data: lastAiMessage } = await supabase
            .from("sms_messages")
            .select("created_at")
            .eq("conversation_id", conversation.id)
            .eq("direction", "outgoing")
            .eq("message_content", lastAiConversation.last_ai_response)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastAiMessage?.created_at) {
            lastAiMessageTimestamp = lastAiMessage.created_at;
          }
        }

        // Obtener todos los mensajes desde el último mensaje de IA (o todos si no hay mensajes de IA)
        const messagesQuery = supabase
          .from("sms_messages")
          .select("message_content, direction, created_at")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: true });

        if (lastAiMessageTimestamp) {
          // Obtener mensajes creados después del último mensaje de IA
          messagesQuery.gt("created_at", lastAiMessageTimestamp);
        }

        const { data: recentMessages, error: messagesError } =
          await messagesQuery;

        if (!messagesError && recentMessages && recentMessages.length > 0) {
          // Construir contexto con todos los mensajes desde el último de IA
          conversationMessages = recentMessages.map((msg) => ({
            role: msg.direction === "incoming" ? "user" : "assistant",
            content: msg.message_content,
          }));
          console.log(
            `🤖 [OPENAI] Including ${conversationMessages.length} messages since last AI response`
          );
        }
      } catch (messagesError) {
        console.warn(
          "⚠️ [OPENAI] Error obtaining conversation history:",
          messagesError
        );
        // Continuar sin historial adicional
      }

      // Construir input con historial si hay mensajes nuevos
      let inputMessage = messageBody;
      if (conversationMessages.length > 0) {
        // Incluir el historial en el input
        const historyText = conversationMessages
          .map(
            (msg) =>
              `${msg.role === "user" ? "Usuario" : "Asistente"}: ${msg.content}`
          )
          .join("\n");
        inputMessage = `${historyText}\n\nUsuario: ${messageBody}`;
      }

      // Generar respuesta con OpenAI (solo si auto_respond está habilitado)
      const aiResponse = await generateAIResponse(
        supabase,
        inputMessage,
        conversation
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

        // 🆕 Detectar eventos para Meta y enviarlos
        // Ejecutar de forma asíncrona para no bloquear la respuesta
        setImmediate(async () => {
          try {
            // Obtener userData y leadData para eventos Meta
            let userDataForMeta = null;
            if (conversation.user_id) {
              const { data: user } = await supabase
                .from("users")
                .select("id, email, first_name, last_name")
                .eq("id", conversation.user_id)
                .single();
              if (user) userDataForMeta = user;
            }

            // Buscar lead por phone_number
            let leadDataForMeta = null;
            if (fromNumber && conversation.user_id) {
              const { data: leads } = await supabase
                .from("leads")
                .select("id, name, last_name, phone, email")
                .eq("phone", fromNumber)
                .eq("user_id", conversation.user_id)
                .order("created_at", { ascending: false })
                .limit(1);
              if (leads && leads.length > 0) {
                leadDataForMeta = leads[0];
              }
            }

            await sendSMSMetaEvents(
              supabase,
              aiResponse,
              conversation,
              leadDataForMeta,
              userDataForMeta,
              BOOKING_LINK
            );
          } catch (metaError) {
            console.error(
              "❌ [SMS META] Error sending Meta events:",
              metaError
            );
          }
        });

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
    const tools = require("./ai-tools.cjs");

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
    
    // Obtener datos del LEAD con el que se está generando la conversación
    let leadData = null;
    if (conversation.lead_id) {
      try {
        const { data: lead, error: leadError } = await supabase
          .from("leads")
          .select(
            `
            id,
            name,
            last_name,
            phone,
            email,
            source,
            notes,
            created_at,
            updated_at
          `
          )
          .eq("id", conversation.lead_id)
          .single();

        if (lead && !leadError) {
          leadData = lead;
          console.log("🔍 [OPENAI] Lead encontrado por lead_id:", leadData);
        } else {
          console.warn(
            "⚠️ [OPENAI] No se encontró lead con lead_id:",
            conversation.lead_id
          );
        }
      } catch (error) {
        console.warn("⚠️ [OPENAI] Error obteniendo datos del lead:", error);
      }
    } else {
      console.log("⚠️ [OPENAI] La conversación no tiene lead_id asociado");
    }
    
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
- OrquestAI automatiza el contacto de posibles clientes en tiempo real y busca convertirlos en citas confirmadas.
- Cómo funciona (4 pasos): 1) conectas fuentes de posibles clientes (CRM/formularios/publicidad), 2) contacto inmediato por llamada, 3) clasifica y agenda si hay intención, 4) en el dashboard ves métricas/ROI y puedes revisar el resultado: escuchar la llamada grabada, ver el resumen, el outcome y las citas agendadas.
- Características: calificación automática, agenda automática, recordatorios, dashboard, integraciones con diversas fuentes de posibles clientes.
- Sistema de llamadas: antes de llamar aplica reglas (créditos, horario permitido, zona horaria, país autorizado); luego registra resultado, transcripción y métricas. Tipos: directa, en cola, programada.
- Precios (solo "desde"): Profesional desde $199/mes (2,500 créditos). Empresarial desde $399/mes (6,000 créditos). Hay plan personalizado.
- No hay límites de leads.
- Sin costos ocultos en lo publicado. Puedes cambiar plan cuando quieras. Puedes pausar/cancelar desde el panel (datos 30 días).

POLÍTICA DE RESPUESTA:
- Si preguntan precio: responde con los "desde" y aclara que se confirma según volumen/uso en la demo.
- Siempre que haya intención (demo/precio/contratar/cómo funciona): cierra con
  "¿Quieres que te comparta el link para agendar una demo de 30 min?"
  Si el lead ya pidió el link, compártelo directamente: ${BOOKING_LINK}
- Si te preguntan si eres una IA, un bot, o si eres artificial: responde directamente que sí, que eres la asistente virtual de OrquestAI y que estás aquí para ayudarles. NO uses la función handleRepresentativeRequest en este caso.
- Si el cliente quiere hablar con un representante, especialista, persona, humano, agente, ejecutivo, asesor, o pide específicamente hablar con una persona real: DEBES usar la función handleRepresentativeRequest inmediatamente. Después, usa notifyAgentSpecialistRequest para notificar al agente por SMS. No respondas directamente, usa las funciones.
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
      tools: [
        {
          type: "function",
          name: "handleRepresentativeRequest",
          description: "Usar SOLO cuando el cliente pide específicamente hablar con un representante, especialista, persona, humano, agente, ejecutivo o asesor. NO usar si solo preguntan si eres una IA o un bot - en ese caso responde directamente que sí eres la asistente virtual de OrquestAI. Esta función debe usarse inmediatamente cuando se detecte la intención de hablar con una persona real.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: "function",
          name: "notifyAgentSpecialistRequest",
          description: "Enviar una notificación por SMS al agente/usuario cuando un cliente quiere hablar con un especialista. Usa esta función después de usar handleRepresentativeRequest para notificar al agente.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      // Nota: temperature no está soportado por este modelo
    };

    // Memoria de hilo: encadenar si hay último response
    // IMPORTANTE: Si hay previous_response_id, verificar si tiene tool calls pendientes
    let currentResponseId = null; // Declarar aquí para usar en todo el flujo
    if (conversation.last_response_id) {
      // Obtener el response anterior para verificar si tiene tool calls pendientes
      try {
        const previousResponse = await openai.responses.retrieve(conversation.last_response_id);
        console.log("📋 [OPENAI] Response anterior recuperado:", JSON.stringify(previousResponse, null, 2));
        
        // Verificar si tiene tool calls pendientes
        let pendingToolCalls = previousResponse.tool_calls || [];
        if (!pendingToolCalls.length && Array.isArray(previousResponse.output)) {
          const functionCalls = previousResponse.output.filter(item => item.type === 'function_call');
          if (functionCalls.length > 0) {
            pendingToolCalls = functionCalls.map(fc => ({
              id: fc.call_id || fc.id,
              type: 'function',
              function: {
                name: fc.name,
                arguments: fc.arguments || '{}'
              }
            }));
          }
        }
        
        // Si hay tool calls pendientes, ejecutarlas y enviar outputs ANTES del nuevo input
        if (pendingToolCalls && pendingToolCalls.length > 0) {
          console.log(`🔧 [OPENAI] Encontradas ${pendingToolCalls.length} tool calls pendientes, ejecutándolas primero...`);
          console.log(`📋 [OPENAI] Tool calls pendientes:`, JSON.stringify(pendingToolCalls, null, 2));
          
          for (const toolCall of pendingToolCalls) {
            const functionName = toolCall.function?.name;
            const toolCallId = toolCall.id;
            const functionArgumentsRaw = toolCall.function?.arguments || "{}";
            
            console.log(`🔧 [TOOL] Procesando tool call:`, {
              id: toolCallId,
              functionName: functionName,
              arguments: functionArgumentsRaw
            });
            
            let functionArgs = {};
            try {
              functionArgs = JSON.parse(functionArgumentsRaw);
            } catch (parseError) {
              console.error(`❌ [TOOL] Error parseando arguments:`, parseError);
              functionArgs = {};
            }
            
            // IMPORTANTE: Preparar y enviar respuesta a OpenAI ANTES de ejecutar la tool
            let toolOutput;
            if (functionName === "handleRepresentativeRequest") {
              // Para handleRepresentativeRequest, podemos preparar el output antes de ejecutar
              toolOutput = JSON.stringify({ bookingLink: BOOKING_LINK });
            } else if (functionName === "notifyAgentSpecialistRequest") {
              // Para notifyAgentSpecialistRequest, preparamos el output placeholder
              toolOutput = JSON.stringify({ notified: true });
            } else {
              toolOutput = JSON.stringify({ success: true });
            }
            
            // Enviar respuesta a OpenAI ANTES de ejecutar la tool
            const toolInput = {
              type: "function_call_output",
              call_id: toolCallId,
              output: toolOutput,
            };
            
            console.log("📤 [OPENAI] Enviando respuesta de tool a OpenAI ANTES de ejecutar:", JSON.stringify(toolInput, null, 2));
            
            const toolReq = {
              model: modelName,
              previous_response_id: currentResponseId || conversation.last_response_id,
              input: [toolInput],
            };
            
            console.log("📤 [OPENAI] Request para enviar tool output:", JSON.stringify(toolReq, null, 2));
            
            try {
              const toolResponse = await openai.responses.create(toolReq);
              console.log("✅ [OPENAI] Respuesta enviada a OpenAI antes de ejecutar tool, nuevo response_id:", toolResponse.id);
              console.log("📋 [OPENAI] Respuesta completa después de tool output:", JSON.stringify(toolResponse, null, 2));
              
              // Verificar que el nuevo response no tiene tool calls pendientes
              if (toolResponse.tool_calls && toolResponse.tool_calls.length > 0) {
                console.warn("⚠️ [OPENAI] El nuevo response todavía tiene tool calls pendientes:", toolResponse.tool_calls);
              }
              
              currentResponseId = toolResponse.id;
            } catch (toolError) {
              console.error("❌ [OPENAI] Error enviando respuesta a OpenAI antes de ejecutar tool:", toolError);
              console.error("❌ [OPENAI] Error details:", JSON.stringify(toolError, null, 2));
              // Continuar con la ejecución aunque falle el envío
            }
            
            // AHORA ejecutar la tool
            let result;
            if (functionName === "handleRepresentativeRequest") {
              result = await tools.handleRepresentativeRequest(supabase, BOOKING_LINK);
            } else if (functionName === "notifyAgentSpecialistRequest") {
              const clientPhone = conversation.phone_number || null;
              const clientName = leadData 
                ? `${leadData.name || ""} ${leadData.last_name || ""}`.trim() || null
                : null;
              const userId = conversation.user_id || null;
              result = await tools.notifyAgentSpecialistRequest(supabase, userId, clientPhone, clientName);
            } else {
              result = { success: false, error: `Función ${functionName} no implementada` };
            }
            
            console.log(`✅ [TOOL] Resultado de ${functionName} después de enviar respuesta a OpenAI:`, JSON.stringify(result, null, 2));
            
            // Agregar a toolOutputs para el caso de pending tools
            toolOutputs.push({
              type: "function_call_output",
              call_id: toolCall.id,
              output: toolOutput,
            });
          }
          
          // Enviar tool outputs a OpenAI ANTES del nuevo input
          if (toolOutputs.length > 0) {
            console.log("📤 [OPENAI] Enviando tool outputs pendientes ANTES del nuevo input:", JSON.stringify(toolOutputs, null, 2));
            const toolOutputReq = {
              model: modelName,
              previous_response_id: conversation.last_response_id,
              input: toolOutputs,
            };
            
            const toolOutputResponse = await openai.responses.create(toolOutputReq);
            console.log("✅ [OPENAI] Tool outputs enviados, nuevo response_id:", toolOutputResponse.id);
            currentResponseId = toolOutputResponse.id;
            req.previous_response_id = toolOutputResponse.id; // Usar el nuevo response_id para el siguiente request
          }
        } else {
          // No hay tool calls pendientes, usar el previous_response_id normalmente
          req.previous_response_id = conversation.last_response_id;
          currentResponseId = conversation.last_response_id;
        }
      } catch (retrieveError) {
        console.error("❌ [OPENAI] Error recuperando response anterior:", retrieveError);
        // Si falla, usar el previous_response_id normalmente
        req.previous_response_id = conversation.last_response_id;
        currentResponseId = conversation.last_response_id;
      }
    }

    console.log("📤 [OPENAI] Request que se envía a OpenAI:", JSON.stringify(req, null, 2));

    const r = await openai.responses.create(req);

    // Logs detallados de la respuesta de OpenAI
    console.log("=".repeat(80));
    console.log("🤖 [OPENAI] ═══ RESPUESTA DE OPENAI ═══");
    console.log("=".repeat(80));
    console.log("📋 [OPENAI] Respuesta completa:", JSON.stringify(r, null, 2));
    console.log("📋 [OPENAI] output_text:", r.output_text);
    console.log("📋 [OPENAI] output:", r.output);
    console.log("📋 [OPENAI] tool_calls:", r.tool_calls);
    console.log("📋 [OPENAI] tool_calls length:", r.tool_calls?.length || 0);
    if (r.tool_calls && r.tool_calls.length > 0) {
      console.log("📋 [OPENAI] Detalles de tool_calls:");
      r.tool_calls.forEach((tc, idx) => {
        console.log(`   [${idx}] ID: ${tc.id}`);
        console.log(`   [${idx}] Type: ${tc.type}`);
        console.log(`   [${idx}] Function name: ${tc.function?.name}`);
        console.log(`   [${idx}] Function arguments: ${tc.function?.arguments}`);
      });
    }
    console.log("=".repeat(80));

    // Convertir output con function_call a formato tool_calls si es necesario
    let toolCalls = r.tool_calls || [];
    if (!toolCalls.length && Array.isArray(r.output)) {
      // Buscar function_calls en el output
      const functionCalls = r.output.filter(item => item.type === 'function_call');
      if (functionCalls.length > 0) {
        console.log("🔄 [OPENAI] Convirtiendo function_calls de output a tool_calls");
        toolCalls = functionCalls.map(fc => ({
          id: fc.call_id || fc.id,
          type: 'function',
          function: {
            name: fc.name,
            arguments: fc.arguments || '{}'
          }
        }));
        console.log("📋 [OPENAI] tool_calls convertidos:", JSON.stringify(toolCalls, null, 2));
      }
    }

    // Procesar tools si el modelo los usó
    let finalResponse =
      r.output_text ||
      (Array.isArray(r.output) && r.output[0]?.content?.[0]?.text) ||
      "Disculpa, ¿podrías repetir tu consulta?";

    // Declarar finalR fuera del bloque para que esté disponible después
    let finalR = null;
    // currentResponseId ya está declarado arriba, actualizar con el response_id inicial si no se actualizó antes
    if (!currentResponseId) {
      currentResponseId = r.id;
    }

    // Si el modelo usó tools, ejecutarlas y enviar respuesta inmediatamente después de cada una
    if (toolCalls && toolCalls.length > 0) {
      console.log(
        "🔧 [TOOLS] Modelo solicitó usar tools:",
        toolCalls.length
      );

      // Si handleRepresentativeRequest fue llamada, ya tenemos la respuesta final
      let representativeCalled = false;

      for (const toolCall of toolCalls) {
        try {
          console.log("=".repeat(80));
          console.log(`🔧 [TOOL] ═══ PROCESANDO TOOL CALL ═══`);
          console.log("=".repeat(80));
          console.log("📋 [TOOL] Tool call completo:", JSON.stringify(toolCall, null, 2));
          
          const functionName = toolCall.function?.name;
          const functionArgumentsRaw = toolCall.function?.arguments || "{}";
          
          console.log(`📋 [TOOL] Function name: ${functionName}`);
          console.log(`📋 [TOOL] Function arguments (raw): ${functionArgumentsRaw}`);
          
          let functionArgs = {};
          try {
            functionArgs = JSON.parse(functionArgumentsRaw);
            console.log(`📋 [TOOL] Function arguments (parsed):`, functionArgs);
          } catch (parseError) {
            console.error(`❌ [TOOL] Error parseando arguments:`, parseError);
            console.error(`❌ [TOOL] Arguments raw:`, functionArgumentsRaw);
            throw new Error(`Error parseando arguments: ${parseError.message}`);
          }

          console.log(
            `🔧 [TOOL] Ejecutando ${functionName} con args:`,
            functionArgs
          );

          // IMPORTANTE: Preparar y enviar respuesta a OpenAI ANTES de ejecutar la tool
          let toolOutput;
          if (functionName === "handleRepresentativeRequest") {
            // Para handleRepresentativeRequest, podemos preparar el output antes de ejecutar
            toolOutput = JSON.stringify({ bookingLink: BOOKING_LINK });
          } else if (functionName === "notifyAgentSpecialistRequest") {
            // Para notifyAgentSpecialistRequest, preparamos el output placeholder
            toolOutput = JSON.stringify({ notified: true });
          } else {
            toolOutput = JSON.stringify({ success: true });
          }
          
          // Enviar respuesta a OpenAI ANTES de ejecutar la tool
          const toolInput = {
            type: "function_call_output",
            call_id: toolCall.id,
            output: toolOutput,
          };
          
          console.log("📤 [OPENAI] Enviando respuesta de tool a OpenAI ANTES de ejecutar:", JSON.stringify(toolInput, null, 2));
          
          const toolReq = {
            model: modelName,
            previous_response_id: currentResponseId,
            input: [toolInput],
          };
          
          try {
            const toolResponse = await openai.responses.create(toolReq);
            console.log("✅ [OPENAI] Respuesta enviada a OpenAI antes de ejecutar tool, nuevo response_id:", toolResponse.id);
            currentResponseId = toolResponse.id;
            finalR = toolResponse; // Guardar el último response
          } catch (toolError) {
            console.error("❌ [OPENAI] Error enviando respuesta a OpenAI antes de ejecutar tool:", toolError);
            // Continuar con la ejecución aunque falle el envío
          }
          
          // AHORA ejecutar la función correspondiente
          let result;
          if (functionName === "handleRepresentativeRequest") {
            result = await tools.handleRepresentativeRequest(supabase, BOOKING_LINK);
            // Si es solicitud de representante, usar directamente el mensaje
            if (result.success && result.data) {
              finalResponse = result.data.mensaje;
              representativeCalled = true;
              console.log("👤 [REPRESENTATIVE] Usando respuesta directa de función:", finalResponse);
            }
          } else if (functionName === "notifyAgentSpecialistRequest") {
            // Obtener información del cliente para notificar al agente
            const clientPhone = conversation.phone_number || null;
            const clientName = leadData 
              ? `${leadData.name || ""} ${leadData.last_name || ""}`.trim() || null
              : null;
            const userId = conversation.user_id || null;
            
            result = await tools.notifyAgentSpecialistRequest(
              supabase,
              userId,
              clientPhone,
              clientName
            );
          } else {
            result = {
              success: false,
              error: `Función ${functionName} no implementada`,
            };
          }
          
          console.log(`✅ [TOOL] Resultado de ${functionName} después de enviar respuesta a OpenAI:`, JSON.stringify(result, null, 2));
          console.log("=".repeat(80));
          
          // La respuesta ya fue enviada a OpenAI antes de ejecutar la tool
          // Si no es representante y tenemos una respuesta de OpenAI, usarla
          if (!representativeCalled && finalR && finalR.output_text) {
            finalResponse =
              finalR.output_text ||
              (Array.isArray(finalR.output) &&
                finalR.output[0]?.content?.[0]?.text) ||
              finalResponse;
          }
          
        } catch (error) {
          console.error("=".repeat(80));
          console.error(`❌ [TOOL] ═══ ERROR EJECUTANDO TOOL ═══`);
          console.error("=".repeat(80));
          console.error(`❌ [TOOL] Error ejecutando tool:`, error);
          console.error(`❌ [TOOL] Error stack:`, error.stack);
          console.error(`❌ [TOOL] Tool call que falló:`, JSON.stringify(toolCall, null, 2));
          console.error("=".repeat(80));
          
          // Enviar error a OpenAI también con formato JSON stringificado
          const errorOutput = JSON.stringify({ error: `Error ejecutando ${functionName}: ${error.message}` });
          const errorInput = {
            type: "function_call_output",
            call_id: toolCall.id,
            output: errorOutput,
          };

          try {
            const errorReq = {
              model: modelName,
              previous_response_id: currentResponseId,
              input: [errorInput],
            };

            const errorResponse = await openai.responses.create(errorReq);
            currentResponseId = errorResponse.id;
            finalR = errorResponse;
          } catch (errorSendError) {
            console.error("❌ [OPENAI] Error enviando error de tool a OpenAI:", errorSendError);
            // Continuar con la siguiente tool aunque falle el envío del error
          }
        }
      }
    }

    // Determinar qué response_id usar para persistir (el último que se usó)
    // Si hubo tool_calls y se hizo una segunda llamada, usar el id del response final
    let responseIdToPersist = finalR?.id || r.id;

    // Validar que tengamos un id antes de intentar persistirlo
    if (!responseIdToPersist) {
      console.error("❌ [OPENAI] Error: no hay response_id para persistir");
      console.error("❌ [OPENAI] Respuesta completa:", JSON.stringify(r, null, 2));
      console.error("❌ [OPENAI] finalResponse:", finalResponse);
      // Continuar sin actualizar last_response_id, pero retornar la respuesta
      return finalResponse;
    }

    // Persistir el response.id para la próxima vuelta
    try {
      await supabase
        .from("sms_conversations")
        .update({
          last_response_id: responseIdToPersist,
          last_ai_response: finalResponse,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversation.id);

      console.log("🤖 [OPENAI] OK. response.id persistido:", responseIdToPersist);
    } catch (updateError) {
      console.error("❌ [OPENAI] Error actualizando conversación:", updateError);
      // No fallar completamente, solo loggear el error y continuar
      console.warn("⚠️ [OPENAI] Continuando sin actualizar last_response_id");
    }
    if (userData) {
      console.log(
        "👤 [USER] Respuesta personalizada para:",
        userData.first_name
      );
    }
    return finalResponse;
  } catch (error) {
    console.error("=".repeat(80));
    console.error("❌ [OPENAI] ═══ ERROR EN generateAIResponse ═══");
    console.error("=".repeat(80));
    console.error("❌ [OPENAI] Error completo:", error);
    console.error("❌ [OPENAI] Error message:", error.message);
    console.error("❌ [OPENAI] Error stack:", error.stack);
    console.error("=".repeat(80));
    return "Disculpa, tuve un inconveniente técnico. ¿Puedes intentar de nuevo en unos minutos?";
  }
}

// Función para enviar mensaje por SMS
async function sendSMSMessage(toNumber, fromNumber, message) {
  try {
    console.log("📤 [SMS] Enviando mensaje a:", fromNumber);

    const statusCallbackUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/message-status`;

    const response = await client.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber,
      statusCallback: statusCallbackUrl,
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

// 🆕 Función para enviar eventos a Meta desde SMS
async function sendSMSMetaEvents(
  supabase,
  messageContent,
  conversation,
  leadData,
  userData,
  bookingLink
) {
  try {
    // Solo enviar si hay lead y usuario
    if (!leadData || !userData) {
      return;
    }

    // Obtener integraciones con Meta Events activas
    const { data: integrations, error } = await supabase
      .from("webhook_integrations")
      .select("*")
      .eq("user_id", userData.id)
      .eq("is_active", true)
      .eq("include_meta_events", true)
      .not("meta_access_token", "is", null)
      .not("meta_pixel_id", "is", null);

    if (error || !integrations || integrations.length === 0) {
      return; // No hay integraciones de Meta, salir silenciosamente
    }

    // Detectar si se envió el link de booking
    const bookingLinkSent = messageContent.includes(bookingLink);

    // Detectar interés (palabras clave que indican interés)
    const interestKeywords = [
      "interesado",
      "me interesa",
      "quiero",
      "precio",
      "costo",
      "cuánto",
      "información",
      "demo",
      "agendar",
      "cita",
      "reunión",
      "contratar",
      "servicio",
      "producto",
    ];
    const messageLower = messageContent.toLowerCase();
    const hasInterest = interestKeywords.some((keyword) =>
      messageLower.includes(keyword)
    );

    let eventName = null;
    let eventValue = 0;

    // Determinar evento basado en detección
    if (bookingLinkSent) {
      // Si se envió el link, es Schedule (cita agendada)
      eventName = "Schedule";
      eventValue = 100;
      console.log(`[SMS META] 📅 Detected booking link sent → Schedule event`);
    } else if (hasInterest) {
      // Si hay interés pero no se envió link, es CompleteRegistration
      eventName = "CompleteRegistration";
      eventValue = 50;
      console.log(
        `[SMS META] ✅ Detected interest → CompleteRegistration event`
      );
    }

    // Si no hay evento que enviar, salir
    if (!eventName) {
      return;
    }

    // Preparar payload de Meta
    const currentTime = Math.floor(Date.now() / 1000);
    const metaPayload = {
      data: [
        {
          event_name: eventName,
          event_time: currentTime,
          event_id: conversation.id, // ID de la conversación
          action_source: "messaging",
          event_source_url: "https://orquest-ai.com/",
          user_data: {
            // Datos básicos (hasheados)
            ...(leadData.email && leadData.email.trim()
              ? { em: hashEmail(leadData.email) }
              : {}),
            ...(leadData.phone && leadData.phone.trim()
              ? { ph: hashPhone(leadData.phone) }
              : {}),

            // Nombre y apellido (hash) - +15% calidad cada uno
            // first_name viene del campo 'name' en la BD
            ...(leadData.name
              ? { fn: hashEmail(leadData.name.split(" ")[0]) } // Primera palabra del nombre
              : {}),
            ...(leadData.last_name
              ? { ln: hashEmail(leadData.last_name) }
              : {}),

            // Identificador externo: ID de la BD del lead (sin hash) - +28% calidad
            external_id: leadData.id, // UUID del lead en nuestra BD
          },
          custom_data: {
            value: eventValue,
            currency: "USD",
            messaging_channel: "sms",
            conversation_id: conversation.id,
            lead_id: leadData.id,
            event_source: "OrquestAI SMS",
          },
        },
      ],
    };

    // Enviar a cada integración de Meta
    const metaPromises = integrations.map(async (integration) => {
      try {
        const metaUrl = `https://graph.facebook.com/v20.0/${integration.meta_pixel_id}/events?access_token=${integration.meta_access_token}`;

        const response = await fetch(metaUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(metaPayload),
        });

        const responseBody = await response.text();

        if (response.ok) {
          const result = JSON.parse(responseBody);
          console.log(
            `[SMS META] ✅ Event ${eventName} sent to pixel ${integration.meta_pixel_id}:`,
            result
          );
        } else {
          console.error(
            `[SMS META] ❌ Failed to send event to pixel ${integration.meta_pixel_id}:`,
            response.status,
            responseBody
          );
        }
      } catch (err) {
        console.error(
          `[SMS META] ❌ Error sending event to pixel ${integration.meta_pixel_id}:`,
          err.message
        );
      }
    });

    await Promise.allSettled(metaPromises);
  } catch (error) {
    console.error("[SMS META] Error in sendSMSMetaEvents:", error);
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
  const cleanPhone = phone.replace(/\D/g, "");
  return crypto.createHash("sha256").update(cleanPhone).digest("hex");
}

console.log("📱 [SMS] Módulo de SMS cargado exitosamente");

// Función para enviar mensaje desde secuencia (envuelve todo el proceso)
async function sendSequenceMessage(
  supabase,
  userId,
  leadPhone,
  twilioPhoneNumber,
  messageContent,
  leadId,
  enableAi
) {
  try {
    // Normalizar número del lead
    let normalizedLeadPhone = leadPhone
      .replace(/\s+/g, "")
      .replace(/[-\/]/g, "");
    if (!normalizedLeadPhone.startsWith("+")) {
      normalizedLeadPhone = `+${normalizedLeadPhone}`;
    }

    // Enviar mensaje por Twilio
    const statusCallbackUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/message-status`;

    const twilioMessage = await client.messages.create({
      from: twilioPhoneNumber,
      to: normalizedLeadPhone,
      body: messageContent,
      statusCallback: statusCallbackUrl,
    });

    const messageSid = twilioMessage.sid;
    console.log(`[SMS Handler] ✅ Message sent: ${messageSid}`);

    // Obtener o crear conversación
    // Nota: para SMS, toNumber es el número de Twilio y fromNumber es el número del cliente
    const conversation = await getOrCreateConversation(
      supabase,
      normalizedLeadPhone, // fromNumber (cliente)
      twilioPhoneNumber, // toNumber (número de Twilio)
      userId
    );

    // Actualizar lead_id y auto_respond si es necesario
    const updateData = {};
    if (!conversation.lead_id && leadId) {
      updateData.lead_id = leadId;
    }
    if (enableAi && conversation.auto_respond !== true) {
      updateData.auto_respond = true;
    }
    if (Object.keys(updateData).length > 0) {
      await supabase
        .from("sms_conversations")
        .update(updateData)
        .eq("id", conversation.id);
    }

    // Guardar mensaje
    await saveMessage(
      supabase,
      conversation.id,
      normalizedLeadPhone,
      messageContent,
      "outgoing",
      messageSid
    );

    // Actualizar conversación
    await updateConversation(supabase, conversation.id, messageContent);

    return {
      success: true,
      message_sid: messageSid,
      conversation_id: conversation.id,
    };
  } catch (error) {
    console.error(`[SMS Handler] ❌ Error sending sequence message:`, error);
    throw error;
  }
}

// Función para actualizar status de mensajes SMS desde status callback de Twilio
async function updateMessageStatus(supabase, messageSid, messageStatus, errorCode, errorMessage, reply) {
  try {
    // Validar que el status sea uno de los permitidos
    const validStatuses = ["queued", "sending", "sent", "delivered", "undelivered", "failed", "read"];
    if (!validStatuses.includes(messageStatus)) {
      console.warn("⚠️ [SMS STATUS] Status desconocido:", messageStatus);
    }

    // Buscar el mensaje en la BD usando external_message_id (que contiene el MessageSid de Twilio)
    const { data: message, error: findError } = await supabase
      .from("sms_messages")
      .select("id, conversation_id, external_message_id, status")
      .eq("external_message_id", messageSid)
      .single();

    if (findError || !message) {
      console.error("❌ [SMS STATUS] Mensaje no encontrado:", messageSid);
      return reply.code(200).send({
        received: true,
        warning: "Mensaje no encontrado en BD",
      });
    }

    // Preparar datos de actualización
    const updateData = {
      status: messageStatus,
      updated_at: new Date().toISOString(),
    };

    // Si hay error, guardar información del error
    if (errorCode) {
      updateData.error_code = errorCode;
    }
    if (errorMessage) {
      updateData.error_message = errorMessage;
    }

    // Guardar timestamps según el estado
    const now = new Date().toISOString();
    if (messageStatus === "delivered") {
      updateData.delivered_at = now;
    } else if (messageStatus === "read") {
      updateData.read_at = now;
      updateData.delivered_at = now;
    } else if (messageStatus === "failed" || messageStatus === "undelivered") {
      updateData.failed_at = now;
    }

    // Actualizar el mensaje en la BD
    const { error: updateError } = await supabase
      .from("sms_messages")
      .update(updateData)
      .eq("id", message.id);

    if (updateError) {
      console.error("❌ [SMS STATUS] Error actualizando mensaje:", updateError.message);
      return reply.code(500).send({
        received: true,
        error: "Error actualizando mensaje en BD",
        details: updateError.message,
      });
    }

    // Retornar 200 para que Twilio sepa que recibimos el callback correctamente
    return reply.code(200).send({
      received: true,
      messageId: message.id,
      status: messageStatus,
    });
  } catch (error) {
    console.error("❌ [SMS STATUS] Error procesando callback:", error.message);
    return reply.code(500).send({
      received: true,
      error: "Error procesando callback",
    });
  }
}

// Exportar funciones para uso en otros módulos
module.exports = {
  handleSMSMessage,
  getSMSStats,
  closeConversation,
  getConversationHistory,
  cleanupOldConversations,
  getEngagementMetrics,
  validateTwilioWebhook,
  getOrCreateConversation,
  saveMessage,
  updateConversation,
  sendSequenceMessage,
  updateMessageStatus,
};
