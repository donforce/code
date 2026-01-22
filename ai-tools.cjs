// Tools/functions para que el modelo de OpenAI pueda obtener datos dinámicos
// Estas funciones se ejecutan cuando el modelo las necesita
// Archivo compartido para WhatsApp y SMS

// NOTA: Este archivo NO debe crear su propio cliente Supabase
// El cliente se pasa desde los handlers (whatsapp-handler.cjs o sms-handler.cjs)
// Solo exportamos las funciones para que sean utilizadas

/**
 * Manejar solicitud de hablar con un representante/especialista
 * Retorna el mensaje y link de agendar
 */
async function handleRepresentativeRequest(supabase, bookingLink) {
  try {
    return {
      success: true,
      data: {
        mensaje: `Perfecto. Un especialista se comunicará contigo lo antes posible. Si quieres adelantar el proceso, puedes agendar aquí: ${bookingLink}`,
        link_agendar: bookingLink,
        tipo: "representative_request"
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "Error procesando solicitud de representante",
    };
  }
}

/**
 * Enviar SMS de notificación al usuario/agente cuando un cliente quiere hablar con un especialista
 */
async function notifyAgentSpecialistRequest(supabase, userId, clientPhone, clientName = null) {
  try {
    // Obtener número de teléfono del usuario
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("phone_number, first_name, last_name")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      console.error("❌ [NOTIFY AGENT] Error obteniendo datos del usuario:", userError);
      return {
        success: false,
        error: "No se pudo obtener información del usuario",
      };
    }

    if (!user.phone_number) {
      console.log("ℹ️ [NOTIFY AGENT] Usuario no tiene número de teléfono configurado");
      return {
        success: false,
        error: "El usuario no tiene número de teléfono configurado",
      };
    }

    // Obtener información del cliente/lead si hay nombre
    const clientInfo = clientName 
      ? `${clientName} (${clientPhone})` 
      : clientPhone;

    // Crear mensaje de notificación
    const notificationMessage = `🔔 Un cliente quiere hablar con un especialista:\n\nCliente: ${clientInfo}\n\nRevisa la conversación para contactarlo.`;

    // Inicializar cliente de Twilio
    const twilio = require("twilio");
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !twilioPhoneNumber) {
      console.error("❌ [NOTIFY AGENT] Faltan credenciales de Twilio");
      return {
        success: false,
        error: "Configuración de Twilio incompleta",
      };
    }

    const twilioClient = twilio(accountSid, authToken);

    // Enviar SMS al usuario/agente
    const response = await twilioClient.messages.create({
      from: twilioPhoneNumber,
      to: user.phone_number,
      body: notificationMessage,
    });

    console.log(`✅ [NOTIFY AGENT] SMS enviado al agente ${userId}:`, response.sid);

    return {
      success: true,
      data: {
        message_sid: response.sid,
        agent_phone: user.phone_number,
        message: "Notificación enviada al agente",
      },
    };
  } catch (error) {
    console.error("❌ [NOTIFY AGENT] Error enviando notificación:", error);
    return {
      success: false,
      error: error.message || "Error enviando notificación al agente",
    };
  }
}

/**
 * Obtener información del usuario registrado
 */
