// Tools/functions para que el modelo de OpenAI pueda obtener datos dinámicos
// Estas funciones se ejecutan cuando el modelo las necesita

// NOTA: Este archivo NO debe crear su propio cliente Supabase
// El cliente se pasa desde whatsapp-handler.cjs
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
      .select("id, status, created_at, source")
      .eq("user_id", userId)
      .gte("created_at", dateFilter.toISOString());

    if (error) throw error;

    const totalLeads = leads.length;
    const qualifiedLeads = leads.filter((l) => l.status === "qualified").length;
    const conversionRate =
      totalLeads > 0 ? Math.round((qualifiedLeads / totalLeads) * 100) : 0;

    return {
      success: true,
      data: {
        periodo: period === "week" ? "esta semana" : "este mes",
        leads_totales: totalLeads,
        leads_calificados: qualifiedLeads,
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
    // Obtener planes configurados desde la base de datos
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

    if (plansError) throw plansError;

    // Obtener configuración de precios por país desde country_call_pricing
    const { data: countryConfig, error: countryError } = await supabase
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
      .single();

    // Si no hay configuración específica del país, usar USD por defecto
    const currency = countryConfig?.price_unit || "USD";
    const pricePerMinute = countryConfig?.price_per_minute || 0.01;
    const pricePerCredit = countryConfig?.price_per_credit || 0.01;

    // Formatear planes con información real
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

    // Calcular costo por crédito promedio
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
  } catch (error) {
    console.error("Error obteniendo precios:", error);

    // Fallback a precios por defecto si hay error en la BD
    return {
      success: false,
      error:
        "No se pudo obtener la información de precios desde la base de datos",
      fallback_data: {
        pais: country,
        moneda: "USD",
        mensaje:
          "Usando precios por defecto. Contacta soporte para configuración personalizada.",
      },
    };
  }
}

/**
 * Obtener estado de la cola de llamadas del usuario
 */
async function getCallQueueStatus(supabase, userId) {
  try {
    const { data: calls, error } = await supabase
      .from("calls")
      .select("id, status, priority, created_at")
      .eq("user_id", userId)
      .in("status", ["queued", "scheduled"])
      .order("priority", { ascending: false });

    if (error) throw error;

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
    // Obtener información de suscripción activa
    const { data: subscription, error: subError } = await supabase
      .from("user_subscriptions")
      .select(
        `
        status,
        current_period_end,
        subscription_plans (
          name,
          price_monthly
        )
      `
      )
      .eq("user_id", userId)
      .eq("status", "active")
      .single();

    if (subError && subError.code !== "PGRST116") {
      throw subError;
    }

    // Obtener información básica del usuario
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("subscription_plan, created_at")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    // Construir información de facturación
    const billingInfo = {
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
      precio_mensual: subscription?.subscription_plans?.price_monthly || "N/A",
    };

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
    // Por ahora, siempre devolver 10% de descuento
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
  } catch (error) {
    return {
      success: false,
      error: "No se pudieron obtener los descuentos disponibles",
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
};
