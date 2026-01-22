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

// Función para procesar mensajes entrantes de WhatsApp
async function handleWhatsAppMessage(supabase, request, reply) {
  try {
    console.log("📱 [WHATSAPP] Mensaje recibido de WhatsApp");

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

    // Logs de debug removidos para producción

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
          console.error("❌ [WHATSAPP] Error pausando secuencias:", pauseError);
          // No fallar el webhook si hay error pausando secuencias
        }
      }

      // Verificar si la conversación tiene respuesta automática habilitada
      // Si auto_respond es false o null (por defecto null = true), solo guardamos el mensaje
      const shouldAutoRespond = conversation.auto_respond !== false;

      console.log("🤖 [WHATSAPP] Auto-respond configurado:", {
        conversationId: conversation.id,
        auto_respond: conversation.auto_respond,
        shouldAutoRespond: shouldAutoRespond,
      });

      if (!shouldAutoRespond) {
        console.log(
          "⏸️ [WHATSAPP] Respuesta automática desactivada. Mensaje guardado para respuesta manual."
        );
        return reply.code(200).send({
          success: true,
          message:
            "Mensaje recibido y guardado. Respuesta automática desactivada.",
          conversation_id: conversation.id,
          auto_respond: false,
        });
      }

      // Obtener mensajes desde el último que se envió a OpenAI (is_ai_generated = true)
      // para incluir todo el contexto en la generación de la respuesta
      let conversationMessages = [];
      try {
        // Buscar el último mensaje generado por IA para saber desde dónde obtener el historial
        const { data: lastAiMessage } = await supabase
          .from("whatsapp_messages")
          .select("created_at, id")
          .eq("conversation_id", conversation.id)
          .eq("is_ai_generated", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Obtener todos los mensajes desde el último mensaje de IA (o todos si no hay mensajes de IA)
        const messagesQuery = supabase
          .from("whatsapp_messages")
          .select("message_content, direction, created_at, is_ai_generated")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: true });

        if (lastAiMessage) {
          // Obtener mensajes creados después del último mensaje de IA
          messagesQuery.gt("created_at", lastAiMessage.created_at);
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
        // Enviar respuesta por WhatsApp y capturar el sid de Twilio
        const twilioResponse = await sendWhatsAppMessage(
          toNumber,
          fromNumber,
          aiResponse
        );

        // Guardar respuesta de IA en la base de datos con el external_message_id de Twilio
        await saveMessage(
          supabase,
          conversation.id,
          toNumber,
          aiResponse,
          "outgoing",
          twilioResponse?.sid || null,
          true // is_ai_generated = true para mensajes generados por IA
        );

        // Actualizar conversación
        await updateConversation(supabase, conversation.id, aiResponse);

        console.log(
          "✅ [WHATSAPP] Respuesta enviada y guardada exitosamente con external_message_id:",
          twilioResponse?.sid
        );
      } catch (sendError) {
        console.error("❌ [WHATSAPP] Error enviando respuesta:", sendError);

        // Guardar respuesta de IA aunque falle el envío (sin external_message_id porque no se envió)
        await saveMessage(
          supabase,
          conversation.id,
          toNumber,
          aiResponse,
          "outgoing",
          null,
          true // is_ai_generated = true para mensajes generados por IA
        );

        // Actualizar conversación
        await updateConversation(supabase, conversation.id, aiResponse);

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

    // SIEMPRE buscar usuario por twilio_number para contexto
    // El twilio_number es el número de WhatsApp del usuario que recibe los mensajes
    let userData = null;
    if (!userId) {
      try {
        // Normalizar el twilio_number (toNumber) que es el número del usuario
        let normalizedTwilioNumber = toNumber;

        // Remover prefijo "whatsapp:" si existe
        if (normalizedTwilioNumber.startsWith("whatsapp:")) {
          normalizedTwilioNumber = normalizedTwilioNumber.replace(
            "whatsapp:",
            ""
          );
        }

        // Mantener el número completo con código de país
        // Ejemplo: +17862989564 -> 17862989564 (sin el +)
        let normalizedNumberWithoutPlus = normalizedTwilioNumber;
        if (normalizedTwilioNumber.startsWith("+")) {
          normalizedNumberWithoutPlus = normalizedTwilioNumber.substring(1); // Solo remover el +
        }

        // También probar con el + para whatsapp_number
        const normalizedWithPlus = `+${normalizedNumberWithoutPlus}`;

        // Buscar usuario por twilio_number (comparando con whatsapp_number del usuario)
        console.log("🔍 [WHATSAPP] Buscando usuario por twilio_number:", {
          twilioNumber: toNumber,
          normalizedTwilioNumber,
          normalizedNumberWithoutPlus,
          normalizedWithPlus,
        });

        // Buscar por whatsapp_number comparándolo con el twilio_number de la conversación
        const { data: user, error: userError } = await supabase
          .from("users")
          .select(
            `
            id, 
            phone,
            whatsapp_number,
            first_name,
            last_name,
            email,
            available_call_credits,
            created_at
          `
          )
          .or(
            `whatsapp_number.eq.${normalizedNumberWithoutPlus},` +
              `whatsapp_number.eq.${normalizedWithPlus},` +
              `whatsapp_number.eq.${normalizedTwilioNumber},` +
              `whatsapp_number.eq.${toNumber}`
          )
          .single();

        console.log("🔍 [WHATSAPP] Resultado búsqueda:", { user, userError });

        if (user && !userError) {
          userId = user.id;
          userData = user;
          console.log("✅ [WHATSAPP] Usuario encontrado por twilio_number:", {
            userId: user.id,
            name: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
            email: user.email,
            credits: user.available_call_credits || 0,
            phoneNumber: user.phone,
            whatsappNumber: user.whatsapp_number,
            twilioNumber: toNumber,
            normalizedNumber: normalizedNumberWithoutPlus,
          });
        } else {
          console.log(
            "❌ [WHATSAPP] No se encontró usuario para el twilio_number:",
            toNumber
          );
        }
      } catch (userSearchError) {
        console.log(
          "📱 [WHATSAPP] Error buscando usuario por twilio_number:",
          userSearchError.message
        );
        // Continuar sin userId
      }
    } else if (userId && !userData) {
      // Si tenemos userId pero no userData, obtener los datos del usuario
      try {
        const { data: user, error: userError } = await supabase
          .from("users")
          .select(
            `
            id, 
            phone,
            whatsapp_number,
            first_name,
            last_name,
            email,
            available_call_credits,
            created_at
          `
          )
          .eq("id", userId)
          .single();

        if (user && !userError) {
          userData = user;
          console.log(
            "✅ [WHATSAPP] Datos del usuario obtenidos por userId:",
            userData
          );
        }
      } catch (error) {
        console.warn(
          "⚠️ [WHATSAPP] Error obteniendo datos del usuario por userId:",
          error
        );
      }
    }

    // Buscar lead por phone_number (fromNumber - número del cliente que envía el mensaje)
    // IMPORTANTE: Solo buscar leads del usuario asociado a la conversación (user_id)
    // PRIMERO debemos garantizar que tenemos user_id antes de buscar lead_id
    let leadId = null;

    // Solo buscar lead si tenemos un user_id (los leads pertenecen a usuarios)
    if (userId) {
      try {
        // Normalizar el fromNumber (phone_number de la conversación)
        let normalizedFromNumber = fromNumber;

        // Remover prefijo "whatsapp:" si existe
        if (normalizedFromNumber.startsWith("whatsapp:")) {
          normalizedFromNumber = normalizedFromNumber.replace("whatsapp:", "");
        }

        // Mantener el número completo con código de país
        let normalizedNumberWithoutPlus = normalizedFromNumber;
        if (normalizedFromNumber.startsWith("+")) {
          normalizedNumberWithoutPlus = normalizedFromNumber.substring(1);
        }

        const normalizedWithPlus = `+${normalizedNumberWithoutPlus}`;

        console.log(
          "🔍 [WHATSAPP] Buscando lead por phone_number para user_id:",
          {
            fromNumber,
            userId,
            normalizedFromNumber,
            normalizedNumberWithoutPlus,
            normalizedWithPlus,
          }
        );

        // Buscar lead por phone_number y user_id, ordenar por updated_at descendente para obtener el más reciente
        const { data: leads, error: leadError } = await supabase
          .from("leads")
          .select("id, phone, name, updated_at")
          .eq("user_id", userId) // Filtrar por user_id del usuario
          .or(
            `phone.ilike.%${normalizedNumberWithoutPlus}%,` +
              `phone.ilike.%${normalizedWithPlus}%,` +
              `phone.eq.${normalizedNumberWithoutPlus},` +
              `phone.eq.${normalizedWithPlus}`
          )
          .order("updated_at", { ascending: false })
          .limit(1);

        if (leads && leads.length > 0 && !leadError) {
          const lead = leads[0]; // El más reciente por updated_at
          leadId = lead.id;
          console.log("✅ [WHATSAPP] Lead encontrado por phone_number:", {
            leadId: lead.id,
            leadName: lead.name,
            leadPhone: lead.phone,
            userId: userId,
            updatedAt: lead.updated_at,
          });
        } else {
          console.log(
            "❌ [WHATSAPP] No se encontró lead para el phone_number y user_id:",
            {
              phoneNumber: fromNumber,
              userId: userId,
            }
          );
        }
      } catch (leadSearchError) {
        console.log(
          "📱 [WHATSAPP] Error buscando lead por phone_number:",
          leadSearchError.message
        );
        // Continuar sin leadId
      }
    } else {
      console.log(
        "⚠️ [WHATSAPP] No se busca lead porque no hay user_id asociado a la conversación"
      );
    }

    // Si encontramos conversación existente, retornarla con contexto del usuario
    if (existingConversation && !searchError) {
      console.log(
        "📱 [WHATSAPP] Conversación existente encontrada:",
        existingConversation.id
      );

      // PRIMERO: Si la conversación NO tiene user_id pero encontramos un usuario, actualizarla
      // Esto debe hacerse ANTES de buscar lead_id porque los leads pertenecen a usuarios
      let conversationUserId = existingConversation.user_id || userId;

      if (!existingConversation.user_id && userId && userData) {
        console.log(
          "🔄 [WHATSAPP] Actualizando conversación sin user_id con usuario encontrado:",
          {
            conversationId: existingConversation.id,
            userId: userId,
            twilioNumber: toNumber,
            whatsappNumber: userData.whatsapp_number,
          }
        );

        const { error: updateError } = await supabase
          .from("whatsapp_conversations")
          .update({
            user_id: userId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingConversation.id);

        if (updateError) {
          console.error(
            "❌ [WHATSAPP] Error actualizando user_id de conversación:",
            updateError
          );
        } else {
          console.log(
            "✅ [WHATSAPP] Conversación actualizada con user_id:",
            userId
          );
          // Actualizar el objeto de conversación con el nuevo user_id
          existingConversation.user_id = userId;
          conversationUserId = userId;
        }
      }

      // DESPUÉS: Si ahora tenemos user_id en la conversación y no tiene lead_id, buscar lead
      // y actualizar lead_id solo si tenemos user_id garantizado
      if (conversationUserId && !existingConversation.lead_id) {
        // Buscar lead solo si no lo buscamos antes o si necesitamos actualizarlo
        let leadIdToUpdate = leadId;

        // Si no buscamos lead antes porque no había userId, buscarlo ahora
        if (!leadIdToUpdate && conversationUserId) {
          try {
            let normalizedFromNumber = fromNumber;
            if (normalizedFromNumber.startsWith("whatsapp:")) {
              normalizedFromNumber = normalizedFromNumber.replace(
                "whatsapp:",
                ""
              );
            }
            let normalizedNumberWithoutPlus = normalizedFromNumber;
            if (normalizedFromNumber.startsWith("+")) {
              normalizedNumberWithoutPlus = normalizedFromNumber.substring(1);
            }
            const normalizedWithPlus = `+${normalizedNumberWithoutPlus}`;

            const { data: leads, error: leadError } = await supabase
              .from("leads")
              .select("id, phone, name, updated_at")
              .eq("user_id", conversationUserId) // Usar el user_id de la conversación
              .or(
                `phone.ilike.%${normalizedNumberWithoutPlus}%,` +
                  `phone.ilike.%${normalizedWithPlus}%,` +
                  `phone.eq.${normalizedNumberWithoutPlus},` +
                  `phone.eq.${normalizedWithPlus}`
              )
              .order("updated_at", { ascending: false })
              .limit(1);

            if (leads && leads.length > 0 && !leadError) {
              leadIdToUpdate = leads[0].id;
              console.log(
                "✅ [WHATSAPP] Lead encontrado para conversación existente:",
                leadIdToUpdate
              );
            }
          } catch (error) {
            console.warn(
              "⚠️ [WHATSAPP] Error buscando lead para conversación existente:",
              error
            );
          }
        }

        // Actualizar lead_id si lo encontramos
        if (leadIdToUpdate) {
          console.log(
            "🔄 [WHATSAPP] Actualizando conversación sin lead_id con lead encontrado:",
            {
              conversationId: existingConversation.id,
              leadId: leadIdToUpdate,
              userId: conversationUserId,
              phoneNumber: fromNumber,
            }
          );

          const { error: updateLeadError } = await supabase
            .from("whatsapp_conversations")
            .update({
              lead_id: leadIdToUpdate,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingConversation.id);

          if (updateLeadError) {
            console.error(
              "❌ [WHATSAPP] Error actualizando lead_id de conversación:",
              updateLeadError
            );
          } else {
            console.log(
              "✅ [WHATSAPP] Conversación actualizada con lead_id:",
              leadIdToUpdate
            );
            // Actualizar el objeto de conversación con el nuevo lead_id
            existingConversation.lead_id = leadIdToUpdate;
          }
        }
      }

      // Agregar contexto del usuario a la conversación
      if (userData) {
        existingConversation.userContext = userData;
      }
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
        auto_respond: true, // Por defecto, respuesta automática habilitada
        lead_id: leadId, // Incluir lead_id si se encontró
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createError) {
      throw new Error(`Error creando conversación: ${createError.message}`);
    }

    console.log("📱 [WHATSAPP] Nueva conversación creada:", {
      conversationId: newConversation.id,
      userId: userId || "null",
      leadId: leadId || "null",
      phoneNumber: fromNumber,
    });

    // Agregar contexto del usuario a la nueva conversación
    if (userData) {
      newConversation.userContext = userData;
    }

    return newConversation;
  } catch (error) {
    console.error("❌ [WHATSAPP] Error en getOrCreateConversation:", error);
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

    // Obtener datos del usuario (necesario para eventos de Meta)
    let userData = null;
    if (conversation.user_id) {
      try {
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, email, first_name, last_name")
          .eq("id", conversation.user_id)
          .single();

        if (user && !userError) {
          userData = user;
        }
      } catch (error) {
        console.warn("⚠️ [OPENAI] Error obteniendo datos del usuario:", error);
      }
    }

    // Obtener datos del LEAD con el que se está generando la conversación
    let leadData = null;
    let leadContext = "";

    // Buscar datos del lead usando lead_id de la conversación
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

    // Generar contexto del lead si tenemos datos
    if (leadData) {
      const leadName = leadData.name || "Cliente";
      const leadCreatedDate = leadData.created_at
        ? new Date(leadData.created_at).toLocaleDateString("es-ES")
        : "No disponible";

      leadContext = `
CONTEXTO DEL CLIENTE (LEAD):
- Nombre: ${leadName}
- Email: ${leadData.email || "No disponible"}
- Teléfono: ${leadData.phone || "No disponible"}
- Origen: ${leadData.source || "No especificado"}
- Notas: ${leadData.notes || "Sin notas"}
- Fecha de creación: ${leadCreatedDate}

IMPORTANTE: Usa SIEMPRE el nombre real del cliente (${leadName}) y sus datos específicos para personalizar la conversación. Este es el lead/prospecto con el que estás conversando por WhatsApp.
`.trim();
    } else {
      // Si no hay lead, usar información básica del número de teléfono
      leadContext = `
CONTEXTO DEL CLIENTE:
- No hay información adicional del cliente disponible en este momento.
- Estás conversando con alguien que se contactó por WhatsApp.

IMPORTANTE: Mantén un tono profesional y busca conocer al cliente, su nombre, y sus necesidades para poder ayudarle mejor.
`.trim();
    }

    console.log("🔍 [OPENAI] Contexto del lead:", leadContext);
    // Instrucciones "system/developer" persistentes
    let instructions = `
Eres el asistente virtual de OrquestAI atendiendo conversaciones por WhatsApp.
OBJETIVO: convertir interés en una demo agendada de 30 min (CTA principal), sin sonar insistente.

ESTILO:
- Responde en 1–3 frases.
- Máximo 1 pregunta por mensaje.
- Tono profesional, claro y cercano.
- No expliques detalles técnicos (APIs, Twilio, webhooks, arquitectura, etc.).
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
- Si el cliente quiere hablar con un representante, especialista, persona, humano, agente, ejecutivo, asesor, o dice que no eres una persona real: DEBES usar la función handleRepresentativeRequest inmediatamente. Después, usa notifyAgentSpecialistRequest para notificar al agente por SMS. No respondas directamente, usa las funciones.
- Usa el nombre de la persona en tus respuestas cuando esté disponible en el contexto. Personaliza el saludo y las respuestas incluyendo su nombre cuando sea apropiado.
- Si hay nombre del lead en el contexto, úsalo en el saludo inicial: "Hola [nombre]! 👋". Si no hay nombre, usa "Hola! 👋".
`.trim();

    // Agregar contexto del lead/cliente si está disponible
    if (leadContext) {
      instructions += `\n\n${leadContext}\n\nIMPORTANTE: Usa el nombre del cliente y sus datos específicos para personalizar la conversación.`;
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
          description: "Usar cuando el cliente quiere hablar con un representante, especialista, persona, humano, agente, ejecutivo, asesor, o dice que no eres una persona real. Esta función debe usarse inmediatamente cuando se detecte esta intención.",
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
      /*
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

    // Logs de debug removidos para producción

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

    // Procesar tools si el modelo los usó
    let finalResponse =
      r.output_text ||
      (Array.isArray(r.output) && r.output[0]?.content?.[0]?.text) ||
      "Disculpa, ¿podrías repetir tu consulta?";

    // Si el modelo usó tools, ejecutarlas y generar respuesta final
    if (r.tool_calls && r.tool_calls.length > 0) {
      console.log(
        "🔧 [TOOLS] Modelo solicitó usar tools:",
        r.tool_calls.length
      );

      const toolResults = [];
      let finalR = null; // Declarar fuera del bloque para poder usarlo después

      for (const toolCall of r.tool_calls) {
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

          let result;
          
          // Ejecutar la función correspondiente
          if (functionName === "handleRepresentativeRequest") {
            result = await tools.handleRepresentativeRequest(supabase, BOOKING_LINK);
            // Si es solicitud de representante, usar directamente el mensaje
            if (result.success && result.data) {
              finalResponse = result.data.mensaje;
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
          
          console.log(`✅ [TOOL] Resultado de ${functionName}:`, JSON.stringify(result, null, 2));
          console.log("=".repeat(80));
          
          // Agregar resultado a toolResults (importante para que OpenAI pueda procesarlo)
          toolResults.push({
            tool_call_id: toolCall.id,
            function_name: functionName,
            result: result,
          });
          
          // Si es handleRepresentativeRequest y fue exitoso, ya tenemos la respuesta final
          // No necesitamos generar otra respuesta, pero sí agregamos el resultado para logging
          if (functionName === "handleRepresentativeRequest" && result.success && result.data) {
            console.log("👤 [REPRESENTATIVE] Respuesta final establecida, no se generará respuesta adicional");
          }
        } catch (error) {
          console.error("=".repeat(80));
          console.error(`❌ [TOOL] ═══ ERROR EJECUTANDO TOOL ═══`);
          console.error("=".repeat(80));
          console.error(`❌ [TOOL] Error ejecutando tool:`, error);
          console.error(`❌ [TOOL] Error stack:`, error.stack);
          console.error(`❌ [TOOL] Tool call que falló:`, JSON.stringify(toolCall, null, 2));
          console.error("=".repeat(80));
          
          toolResults.push({
            tool_call_id: toolCall.id,
            function_name: toolCall.function?.name || "unknown",
            result: { success: false, error: error.message },
          });
        }
      }

      // Si handleRepresentativeRequest fue llamada, ya tenemos la respuesta final
      const representativeCalled = toolResults.some(
        (tr) => tr.function_name === "handleRepresentativeRequest" && tr.result.success
      );
      
      // Siempre necesitamos enviar los tool_outputs de vuelta a OpenAI cuando hay tool_calls
      if (toolResults.length > 0) {
        // Preparar tool_outputs en el formato que OpenAI espera
        const toolOutputs = toolResults.map((tr) => ({
          tool_call_id: tr.tool_call_id,
          output: JSON.stringify(tr.result),
        }));

        console.log("📤 [OPENAI] Enviando tool_outputs a OpenAI:", JSON.stringify(toolOutputs, null, 2));

        // Generar respuesta final con los resultados de las tools
        const finalReq = {
          model: modelName,
          previous_response_id: r.id, // Usar el id del response que tiene los tool_calls
          tool_outputs: toolOutputs, // Enviar los resultados de las tools
          temperature: 0.7,
        };

        try {
          finalR = await openai.responses.create(finalReq);
          console.log("✅ [OPENAI] Respuesta final recibida:", JSON.stringify(finalR, null, 2));
          
          // Si no es representante, usar la respuesta generada por OpenAI
          if (!representativeCalled) {
            finalResponse =
              finalR.output_text ||
              (Array.isArray(finalR.output) &&
                finalR.output[0]?.content?.[0]?.text) ||
              finalResponse;
          }
          // Si es representante, ya tenemos finalResponse establecido, solo actualizar r para el id
          // pero mantener finalResponse como está
        } catch (finalError) {
          console.error("❌ [OPENAI] Error en segunda llamada con tool_outputs:", finalError);
          // Si falla y es representante, ya tenemos finalResponse, continuar
          // Si no es representante, usar el fallback
          if (!representativeCalled) {
            throw finalError; // Re-lanzar para que se maneje en el catch principal
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
        .from("whatsapp_conversations")
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
    if (leadData) {
      console.log(
        "👤 [LEAD] Respuesta personalizada para lead:",
        leadData.name || "Cliente"
      );
    }

    // 🆕 Detectar eventos para Meta y enviarlos
    // Ejecutar de forma asíncrona para no bloquear la respuesta
    setImmediate(async () => {
      try {
        await sendWhatsAppMetaEvents(
          supabase,
          finalResponse,
          conversation,
          leadData,
          userData,
          BOOKING_LINK
        );
      } catch (metaError) {
        console.error(
          "❌ [WHATSAPP META] Error sending Meta events:",
          metaError
        );
      }
    });

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

// Función para enviar mensaje por WhatsApp
async function sendWhatsAppMessage(toNumber, fromNumber, message) {
  try {
    console.log("📤 [WHATSAPP] Enviando mensaje a:", fromNumber);

    const statusCallbackUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/message-status`;

    const response = await client.messages.create({
      body: message,
      from: `whatsapp:${toNumber}`,
      to: `whatsapp:${fromNumber}`,
      statusCallback: statusCallbackUrl,
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
  externalId,
  isAiGenerated = false
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
        is_ai_generated: isAiGenerated,
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
    // Primero obtener el conteo actual de mensajes
    const { data: currentConversation, error: fetchError } = await supabase
      .from("whatsapp_conversations")
      .select("message_count")
      .eq("id", conversationId)
      .single();

    if (fetchError) {
      throw new Error(`Error obteniendo conversación: ${fetchError.message}`);
    }

    const newMessageCount = (currentConversation?.message_count || 0) + 1;

    const { error: updateError } = await supabase
      .from("whatsapp_conversations")
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

// Función para enviar template predeterminado a un nuevo lead
async function sendDefaultTemplateToNewLead(supabase, userId, leadData) {
  console.log(
    "🚀 [WHATSAPP] ===== INICIANDO sendDefaultTemplateToNewLead ====="
  );
  console.log("📥 [WHATSAPP] Parámetros recibidos:", {
    userId,
    leadId: leadData?.id,
    leadName: leadData?.name,
    leadPhone: leadData?.phone,
    leadEmail: leadData?.email,
  });
  try {
    console.log(
      "📱 [WHATSAPP] Verificando envío de template predeterminado para nuevo lead:",
      {
        userId,
        leadId: leadData?.id,
        leadName: leadData?.name,
        leadPhone: leadData?.phone,
      }
    );

    // 1. Verificar que el usuario tenga whatsapp_number configurado
    console.log("🔍 [WHATSAPP] Paso 1: Buscando usuario en BD...");
    console.log(
      "🔍 [WHATSAPP] Query: SELECT id, whatsapp_number, first_name, last_name FROM users WHERE id =",
      userId
    );
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id, whatsapp_number, first_name, last_name")
      .eq("id", userId)
      .single();

    console.log("🔍 [WHATSAPP] Resultado de búsqueda de usuario:", {
      hasData: !!userData,
      hasError: !!userError,
      error: userError,
      userData: userData
        ? {
            id: userData.id,
            hasWhatsAppNumber: !!userData.whatsapp_number,
            whatsappNumber: userData.whatsapp_number
              ? "***configurado***"
              : null,
          }
        : null,
    });

    if (userError || !userData) {
      console.log(
        "⚠️ [WHATSAPP] Usuario no encontrado, saltando envío de template"
      );
      console.log("⚠️ [WHATSAPP] Error details:", userError);
      return { success: false, reason: "user_not_found" };
    }

    console.log("✅ [WHATSAPP] Usuario encontrado:", userData.id);

    if (!userData.whatsapp_number) {
      console.log(
        "⚠️ [WHATSAPP] Usuario sin whatsapp_number configurado, saltando envío de template"
      );
      console.log(
        "⚠️ [WHATSAPP] userData.whatsapp_number:",
        userData.whatsapp_number
      );
      return { success: false, reason: "no_whatsapp_number" };
    }

    console.log("✅ [WHATSAPP] Usuario tiene whatsapp_number configurado");

    // 2. Buscar template predeterminado para nuevos leads
    console.log("🔍 [WHATSAPP] Paso 2: Buscando template predeterminado...");
    console.log(
      "🔍 [WHATSAPP] Query: SELECT * FROM whatsapp_templates WHERE user_id =",
      userId,
      "AND is_default_for_new_leads = true AND is_active = true"
    );
    const { data: defaultTemplate, error: templateError } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("user_id", userId)
      .eq("is_default_for_new_leads", true)
      .eq("is_active", true)
      .maybeSingle();

    console.log("🔍 [WHATSAPP] Resultado de búsqueda de template:", {
      hasTemplate: !!defaultTemplate,
      hasError: !!templateError,
      error: templateError,
      templateId: defaultTemplate?.id,
      templateName: defaultTemplate?.["Template name"],
    });

    if (templateError) {
      console.error(
        "❌ [WHATSAPP] Error buscando template predeterminado:",
        templateError
      );
      return {
        success: false,
        reason: "template_search_error",
        error: templateError,
      };
    }

    if (!defaultTemplate) {
      console.log(
        "⚠️ [WHATSAPP] No hay template predeterminado configurado para este usuario"
      );
      return { success: false, reason: "no_default_template" };
    }

    console.log(
      "✅ [WHATSAPP] Template predeterminado encontrado:",
      defaultTemplate["Template name"]
    );
    console.log("📋 [WHATSAPP] Detalles del template:", {
      id: defaultTemplate.id,
      name: defaultTemplate["Template name"],
      contentSid: defaultTemplate["Content template SID"],
      description: defaultTemplate.description,
    });

    // 3. Validar y normalizar número de teléfono del lead
    console.log(
      "🔍 [WHATSAPP] Paso 3: Validando y normalizando número de teléfono..."
    );
    console.log("🔍 [WHATSAPP] leadData.phone:", leadData.phone);

    if (!leadData.phone) {
      console.log(
        "⚠️ [WHATSAPP] El lead no tiene número de teléfono, saltando envío de template"
      );
      return { success: false, reason: "no_phone_number" };
    }

    console.log("🔍 [WHATSAPP] Normalizando teléfono del lead...");
    let normalizedPhone = leadData.phone
      .replace(/\s+/g, "")
      .replace(/[-\/]/g, "")
      .replace(/^whatsapp:/, "")
      .replace(/^\+/, "");
    const withPlusPhone = `+${normalizedPhone}`;
    console.log("✅ [WHATSAPP] Teléfono normalizado:", {
      original: leadData.phone,
      normalized: normalizedPhone,
      withPlus: withPlusPhone,
    });

    // 4. Obtener número de WhatsApp del usuario (twilio_number o whatsapp_number)
    console.log(
      "🔍 [WHATSAPP] Paso 4: Normalizando número de WhatsApp del usuario..."
    );
    console.log(
      "🔍 [WHATSAPP] userData.whatsapp_number:",
      userData.whatsapp_number
    );
    let twilioWhatsAppNumber = (userData.whatsapp_number || "").trim();

    if (twilioWhatsAppNumber.startsWith("whatsapp:")) {
      twilioWhatsAppNumber = twilioWhatsAppNumber.replace("whatsapp:", "");
    }

    if (!twilioWhatsAppNumber.startsWith("+")) {
      twilioWhatsAppNumber = `+${twilioWhatsAppNumber.replace(/^\+/, "")}`;
    }

    console.log("✅ [WHATSAPP] Número de WhatsApp del usuario normalizado:", {
      original: userData.whatsapp_number,
      normalized: twilioWhatsAppNumber,
    });

    // 5. Inicializar cliente de Twilio
    console.log("🔍 [WHATSAPP] Paso 5: Inicializando cliente de Twilio...");
    console.log(
      "🔍 [WHATSAPP] accountSid:",
      accountSid ? "***configurado***" : "NO CONFIGURADO"
    );
    console.log(
      "🔍 [WHATSAPP] authToken:",
      authToken ? "***configurado***" : "NO CONFIGURADO"
    );
    const twilioClient = twilio(accountSid, authToken);
    console.log("✅ [WHATSAPP] Cliente de Twilio inicializado");

    // 6. Formatear números para WhatsApp
    console.log("🔍 [WHATSAPP] Paso 6: Formateando números para WhatsApp...");
    const fromNumber = `whatsapp:${twilioWhatsAppNumber}`;
    const toNumber = `whatsapp:${withPlusPhone}`;
    console.log("✅ [WHATSAPP] Números formateados:", {
      from: fromNumber,
      to: toNumber,
    });

    // 7. Construir contentVariables para el template
    console.log(
      "🔍 [WHATSAPP] Paso 7: Construyendo contentVariables para el template..."
    );
    const contentVariables = {
      1: leadData.name || "Cliente",
    };

    if (leadData.phone) {
      contentVariables["2"] = leadData.phone;
    }

    if (leadData.email) {
      contentVariables["3"] = leadData.email;
    }

    console.log(
      "✅ [WHATSAPP] Variables del template construidas:",
      contentVariables
    );

    // 8. Enviar mensaje con template usando Twilio
    console.log(
      "🚀 [WHATSAPP] ===== ENVIANDO TEMPLATE PREDETERMINADO A NUEVO LEAD ====="
    );
    console.log(
      "📋 [WHATSAPP] Template Name:",
      defaultTemplate["Template name"]
    );
    console.log(
      "🆔 [WHATSAPP] Content SID:",
      defaultTemplate["Content template SID"]
    );
    console.log("📱 [WHATSAPP] From:", fromNumber);
    console.log("📱 [WHATSAPP] To:", toNumber);
    console.log(
      "📝 [WHATSAPP] Content Variables:",
      JSON.stringify(contentVariables)
    );

    let twilioMessage;
    try {
      console.log("🔍 [WHATSAPP] Paso 8: Enviando mensaje a Twilio...");
      console.log("🔍 [WHATSAPP] Payload para Twilio:", {
        from: fromNumber,
        to: toNumber,
        contentSid: defaultTemplate["Content template SID"],
        contentVariables: JSON.stringify(contentVariables),
      });
      const statusCallbackUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/message-status`;

      twilioMessage = await twilioClient.messages.create({
        from: fromNumber,
        to: toNumber,
        contentSid: defaultTemplate["Content template SID"],
        contentVariables: JSON.stringify(contentVariables), // Twilio requiere string JSON
        statusCallback: statusCallbackUrl,
      });
      console.log("🔍 [WHATSAPP] Respuesta de Twilio recibida:", {
        sid: twilioMessage.sid,
        status: twilioMessage.status,
        dateCreated: twilioMessage.dateCreated,
      });

      console.log(
        "✅ [WHATSAPP] Template enviado exitosamente:",
        twilioMessage.sid
      );

      // 9. Buscar o crear conversación
      console.log("🔍 [WHATSAPP] Paso 9: Buscando o creando conversación...");
      console.log("🔍 [WHATSAPP] Parámetros para getOrCreateConversation:", {
        phoneNumber: withPlusPhone,
        twilioNumber: twilioWhatsAppNumber,
        userId: userId,
      });
      const conversation = await getOrCreateConversation(
        supabase,
        withPlusPhone,
        twilioWhatsAppNumber,
        userId
      );
      console.log("✅ [WHATSAPP] Conversación obtenida/creada:", {
        conversationId: conversation.id,
        leadId: conversation.lead_id,
        autoRespond: conversation.auto_respond,
      });

      // 10. Actualizar lead_id y auto_respond en la conversación
      console.log("🔍 [WHATSAPP] Paso 10: Actualizando conversación...");
      // Para templates predeterminados, activar auto_respond (IA encendida)
      const updateData = {};
      if (!conversation.lead_id && leadData.id) {
        updateData.lead_id = leadData.id;
      }
      // Activar auto_respond para que la IA responda automáticamente
      updateData.auto_respond = true;
      updateData.updated_at = new Date().toISOString();

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from("whatsapp_conversations")
          .update(updateData)
          .eq("id", conversation.id);

        // Actualizar el objeto de conversación localmente
        Object.assign(conversation, updateData);

        console.log("✅ [WHATSAPP] Conversación actualizada:", {
          conversationId: conversation.id,
          lead_id: updateData.lead_id || conversation.lead_id,
          auto_respond: true,
        });
      }

      // 11. Guardar mensaje en la base de datos
      console.log("🔍 [WHATSAPP] Paso 11: Guardando mensaje en BD...");
      // Usar la descripción del template si existe, sino el nombre del template
      const messageContent =
        defaultTemplate.description ||
        defaultTemplate["Template name"] ||
        "Template enviado";
      console.log(
        "🔍 [WHATSAPP] Contenido del mensaje a guardar:",
        messageContent
      );

      const { data: savedMessage, error: saveError } = await supabase
        .from("whatsapp_messages")
        .insert({
          conversation_id: conversation.id,
          phone_number: withPlusPhone,
          message_content: messageContent,
          direction: "outgoing",
          external_message_id: twilioMessage.sid,
          template_id: defaultTemplate.id,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      console.log("🔍 [WHATSAPP] Resultado de guardar mensaje:", {
        hasData: !!savedMessage,
        hasError: !!saveError,
        error: saveError,
        messageId: savedMessage?.id,
      });

      if (saveError) {
        console.error(
          "⚠️ [WHATSAPP] Error guardando mensaje en BD (mensaje enviado):",
          saveError
        );
      } else {
        console.log("✅ [WHATSAPP] Mensaje guardado en BD:", savedMessage.id);
      }

      // 12. Actualizar message_count y last_message_at en la conversación
      console.log(
        "🔍 [WHATSAPP] Paso 12: Actualizando message_count y last_message_at..."
      );
      const { error: updateError } = await supabase
        .from("whatsapp_conversations")
        .update({
          message_count: (conversation.message_count || 0) + 1,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversation.id);

      if (updateError) {
        console.error(
          "⚠️ [WHATSAPP] Error actualizando message_count:",
          updateError
        );
      } else {
        console.log("✅ [WHATSAPP] message_count actualizado");
      }

      console.log(
        "✅ [WHATSAPP] ===== TEMPLATE PREDETERMINADO ENVIADO EXITOSAMENTE ====="
      );
      console.log("✅ [WHATSAPP] Resumen final:", {
        success: true,
        message_sid: twilioMessage.sid,
        conversation_id: conversation.id,
        template_id: defaultTemplate.id,
        lead_id: leadData.id,
      });

      return {
        success: true,
        message_sid: twilioMessage.sid,
        conversation_id: conversation.id,
        template_id: defaultTemplate.id,
      };
    } catch (twilioError) {
      console.error("❌ [WHATSAPP] ===== ERROR ENVIANDO TEMPLATE =====");
      console.error("❌ [WHATSAPP] Error Code:", twilioError.code);
      console.error("❌ [WHATSAPP] Error Message:", twilioError.message);
      console.error(
        "❌ [WHATSAPP] Error Details:",
        twilioError.details || "Sin detalles"
      );

      // No crear conversación ni guardar mensaje si falló el envío
      return {
        success: false,
        reason: "twilio_error",
        error_code: twilioError.code,
        error_message: twilioError.message,
      };
    }
  } catch (error) {
    console.error(
      "❌ [WHATSAPP] ===== ERROR GENERAL EN sendDefaultTemplateToNewLead ====="
    );
    console.error("❌ [WHATSAPP] Error:", error);
    console.error("❌ [WHATSAPP] Error message:", error?.message);
    console.error("❌ [WHATSAPP] Error stack:", error?.stack);
    console.error("❌ [WHATSAPP] Error name:", error?.name);
    return {
      success: false,
      reason: "unexpected_error",
      error: error.message,
    };
  }
}

// 🆕 Función para enviar eventos a Meta desde WhatsApp
async function sendWhatsAppMetaEvents(
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
      console.log(
        `[WHATSAPP META] 📅 Detected booking link sent → Schedule event`
      );
    } else if (hasInterest) {
      // Si hay interés pero no se envió link, es CompleteRegistration
      eventName = "CompleteRegistration";
      eventValue = 50;
      console.log(
        `[WHATSAPP META] ✅ Detected interest → CompleteRegistration event`
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
            messaging_channel: "whatsapp",
            conversation_id: conversation.id,
            lead_id: leadData.id,
            event_source: "OrquestAI WhatsApp",
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
            `[WHATSAPP META] ✅ Event ${eventName} sent to pixel ${integration.meta_pixel_id}:`,
            result
          );
        } else {
          console.error(
            `[WHATSAPP META] ❌ Failed to send event to pixel ${integration.meta_pixel_id}:`,
            response.status,
            responseBody
          );
        }
      } catch (err) {
        console.error(
          `[WHATSAPP META] ❌ Error sending event to pixel ${integration.meta_pixel_id}:`,
          err.message
        );
      }
    });

    await Promise.allSettled(metaPromises);
  } catch (error) {
    console.error("[WHATSAPP META] Error in sendWhatsAppMetaEvents:", error);
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

console.log("📱 [WHATSAPP] Módulo de WhatsApp cargado exitosamente");

// Función para enviar mensaje desde secuencia (envuelve todo el proceso)
async function sendSequenceMessage(
  supabase,
  userId,
  leadPhone,
  userWhatsAppNumber,
  messageContent,
  templateId,
  contentSid,
  contentVariables,
  leadId,
  enableAi
) {
  try {
    // Normalizar números
    let normalizedLeadPhone = leadPhone
      .replace(/\s+/g, "")
      .replace(/[-\/]/g, "");
    if (!normalizedLeadPhone.startsWith("+")) {
      normalizedLeadPhone = `+${normalizedLeadPhone}`;
    }
    normalizedLeadPhone = normalizedLeadPhone.replace(/^whatsapp:/, "");

    let normalizedUserWhatsApp = userWhatsAppNumber;
    if (normalizedUserWhatsApp.startsWith("whatsapp:")) {
      normalizedUserWhatsApp = normalizedUserWhatsApp.replace(/^whatsapp:/, "");
    }
    if (!normalizedUserWhatsApp.startsWith("+")) {
      normalizedUserWhatsApp = `+${normalizedUserWhatsApp}`;
    }

    const fromNumber = `whatsapp:${normalizedUserWhatsApp}`;
    const toNumber = `whatsapp:${normalizedLeadPhone}`;

    // Enviar mensaje por Twilio
    let twilioMessage;
    const statusCallbackUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/message-status`;
    
    if (contentSid) {
      // Template de Meta - SIEMPRE enviar como template, nunca como free form
      twilioMessage = await client.messages.create({
        from: fromNumber,
        to: toNumber,
        contentSid: contentSid,
        contentVariables: JSON.stringify(contentVariables),
        statusCallback: statusCallbackUrl,
      });
    } else {
      // Mensaje regular (free form)
      twilioMessage = await client.messages.create({
        from: fromNumber,
        to: toNumber,
        body: messageContent,
        statusCallback: statusCallbackUrl,
      });
    }

    const messageSid = twilioMessage.sid;
    console.log(`[WHATSAPP Handler] ✅ Message sent: ${messageSid}`);

    // Obtener o crear conversación
    const conversation = await getOrCreateConversation(
      supabase,
      normalizedLeadPhone,
      normalizedUserWhatsApp,
      userId
    );

    // Actualizar lead_id y auto_respond si es necesario
    const updateData = {};
    if (!conversation.lead_id && leadId) {
      updateData.lead_id = leadId;
    }
    if (enableAi && !conversation.auto_respond) {
      updateData.auto_respond = true;
    }
    if (Object.keys(updateData).length > 0) {
      await supabase
        .from("whatsapp_conversations")
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
      messageSid,
      false
    );

    // Si hay template_id, actualizarlo en el mensaje guardado
    if (templateId) {
      await supabase
        .from("whatsapp_messages")
        .update({ template_id: templateId })
        .eq("external_message_id", messageSid);
    }

    // Actualizar conversación
    await updateConversation(supabase, conversation.id, messageContent);

    return {
      success: true,
      message_sid: messageSid,
      conversation_id: conversation.id,
    };
  } catch (error) {
    console.error(
      `[WHATSAPP Handler] ❌ Error sending sequence message:`,
      error
    );
    throw error;
  }
}

// Función para actualizar status de mensajes WhatsApp desde status callback de Twilio
async function updateMessageStatus(supabase, messageSid, messageStatus, errorCode, errorMessage, reply) {
  const timestamp = new Date().toISOString();
  try {
    console.log("📱 [WHATSAPP STATUS] ═══ Procesando callback WhatsApp ═══");
    console.log("📱 [WHATSAPP STATUS] Message SID:", messageSid);
    console.log("📱 [WHATSAPP STATUS] Status:", messageStatus);
    console.log("📱 [WHATSAPP STATUS] Timestamp:", timestamp);
    if (errorCode) {
      console.log("📱 [WHATSAPP STATUS] Error Code:", errorCode);
    }
    if (errorMessage) {
      console.log("📱 [WHATSAPP STATUS] Error Message:", errorMessage);
    }

    // Validar que el status sea uno de los permitidos
    const validStatuses = ["queued", "sending", "sent", "delivered", "undelivered", "failed", "read"];
    if (!validStatuses.includes(messageStatus)) {
      console.warn("⚠️ [WHATSAPP STATUS] ⚠️ Status desconocido:", messageStatus);
    }

    // Buscar el mensaje en la BD usando external_message_id (que contiene el MessageSid de Twilio)
    console.log("🔍 [WHATSAPP STATUS] Buscando mensaje en BD con MessageSid:", messageSid);
    const { data: message, error: findError } = await supabase
      .from("whatsapp_messages")
      .select("id, conversation_id, external_message_id, status")
      .eq("external_message_id", messageSid)
      .single();

    if (findError || !message) {
      console.error("❌ [WHATSAPP STATUS] ⚠️ Mensaje NO encontrado en BD");
      console.error("❌ [WHATSAPP STATUS] MessageSid:", messageSid);
      console.error("❌ [WHATSAPP STATUS] Error:", findError?.message || "No se encontró registro");
      // No retornar error 404 porque Twilio seguirá intentando
      // Simplemente registrar el error y retornar 200 para que Twilio no reintente
      return reply.code(200).send({
        received: true,
        warning: "Mensaje no encontrado en BD",
      });
    }

    console.log("✅ [WHATSAPP STATUS] Mensaje encontrado en BD:");
    console.log("   • ID:", message.id);
    console.log("   • Conversation ID:", message.conversation_id);
    console.log("   • Status actual:", message.status);
    console.log("   • Nuevo status:", messageStatus);

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
      // Si se marca como leído, también marcar como entregado
      updateData.delivered_at = now;
    } else if (messageStatus === "failed" || messageStatus === "undelivered") {
      updateData.failed_at = now;
    }

    console.log("💾 [WHATSAPP STATUS] Datos de actualización:", JSON.stringify(updateData, null, 2));

    // Actualizar el mensaje en la BD
    const { error: updateError } = await supabase
      .from("whatsapp_messages")
      .update(updateData)
      .eq("id", message.id);

    if (updateError) {
      console.error("❌ [WHATSAPP STATUS] ⚠️ ERROR actualizando mensaje en BD");
      console.error("❌ [WHATSAPP STATUS] Error:", updateError);
      console.error("❌ [WHATSAPP STATUS] Message ID:", message.id);
      return reply.code(500).send({
        received: true,
        error: "Error actualizando mensaje en BD",
        details: updateError.message,
      });
    }

    console.log("✅ [WHATSAPP STATUS] ✅ Mensaje actualizado exitosamente en BD");
    console.log("✅ [WHATSAPP STATUS] Status cambiado de '", message.status, "' a '", messageStatus, "'");

    // Retornar 200 para que Twilio sepa que recibimos el callback correctamente
    return reply.code(200).send({
      received: true,
      messageId: message.id,
      status: messageStatus,
    });
  } catch (error) {
    console.error("❌ [WHATSAPP STATUS] Error procesando status callback:", error);
    return reply.code(500).send({
      received: true,
      error: "Error procesando callback",
    });
  }
}

// Exportar funciones para uso en otros módulos
module.exports = {
  handleWhatsAppMessage,
  getWhatsAppStats,
  closeConversation,
  getConversationHistory,
  cleanupOldConversations,
  getEngagementMetrics,
  validateTwilioWebhook,
  sendDefaultTemplateToNewLead,
  getOrCreateConversation,
  saveMessage,
  updateConversation,
  sendSequenceMessage,
  updateMessageStatus,
};
