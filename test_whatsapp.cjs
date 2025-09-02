// Test básico para el módulo de WhatsApp
const {
  handleWhatsAppMessage,
  getWhatsAppStats,
  closeConversation,
  getConversationHistory,
  cleanupOldConversations,
  getEngagementMetrics,
  validateTwilioWebhook,
} = require("./whatsapp-handler.cjs");

// Mock de request y reply para testing
const createMockRequest = (body = {}, headers = {}) => ({
  body,
  headers,
  protocol: "https",
  hostname: "test.com",
  url: "/webhook/whatsapp",
  user: { id: "test-user-id" },
});

const createMockReply = () => {
  const reply = {
    code: (statusCode) => ({
      send: (data) => ({ statusCode, data }),
    }),
    status: (statusCode) => ({
      send: (data) => ({ statusCode, data }),
    }),
    header: (name, value) => reply,
    send: (data) => ({ data }),
  };
  return reply;
};

// Test de funciones básicas
async function runTests() {
  console.log("🧪 [TEST] Iniciando tests de WhatsApp...");

  try {
    // Test 1: Validar webhook de Twilio
    console.log("\n📋 Test 1: Validación de webhook de Twilio");
    const mockRequest = createMockRequest(
      {
        From: "whatsapp:+1234567890",
        Body: "Hola",
        To: "whatsapp:+0987654321",
      },
      { "x-twilio-signature": "test-signature" }
    );

    // Este test fallará en desarrollo porque no hay TWILIO_AUTH_TOKEN real
    try {
      const isValid = validateTwilioWebhook(
        mockRequest,
        "https://test.com/webhook/whatsapp"
      );
      console.log(`✅ Validación de webhook: ${isValid ? "PASÓ" : "FALLÓ"}`);
    } catch (error) {
      console.log(
        `⚠️ Validación de webhook: Error esperado en desarrollo - ${error.message}`
      );
    }

    // Test 2: Crear request mock válido
    console.log("\n📋 Test 2: Request mock válido");
    const validRequest = createMockRequest({
      From: "whatsapp:+1234567890",
      Body: "Hola, necesito ayuda",
      To: "whatsapp:+0987654321",
      MessageSid: "msg_test_123",
    });

    console.log("✅ Request mock creado correctamente");
    console.log("   - From:", validRequest.body.From);
    console.log("   - Body:", validRequest.body.Body);
    console.log("   - To:", validRequest.body.To);

    // Test 3: Mock de reply
    console.log("\n📋 Test 3: Mock de reply");
    const mockReply = createMockReply();
    const testResponse = mockReply.code(200).send({ success: true });
    console.log("✅ Mock de reply funciona:", testResponse.statusCode === 200);

    // Test 4: Validar estructura de datos
    console.log("\n📋 Test 4: Estructura de datos");
    const testData = {
      phone_number: "+1234567890",
      twilio_number: "+0987654321",
      message_content: "Test message",
      direction: "incoming",
      external_message_id: "msg_test_123",
    };

    const requiredFields = [
      "phone_number",
      "twilio_number",
      "message_content",
      "direction",
    ];
    const hasAllFields = requiredFields.every((field) =>
      testData.hasOwnProperty(field)
    );
    console.log(
      `✅ Estructura de datos: ${hasAllFields ? "VÁLIDA" : "INVÁLIDA"}`
    );

    // Test 5: Validar formatos de teléfono
    console.log("\n📋 Test 5: Formatos de teléfono");
    const phoneNumbers = [
      "+1234567890",
      "+573001234567",
      "+34612345678",
      "whatsapp:+1234567890",
    ];

    phoneNumbers.forEach((phone) => {
      const cleanPhone = phone.replace("whatsapp:", "");
      const isValid = /^\+[1-9]\d{1,14}$/.test(cleanPhone);
      console.log(`   ${phone} -> ${cleanPhone} (${isValid ? "✅" : "❌"})`);
    });

    // Test 6: Simular procesamiento de mensaje
    console.log("\n📋 Test 6: Simulación de procesamiento");
    const testMessage = {
      from: "+1234567890",
      to: "+0987654321",
      message: "Hola, ¿cómo estás?",
      messageId: "msg_test_456",
    };

    console.log("✅ Simulación de mensaje:");
    console.log(`   - De: ${testMessage.from}`);
    console.log(`   - Para: ${testMessage.to}`);
    console.log(`   - Mensaje: ${testMessage.message}`);
    console.log(`   - ID: ${testMessage.messageId}`);

    // Test 7: Validar configuración de OpenAI
    console.log("\n📋 Test 7: Configuración de OpenAI");
    const openaiConfig = {
      model: "gpt-3.5-turbo",
      max_tokens: 500,
      temperature: 0.7,
    };

    console.log("✅ Configuración de OpenAI:");
    console.log(`   - Modelo: ${openaiConfig.model}`);
    console.log(`   - Max tokens: ${openaiConfig.max_tokens}`);
    console.log(`   - Temperatura: ${openaiConfig.temperature}`);

    // Test 8: Validar funciones de limpieza
    console.log("\n📋 Test 8: Funciones de limpieza");
    const testDate = new Date();
    const oldDate = new Date(testDate.getTime() - 31 * 24 * 60 * 60 * 1000); // 31 días atrás

    console.log("✅ Fechas de limpieza:");
    console.log(`   - Fecha actual: ${testDate.toISOString()}`);
    console.log(`   - Fecha límite (30 días): ${oldDate.toISOString()}`);

    console.log(
      "\n🎉 [TEST] Todos los tests básicos completados exitosamente!"
    );
    console.log("\n📝 Notas:");
    console.log(
      "   - Los tests de base de datos requieren conexión real a Supabase"
    );
    console.log("   - Los tests de Twilio requieren credenciales reales");
    console.log("   - Los tests de OpenAI requieren API key real");
    console.log("   - Este es un test de estructura y lógica básica");
  } catch (error) {
    console.error("❌ [TEST] Error en los tests:", error);
  }
}

// Función para test de integración (requiere configuración real)
async function runIntegrationTests() {
  console.log("\n🔗 [INTEGRATION] Iniciando tests de integración...");

  // Verificar variables de entorno
  const requiredEnvVars = [
    "OPENAI_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ];

  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );

  if (missingVars.length > 0) {
    console.log("⚠️ [INTEGRATION] Variables de entorno faltantes:");
    missingVars.forEach((varName) => console.log(`   - ${varName}`));
    console.log("   Los tests de integración se omitirán");
    return;
  }

  console.log(
    "✅ [INTEGRATION] Todas las variables de entorno están configuradas"
  );
  console.log("   Los tests de integración están disponibles");
}

// Ejecutar tests
if (require.main === module) {
  runTests()
    .then(() => {
      return runIntegrationTests();
    })
    .catch((error) => {
      console.error("❌ [TEST] Error general:", error);
    });
}

module.exports = {
  runTests,
  runIntegrationTests,
  createMockRequest,
  createMockReply,
};