async function getUserInfo(supabase, userId) {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select(
        `
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
      .eq("id", userId)
      .single();

    if (error) throw error;

    return {
      success: true,
      data: {
        nombre: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
        plan: user.subscription_plan || "Básico",
        creditos_disponibles: user.available_credits || 0,
        creditos_totales: user.total_credits || 0,
        email: user.email,
        cliente_desde: new Date(user.created_at).toLocaleDateString("es-ES"),
        telefono: user.phone_number,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudo obtener la información del usuario",
    };
  }
}

/**
 * Obtener estadísticas de leads del usuario
 */
async function getUserLeadsStats(supabase, userId, period = "week") {
  try {
    let dateFilter;
    const now = new Date();

    switch (period) {
      case "week":
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "month":
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const { data: leads, error } = await supabase
      .from("leads")
      .select("id, status, created_at, source, auto_call")
      .eq("user_id", userId)
      .gte("created_at", dateFilter.toISOString());

    if (error) throw error;

    const totalLeads = leads.length;
    const qualifiedLeads = leads.filter((l) => l.status === "qualified").length;
    const autoCallLeads = leads.filter((lead) => lead.auto_call).length;
    const conversionRate =
      totalLeads > 0 ? Math.round((qualifiedLeads / totalLeads) * 100) : 0;

    return {
      success: true,
      data: {
        periodo: period === "week" ? "esta semana" : "este mes",
        leads_totales: totalLeads,
        leads_calificados: qualifiedLeads,
        leads_auto_call: autoCallLeads,
        leads_manuales: totalLeads - autoCallLeads,
        tasa_conversion: conversionRate,
        fuente_principal: leads.length > 0 ? leads[0]?.source || "N/A" : "N/A",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudieron obtener las estadísticas de leads",
    };
  }
}

/**
 * Obtener información de precios y créditos por país desde la base de datos
 */
async function getPricingInfo(supabase, country = "US") {
  try {
    // Intentar obtener planes desde subscription_plans (WhatsApp)
    const { data: plans, error: plansError } = await supabase
      .from("subscription_plans")
      .select(
        `
        id,
        name,
        description,
        minutes_per_month,
        credits_per_month,
        price_monthly,
        features,
        is_active
      `
      )
      .eq("is_active", true)
      .order("price_monthly", { ascending: true });

    if (!plansError && plans && plans.length > 0) {
      // Obtener configuración de precios por país desde country_call_pricing
      const { data: countryConfig } = await supabase
        .from("country_call_pricing")
        .select(
          `
          country_code,
          price_per_minute,
          price_per_credit,
          price_unit
        `
        )
        .eq("country_code", country)
        .maybeSingle();

      const currency = countryConfig?.price_unit || "USD";
      const pricePerMinute = countryConfig?.price_per_minute || 0.01;
      const pricePerCredit = countryConfig?.price_per_credit || 0.01;

      const formattedPlans = plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        minutes_per_month: plan.minutes_per_month,
        credits_per_month: plan.credits_per_month,
        price_monthly: plan.price_monthly,
        currency: currency,
        features: plan.features || [],
      }));

      const totalCredits = plans.reduce(
        (sum, plan) => sum + (plan.credits_per_month || 0),
        0
      );
      const totalPriceUSD = plans.reduce(
        (sum, plan) => sum + parseFloat(plan.price_monthly || 0),
        0
      );
      const avgCreditCost =
        totalCredits > 0 ? (totalPriceUSD / totalCredits).toFixed(3) : 0;

      return {
        success: true,
        data: {
          pais: country,
          moneda: currency,
          precio_por_minuto: pricePerMinute,
          precio_por_credito: pricePerCredit,
          costo_promedio_por_credito: avgCreditCost,
          planes_disponibles: formattedPlans,
          total_planes: plans.length,
        },
      };
    }

    // Fallback: intentar obtener desde call_pricing (SMS)
    const { data: pricing, error: pricingError } = await supabase
      .from("call_pricing")
      .select("*")
      .eq("country_code", country)
      .eq("is_active", true)
      .order("price_per_credit", { ascending: true });

    if (pricingError || !pricing || pricing.length === 0) {
      return {
        success: false,
        error: "No se encontró información de precios para este país",
        fallback_data: {
          pais: country,
          moneda: "USD",
          mensaje:
            "Usando precios por defecto. Contacta soporte para configuración personalizada.",
        },
      };
    }

    const cheapestOption = pricing[0];
    const mostExpensiveOption = pricing[pricing.length - 1];

    return {
      success: true,
      data: {
        pais: country,
        opciones_disponibles: pricing.length,
        precio_mas_bajo: cheapestOption.price_per_credit,
        precio_mas_alto: mostExpensiveOption.price_per_credit,
        rango_precios: `${cheapestOption.price_per_credit} - ${mostExpensiveOption.price_per_credit} USD por crédito`,
        recomendacion:
          cheapestOption.price_per_credit < 0.1
            ? "Opción económica disponible"
            : "Precios estándar del mercado",
      },
    };
  } catch (error) {
    console.error("Error obteniendo precios:", error);
    return {
      success: false,
      error: "No se pudo obtener la información de precios",
    };
  }
}

/**
 * Obtener estado de la cola de llamadas del usuario
 */
async function getCallQueueStatus(supabase, userId) {
  try {
    // Intentar desde calls (WhatsApp)
    const { data: calls, error: callsError } = await supabase
      .from("calls")
      .select("id, status, priority, created_at")
      .eq("user_id", userId)
      .in("status", ["queued", "scheduled"])
      .order("priority", { ascending: false });

    if (!callsError && calls) {
      const queuedCalls = calls.filter((c) => c.status === "queued").length;
      const scheduledCalls = calls.filter((c) => c.status === "scheduled").length;

      return {
        success: true,
        data: {
          llamadas_en_cola: queuedCalls,
          llamadas_programadas: scheduledCalls,
          total_pendientes: queuedCalls + scheduledCalls,
          prioridad_mas_alta:
            calls.length > 0 ? calls[0]?.priority || "normal" : "sin llamadas",
        },
      };
    }

    // Fallback: intentar desde call_queue (SMS)
    const { data: queue, error: queueError } = await supabase
      .from("call_queue")
      .select("id, status, created_at, priority")
      .eq("user_id", userId)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: true });

    if (queueError) throw queueError;

    const pendingCalls = queue.filter(
      (item) => item.status === "pending"
    ).length;
    const processingCalls = queue.filter(
      (item) => item.status === "processing"
    ).length;
    const totalInQueue = queue.length;

    return {
      success: true,
      data: {
        llamadas_pendientes: pendingCalls,
        llamadas_procesando: processingCalls,
        total_en_cola: totalInQueue,
        estado:
          totalInQueue === 0
            ? "Sin llamadas en cola"
            : `${totalInQueue} llamada(s) en proceso`,
        proxima_llamada:
          queue.length > 0
            ? "Próxima llamada en cola"
            : "No hay llamadas programadas",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudo obtener el estado de la cola de llamadas",
    };
  }
}

/**
 * Obtener información de facturación del usuario
 */
async function getUserBillingInfo(supabase, userId) {
  try {
    // Intentar obtener información de suscripción activa
    const { data: subscription, error: subError } = await supabase
      .from("user_subscriptions")
      .select(
        `
        status,
        current_period_end,
        price_per_month,
        credits_per_month,
        current_period_start,
        subscription_plans (
          name,
          price_monthly,
          description
        )
      `
      )
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    // Obtener información básica del usuario
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("subscription_plan, created_at")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    // Construir información de facturación
    let billingInfo = {
      plan_actual:
        subscription?.subscription_plans?.name ||
        user.subscription_plan ||
        "Básico",
      proxima_facturacion: subscription?.current_period_end
        ? new Date(subscription.current_period_end).toLocaleDateString("es-ES")
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString(
            "es-ES"
          ),
      metodo_pago: "Tarjeta de crédito",
      estado: subscription?.status || "Sin suscripción activa",
      precio_mensual:
        subscription?.subscription_plans?.price_monthly ||
        subscription?.price_per_month ||
        "N/A",
    };

    if (subscription?.current_period_start && subscription?.current_period_end) {
      const startDate = new Date(subscription.current_period_start);
      const endDate = new Date(subscription.current_period_end);
      const daysRemaining = Math.ceil(
        (endDate - new Date()) / (1000 * 60 * 60 * 24)
      );

      billingInfo.periodo_actual = `${startDate.toLocaleDateString(
        "es-ES"
      )} - ${endDate.toLocaleDateString("es-ES")}`;
      billingInfo.dias_restantes = daysRemaining > 0 ? daysRemaining : 0;
      billingInfo.renovacion =
        daysRemaining > 0
          ? `Renovación en ${daysRemaining} días`
          : "Período vencido";
    }

    if (subscription?.subscription_plans?.description) {
      billingInfo.descripcion = subscription.subscription_plans.description;
    }

    if (subscription?.credits_per_month) {
      billingInfo.creditos_mensuales = subscription.credits_per_month;
    }

    return {
      success: true,
      data: billingInfo,
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudo obtener la información de facturación",
    };
  }
}

/**
 * Obtener descuentos disponibles para el usuario
 */
async function getAvailableDiscounts(supabase, userId, plan = null) {
  try {
    // Primero obtener el plan del usuario
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("subscription_plan")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    const userPlan = plan || user.subscription_plan || "basic";

    // Buscar descuentos disponibles para el plan del usuario
    const { data: discounts, error: discountError } = await supabase
      .from("discounts")
      .select("*")
      .eq("is_active", true)
      .or(`target_plans.cs.{${userPlan}},target_plans.is.null`)
      .lte("valid_from", new Date().toISOString())
      .gte("valid_until", new Date().toISOString());

    if (discountError) {
      // Si no existe la tabla discounts, devolver descuento por defecto
      const discount = {
        descuento_general: "10%",
        aplica_a: "todos los planes",
        validez: "hasta fin de mes",
      };

      return {
        success: true,
        data: {
          plan: "todos",
          descuentos_disponibles: discount,
        },
      };
    }

    if (!discounts || discounts.length === 0) {
      return {
        success: true,
        data: {
          descuentos_disponibles: 0,
          mensaje: "No hay descuentos disponibles en este momento",
          plan_actual: userPlan,
        },
      };
    }

    const activeDiscounts = discounts.map((discount) => ({
      codigo: discount.code,
      descripcion: discount.description,
      descuento: discount.discount_percentage,
      tipo: discount.discount_type,
      valido_hasta: new Date(discount.valid_until).toLocaleDateString("es-ES"),
    }));

    return {
      success: true,
      data: {
        descuentos_disponibles: activeDiscounts.length,
        plan_actual: userPlan,
        descuentos: activeDiscounts,
        mejor_descuento: Math.max(...activeDiscounts.map((d) => d.descuento)),
        mensaje: `Tienes ${activeDiscounts.length} descuento(s) disponible(s) para tu plan ${userPlan}`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudieron obtener los descuentos disponibles",
    };
  }
}

/**
 * Obtener estadísticas de llamadas del usuario
 */
async function getUserCallStats(supabase, userId, period = "week") {
  try {
    let dateFilter;
    const now = new Date();

    if (period === "week") {
      dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "month") {
      dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const { data: calls, error } = await supabase
      .from("calls")
      .select("id, status, result, created_at, duration")
      .eq("user_id", userId)
      .gte("created_at", dateFilter.toISOString());

    if (error) throw error;

    const totalCalls = calls.length;
    const successfulCalls = calls.filter(
      (call) => call.result === "success"
    ).length;
    const failedCalls = calls.filter((call) => call.result === "failed").length;
    const totalDuration = calls.reduce(
      (sum, call) => sum + (call.duration || 0),
      0
    );
    const avgDuration =
      totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

    return {
      success: true,
      data: {
        periodo: period === "week" ? "última semana" : "último mes",
        total_llamadas: totalCalls,
        llamadas_exitosas: successfulCalls,
        llamadas_fallidas: failedCalls,
        tasa_exito:
          totalCalls > 0 ? Math.round((successfulCalls / totalCalls) * 100) : 0,
        duracion_total: totalDuration,
        duracion_promedio: avgDuration,
        rendimiento:
          successfulCalls > failedCalls
            ? "Excelente"
            : successfulCalls === failedCalls
            ? "Regular"
            : "Necesita mejora",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudieron obtener las estadísticas de llamadas",
    };
  }
}

/**
 * Obtener información de créditos disponibles
 */
async function getCreditsInfo(supabase, userId) {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("available_credits, total_credits, subscription_plan")
      .eq("id", userId)
      .single();

    if (error) throw error;

    const availableCredits = user.available_credits || 0;
    const totalCredits = user.total_credits || 0;
    const usedCredits = totalCredits - availableCredits;
    const usagePercentage =
      totalCredits > 0 ? Math.round((usedCredits / totalCredits) * 100) : 0;

    return {
      success: true,
      data: {
        creditos_disponibles: availableCredits,
        creditos_totales: totalCredits,
        creditos_utilizados: usedCredits,
        porcentaje_uso: usagePercentage,
        plan: user.subscription_plan || "Básico",
        estado:
          availableCredits > 100
            ? "Créditos suficientes"
            : availableCredits > 50
            ? "Créditos moderados"
            : "Créditos bajos",
        recomendacion:
          availableCredits < 50
            ? "Considera recargar créditos"
            : "Créditos en buen estado",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: "No se pudo obtener la información de créditos",
    };
  }
}

// Exportar todas las funciones
module.exports = {
  handleRepresentativeRequest,
  notifyAgentSpecialistRequest,
  getUserInfo,
  getUserLeadsStats,
  getPricingInfo,
  getCallQueueStatus,
  getUserBillingInfo,
  getAvailableDiscounts,
  getUserCallStats,
  getCreditsInfo,
};
