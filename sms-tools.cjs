// Tools/functions para que el modelo de OpenAI pueda obtener datos dinámicos
// Estas funciones se ejecutan cuando el modelo las necesita

// NOTA: Este archivo NO debe crear su propio cliente Supabase
// El cliente se pasa desde sms-handler.cjs
// Solo exportamos las funciones para que sean utilizadas

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

    if (period === "week") {
      dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "month") {
      dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // default week
    }

    const { data: leads, error } = await supabase
      .from("leads")
      .select("id, created_at, auto_call")
      .eq("user_id", userId)
      .gte("created_at", dateFilter.toISOString());

    if (error) throw error;

    const totalLeads = leads.length;
    const autoCallLeads = leads.filter((lead) => lead.auto_call).length;
    const manualLeads = totalLeads - autoCallLeads;

    return {
      success: true,
      data: {
        periodo: period === "week" ? "última semana" : "último mes",
        total_leads: totalLeads,
        leads_auto_call: autoCallLeads,
        leads_manuales: manualLeads,
        porcentaje_auto_call:
          totalLeads > 0 ? Math.round((autoCallLeads / totalLeads) * 100) : 0,
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
 * Obtener información de precios y créditos por país
 */
async function getPricingInfo(supabase, country = "US") {
  try {
    const { data: pricing, error } = await supabase
      .from("call_pricing")
      .select("*")
      .eq("country_code", country)
      .eq("is_active", true)
      .order("price_per_credit", { ascending: true });

    if (error) throw error;

    if (!pricing || pricing.length === 0) {
      return {
        success: false,
        error: "No se encontró información de precios para este país",
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
    const { data: queue, error } = await supabase
      .from("call_queue")
      .select("id, status, created_at, priority")
      .eq("user_id", userId)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: true });

    if (error) throw error;

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
    const { data: subscription, error } = await supabase
      .from("user_subscriptions")
      .select(
        `
        status,
        price_per_month,
        credits_per_month,
        current_period_start,
        current_period_end,
        subscription_plans!inner(
          name,
          description
        )
      `
      )
      .eq("user_id", userId)
      .single();

    if (error) throw error;

    if (!subscription) {
      return {
        success: false,
        error: "No se encontró información de suscripción",
      };
    }

    const startDate = new Date(subscription.current_period_start);
    const endDate = new Date(subscription.current_period_end);
    const daysRemaining = Math.ceil(
      (endDate - new Date()) / (1000 * 60 * 60 * 24)
    );

    return {
      success: true,
      data: {
        plan: subscription.subscription_plans.name,
        descripcion: subscription.subscription_plans.description,
        estado: subscription.status,
        precio_mensual: subscription.price_per_month,
        creditos_mensuales: subscription.credits_per_month,
        periodo_actual: `${startDate.toLocaleDateString(
          "es-ES"
        )} - ${endDate.toLocaleDateString("es-ES")}`,
        dias_restantes: daysRemaining > 0 ? daysRemaining : 0,
        renovacion:
          daysRemaining > 0
            ? `Renovación en ${daysRemaining} días`
            : "Período vencido",
      },
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
async function getAvailableDiscounts(supabase, userId) {
  try {
    // Primero obtener el plan del usuario
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("subscription_plan")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    const userPlan = user.subscription_plan || "basic";

    // Buscar descuentos disponibles para el plan del usuario
    const { data: discounts, error: discountError } = await supabase
      .from("discounts")
      .select("*")
      .eq("is_active", true)
      .or(`target_plans.cs.{${userPlan}},target_plans.is.null`)
      .lte("valid_from", new Date().toISOString())
      .gte("valid_until", new Date().toISOString());

    if (discountError) throw discountError;

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
      dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // default week
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
  getUserInfo,
  getUserLeadsStats,
  getPricingInfo,
  getCallQueueStatus,
  getUserBillingInfo,
  getAvailableDiscounts,
  getUserCallStats,
  getCreditsInfo,
};
