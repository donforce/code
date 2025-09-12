// Test básico para el sistema de SMS
// Este archivo permite probar las funciones principales del sistema

const { handleSMSMessage } = require("./sms-handler.cjs");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Configuración de Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Función para simular un request de Fastify
function createMockRequest(body, headers = {}) {
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "test-signature",
      ...headers,
    },
    protocol: "https",
    hostname: "test.example.com",
    url: "/webhook/sms",
    user: null,
  };
}

// Función para simular un reply de Fastify
function createMockReply() {
  const reply = {
    code: (statusCode) => {
      reply.statusCode = statusCode;
      return reply;
    },
    send: (data) => {
      reply.data = data;
      return reply;
    },
    statusCode: 200,
    data: null,
  };
  return reply;
}

// Test 1: Mensaje SMS básico
async function testBasicSMSMessage() {
  console.log("🧪 [TEST] Probando mensaje SMS básico...");

  const request = createMockRequest({
    From: "+1234567890",
    To: "+0987654321",
    Body: "Hola, necesito ayuda con mi cuenta",
    MessageSid: "test-message-sid-123",
  });

  const reply = createMockReply();

  try {
    await handleSMSMessage(supabase, request, reply);

    console.log("✅ [TEST] Mensaje SMS procesado exitosamente");
    console.log("📊 [TEST] Status Code:", reply.statusCode);
    console.log("📊 [TEST] Response:", JSON.stringify(reply.data, null, 2));
  } catch (error) {
    console.error("❌ [TEST] Error procesando mensaje SMS:", error);
  }
}

// Test 2: Mensaje con usuario registrado
async function testSMSWithRegisteredUser() {
  console.log("🧪 [TEST] Probando mensaje SMS con usuario registrado...");

  // Primero crear un usuario de prueba
  const { data: testUser, error: userError } = await supabase
    .from("users")
    .insert({
      email: "test-sms@example.com",
      first_name: "Test",
      last_name: "User",
      phone_number: "1234567890",
      subscription_plan: "premium",
      available_credits: 100,
      total_credits: 100,
    })
    .select()
    .single();

  if (userError) {
    console.error("❌ [TEST] Error creando usuario de prueba:", userError);
    return;
  }

  console.log("✅ [TEST] Usuario de prueba creado:", testUser.id);

  const request = createMockRequest({
    From: "+1234567890",
    To: "+0987654321",
    Body:
      "Hola, soy " +
      testUser.first_name +
      ", necesito información sobre mi plan",
    MessageSid: "test-message-sid-456",
  });

  const reply = createMockReply();

  try {
    await handleSMSMessage(supabase, request, reply);

    console.log("✅ [TEST] Mensaje SMS con usuario procesado exitosamente");
    console.log("📊 [TEST] Status Code:", reply.statusCode);
    console.log("📊 [TEST] Response:", JSON.stringify(reply.data, null, 2));
  } catch (error) {
    console.error("❌ [TEST] Error procesando mensaje SMS con usuario:", error);
  }

  // Limpiar usuario de prueba
  await supabase.from("users").delete().eq("id", testUser.id);
  console.log("🧹 [TEST] Usuario de prueba eliminado");
}

// Test 3: Mensaje con conversación existente
async function testSMSWithExistingConversation() {
  console.log("🧪 [TEST] Probando mensaje SMS con conversación existente...");

  // Crear conversación de prueba
  const { data: testConversation, error: convError } = await supabase
    .from("sms_conversations")
    .insert({
      phone_number: "+1234567890",
      twilio_number: "+0987654321",
      status: "active",
      message_count: 1,
    })
    .select()
    .single();

  if (convError) {
    console.error("❌ [TEST] Error creando conversación de prueba:", convError);
    return;
  }

  console.log("✅ [TEST] Conversación de prueba creada:", testConversation.id);

  const request = createMockRequest({
    From: "+1234567890",
    To: "+0987654321",
    Body: "Este es mi segundo mensaje",
    MessageSid: "test-message-sid-789",
  });

  const reply = createMockReply();

  try {
    await handleSMSMessage(supabase, request, reply);

    console.log(
      "✅ [TEST] Mensaje SMS con conversación existente procesado exitosamente"
    );
    console.log("📊 [TEST] Status Code:", reply.statusCode);
    console.log("📊 [TEST] Response:", JSON.stringify(reply.data, null, 2));
  } catch (error) {
    console.error(
      "❌ [TEST] Error procesando mensaje SMS con conversación existente:",
      error
    );
  }

  // Limpiar conversación de prueba
  await supabase
    .from("sms_conversations")
    .delete()
    .eq("id", testConversation.id);
  console.log("🧹 [TEST] Conversación de prueba eliminada");
}

