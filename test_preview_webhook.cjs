const crypto = require('crypto');

// Configuración para preview.donforce.com
const WEBHOOK_URL = 'https://preview.donforce.com/webhook/elevenlabs';
const ELEVENLABS_WEBHOOK_SECRET = 'wsec_aa13b4b7bba3044aa6c9c231cfe02e13cac62a418c56e075c4bc614cebe4602a';

// Conversation ID único para esta prueba
const CONVERSATION_ID = 'conv_test_preview_' + Date.now();

console.log('🧪 Test Webhook ElevenLabs - Preview');
console.log('='.repeat(50));

// Función para generar HMAC signature
function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
}

// Payload de prueba
const webhookPayload = {
  type: 'conversation_update',
  event_timestamp: Math.floor(Date.now() / 1000),
  data: {
    conversation_id: CONVERSATION_ID,
    agent_id: 'test_agent_preview',
    status: 'completed',
    analysis: {
      call_successful: true,
      transcript_summary: 'Conversación de prueba exitosa en preview.donforce.com. Cliente interesado en propiedades inmobiliarias.',
      conversation_duration: 120,
      turn_count: 8,
      data_collection_results: {
        property_type: 'casa',
        bedrooms: '2',
        bathrooms: '1',
        budget_range: '100,000 - 150,000',
        preferred_location: 'zona sur',
        contact_preference: 'email'
      }
    }
  }
};

async function testWebhook() {
  try {
    console.log('1. 📋 Preparando datos...');
    console.log(`   • Conversation ID: ${CONVERSATION_ID}`);
    console.log(`   • URL: ${WEBHOOK_URL}`);
    
    console.log('\n2. 🔐 Generando firma...');
    const payloadString = JSON.stringify(webhookPayload);
    const signature = generateSignature(payloadString, ELEVENLABS_WEBHOOK_SECRET);
    console.log(`   • Signature: ${signature.substring(0, 20)}...`);
    
    console.log('\n3. 📤 Enviando webhook...');
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ElevenLabs-Signature': signature,
        'User-Agent': 'ElevenLabs-Webhook-Test/1.0'
      },
      body: payloadString
    });
    
    console.log('\n4. �� Resultados:');
    console.log(`   • Status: ${response.status} ${response.statusText}`);
    
    const responseBody = await response.text();
    console.log(`   • Response: ${responseBody}`);
    
    if (response.ok) {
      console.log('\n✅ ¡Webhook enviado exitosamente!');
      console.log('📋 Próximos pasos:');
      console.log('   1. Revisa los logs de Railway');
      console.log('   2. Verifica en Supabase que se guardaron los datos');
      console.log('   3. Ejecuta el script SQL para verificar campos');
    } else {
      console.log('\n❌ Error en el webhook');
      console.log('📋 Revisa los logs de Railway para más detalles');
    }
    
    console.log(`\n🎯 Conversation ID para verificar: ${CONVERSATION_ID}`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Ejecutar la prueba
testWebhook();
