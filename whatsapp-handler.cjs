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

      // Generar respuesta con OpenAI (solo si auto_respond está habilitado)
      const aiResponse = await generateAIResponse(
        supabase,
        messageBody,
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
          twilioResponse?.sid || null
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
          null
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
    const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // Importar tools
    const tools = require("./whatsapp-tools.cjs");

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
Eres el asistente virtual de OrquestAI atendiendo conversaciones por WhatsApp. Mantén siempre un tono profesional, claro y cercano. Responde de forma breve (1 a 3 frases máximo) y enfocado en ser útil, escuchando primero y resolviendo las dudas del cliente antes de avanzar.

Al presentarte por primera vez, di: "Hola [nombre]! 👋 Soy el asistente virtual de OrquestAI. ¿En qué te puedo ayudar hoy?". Nunca digas "Soy OrquestAI" o "Soy OrquestAI, el asistente virtual de OrquestAI", solo di "Soy el asistente virtual de OrquestAI".

Tu objetivo es calificar el interés, pedir su email y disponibilidad, y luego proponer una demo de manera natural, solo cuando el cliente muestre interés o después de algunas interacciones. La prioridad es generar confianza y dar claridad antes de invitar a la acción.

No des precios específicos: en su lugar, ofrece enviar una propuesta personalizada. Usa siempre el contexto disponible del cliente/lead (nombre, email, teléfono, origen, notas, etc.) y nunca inventes nombres ni datos; si no tienes la información, indica que verificarás el dato.

Si el cliente pide hablar con un humano (usando palabras como "agente", "humano" o similares), ofrece el handoff respondiendo: "¿Te conecto ahora con un asesor?".

Mantén el ritmo de la conversación con paciencia, brindando confianza primero y guiando de forma progresiva hacia acciones concretas como recibir más información, compartir datos de contacto o agendar una demo.
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

    // Logs de debug removidos para producción

    const r = await openai.responses.create(req);

    // Procesar tools si el modelo los usó
    let finalResponse =
      r.output_text ||
      (Array.isArray(r.output) && r.output[0]?.content?.[0]?.text) ||
      "Disculpa, ¿podrías repetir tu consulta?";

    // Tools comentadas temporalmente - solo usar respuesta directa
    /*
    // Si el modelo usó tools, ejecutarlas y generar respuesta final
    if (r.tool_calls && r.tool_calls.length > 0) {
      console.log(
        "🔧 [TOOLS] Modelo solicitó usar tools:",
        r.tool_calls.length
      );

      const toolResults = [];

      for (const toolCall of r.tool_calls) {
        try {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);

          console.log(
            `🔧 [TOOL] Ejecutando ${functionName} con args:`,
            functionArgs
          );

          let result;
          // Tools comentadas temporalmente para evitar errores
          result = {
            success: false,
            error: "Tools temporalmente deshabilitadas",
          };
          
          toolResults.push({
            tool_call_id: toolCall.id,
            function_name: functionName,
            result: result,
          });
        } catch (error) {
          console.error(`❌ [TOOL] Error ejecutando tool:`, error);
          toolResults.push({
            tool_call_id: toolCall.id,
            function_name: toolCall.function.name,
            result: { success: false, error: error.message },
          });
        }
      }

      // Generar respuesta final con los resultados de las tools
      if (toolResults.length > 0) {
        const finalReq = {
          model: modelName,
          instructions:
            instructions +
            "\n\nUsa los resultados de las herramientas para dar una respuesta precisa y personalizada.",
          input: `Usuario: ${userMessage}\n\nResultados de herramientas:\n${JSON.stringify(
            toolResults,
            null,
            2
          )}`,
          temperature: 0.7,
        };

        const finalR = await openai.responses.create(finalReq);
        finalResponse =
          finalR.output_text ||
          (Array.isArray(finalR.output) &&
            finalR.output[0]?.content?.[0]?.text) ||
          finalResponse;
      }
    }
    */

    // Persistir el nuevo response.id para la próxima vuelta
    await supabase
      .from("whatsapp_conversations")
      .update({
        last_response_id: r.id,
        last_ai_response: finalResponse,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);

    console.log("🤖 [OPENAI] OK. response.id:", r.id);
    if (leadData) {
      console.log(
        "👤 [LEAD] Respuesta personalizada para lead:",
        leadData.name || "Cliente"
      );
    }
    return finalResponse;
  } catch (error) {
    console.error("❌ [OPENAI] Error (Responses):", error);
    return "Disculpa, tuve un inconveniente técnico. ¿Puedes intentar de nuevo en unos minutos?";
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