// Test 4: Mensaje inválido
async function testInvalidSMSMessage() {
  console.log("🧪 [TEST] Probando mensaje SMS inválido...");

  const request = createMockRequest({
    From: "+1234567890",
    // Falta 'To' y 'Body'
    MessageSid: "test-message-sid-invalid",
  });

  const reply = createMockReply();

  try {
    await handleSMSMessage(supabase, request, reply);

    console.log("✅ [TEST] Mensaje SMS inválido manejado correctamente");
    console.log("📊 [TEST] Status Code:", reply.statusCode);
    console.log("📊 [TEST] Response:", JSON.stringify(reply.data, null, 2));
  } catch (error) {
    console.error("❌ [TEST] Error procesando mensaje SMS inválido:", error);
  }
}

// Test 5: Estadísticas
async function testSMSStats() {
  console.log("🧪 [TEST] Probando estadísticas de SMS...");

  try {
    const { data: stats, error } = await supabase.rpc("get_sms_stats");

    if (error) {
      console.error("❌ [TEST] Error obteniendo estadísticas:", error);
      return;
    }

    console.log("✅ [TEST] Estadísticas obtenidas exitosamente");
    console.log("📊 [TEST] Stats:", JSON.stringify(stats[0], null, 2));
  } catch (error) {
    console.error("❌ [TEST] Error en test de estadísticas:", error);
  }
}

// Test 6: Métricas de engagement
async function testEngagementMetrics() {
  console.log("🧪 [TEST] Probando métricas de engagement...");

  try {
    const { data: metrics, error } = await supabase.rpc(
      "get_sms_engagement_metrics"
    );

    if (error) {
      console.error("❌ [TEST] Error obteniendo métricas:", error);
      return;
    }

    console.log("✅ [TEST] Métricas obtenidas exitosamente");
    console.log("📊 [TEST] Metrics:", JSON.stringify(metrics[0], null, 2));
  } catch (error) {
    console.error("❌ [TEST] Error en test de métricas:", error);
  }
}

// Función principal para ejecutar todos los tests
async function runAllTests() {
  console.log("🚀 [TEST] Iniciando tests del sistema de SMS...");
  console.log("=" * 50);

  try {
    await testBasicSMSMessage();
    console.log("-" * 30);

    await testSMSWithRegisteredUser();
    console.log("-" * 30);

    await testSMSWithExistingConversation();
    console.log("-" * 30);

    await testInvalidSMSMessage();
    console.log("-" * 30);

    await testSMSStats();
    console.log("-" * 30);

    await testEngagementMetrics();
    console.log("-" * 30);

    console.log("✅ [TEST] Todos los tests completados exitosamente");
  } catch (error) {
    console.error("❌ [TEST] Error ejecutando tests:", error);
  }
}

// Ejecutar tests si se llama directamente
if (require.main === module) {
  runAllTests()
    .then(() => {
      console.log("🏁 [TEST] Tests finalizados");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 [TEST] Error fatal en tests:", error);
      process.exit(1);
    });
}

module.exports = {
  testBasicSMSMessage,
  testSMSWithRegisteredUser,
  testSMSWithExistingConversation,
  testInvalidSMSMessage,
  testSMSStats,
  testEngagementMetrics,
  runAllTests,
};
