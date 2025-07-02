// Script para verificar la configuración de Stripe en el backend
import dotenv from "dotenv";
dotenv.config();

console.log("🔍 [Backend Stripe Config] Verificando configuración...\n");

// Verificar variables de entorno requeridas
const requiredVars = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

console.log("📋 Variables de entorno requeridas:");
let allConfigured = true;

requiredVars.forEach((varName) => {
  const value = process.env[varName];
  const status = value ? "✅" : "❌";
  const displayValue = value
    ? `${value.substring(0, 20)}...`
    : "NO CONFIGURADO";
  console.log(`${status} ${varName}: ${displayValue}`);

  if (!value) {
    allConfigured = false;
  }
});

console.log("\n🔧 Configuración del servidor:");
console.log(`   • Puerto: ${process.env.PORT || 8000}`);
console.log(`   • Endpoint webhook: /webhook/stripe`);

if (allConfigured) {
  console.log(
    "\n✅ Configuración completa! El backend está listo para recibir webhooks de Stripe."
  );
  console.log("\n📋 Próximos pasos:");
  console.log("1. Configura el webhook en Stripe Dashboard");
  console.log(
    "2. URL del endpoint: https://tu-backend.railway.app/webhook/stripe"
  );
  console.log(
    "3. Eventos a seleccionar: checkout.session.completed, invoice.payment_succeeded, etc."
  );
  console.log(
    "4. Copia el signing secret y agrégalo a las variables de entorno"
  );
} else {
  console.log(
    "\n❌ Faltan variables de entorno. Configura las variables requeridas."
  );
  console.log("\n📋 Variables que faltan:");
  requiredVars.forEach((varName) => {
    if (!process.env[varName]) {
      console.log(`   • ${varName}`);
    }
  });
}

console.log("\n🔗 Enlaces útiles:");
console.log("   • Stripe Dashboard: https://dashboard.stripe.com/webhooks");
console.log("   • Railway Dashboard: https://railway.app/dashboard");
console.log("   • Supabase Dashboard: https://supabase.com/dashboard");
