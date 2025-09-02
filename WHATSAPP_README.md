# Sistema de WhatsApp con Twilio y OpenAI

Este sistema permite manejar conversaciones de WhatsApp de forma automática usando Twilio para la comunicación y OpenAI para generar respuestas inteligentes.

## 🚀 Características

- **Integración con Twilio**: Manejo completo de webhooks de WhatsApp
- **IA con OpenAI**: Respuestas automáticas usando GPT-3.5-turbo
- **Base de datos Supabase**: Almacenamiento de conversaciones y mensajes
- **API REST**: Endpoints para gestión de conversaciones
- **Seguridad**: RLS policies y validación de webhooks
- **Logging**: Sistema completo de logs para debugging

## 📋 Requisitos

- Node.js 16+
- Cuenta de Twilio con WhatsApp habilitado
- API Key de OpenAI
- Base de datos Supabase

## 🛠️ Instalación

### 1. Instalar dependencias

```bash
npm install twilio openai @supabase/supabase-js dotenv fastify
```

### 2. Configurar variables de entorno

Copia `whatsapp.env.example` a `.env` y configura:

```bash
# OpenAI
OPENAI_API_KEY=tu_api_key_aqui

# Twilio
TWILIO_ACCOUNT_SID=tu_account_sid_aqui
TWILIO_AUTH_TOKEN=tu_auth_token_aqui
TWILIO_WHATSAPP_NUMBER=+1234567890

# Supabase
NEXT_PUBLIC_SUPABASE_URL=tu_url_supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu_anon_key_supabase

# WhatsApp
WHATSAPP_WEBHOOK_SECRET=tu_webhook_secret
```

### 3. Crear tablas en Supabase

Ejecuta el archivo `whatsapp_tables.sql` en tu base de datos Supabase:

```bash
psql -h tu_host -U tu_usuario -d tu_base -f whatsapp_tables.sql
```

O copia y pega el contenido en el SQL Editor de Supabase.

## 🗄️ Estructura de la Base de Datos

### Tablas principales

- **`whatsapp_conversations`**: Conversaciones activas
- **`whatsapp_messages`**: Todos los mensajes individuales
- **`whatsapp_configs`**: Configuraciones por usuario
- **`whatsapp_webhook_logs`**: Logs de webhooks

### Funciones útiles

- `get_whatsapp_stats()`: Estadísticas generales
- `get_whatsapp_engagement_metrics()`: Métricas de engagement
- `cleanup_old_whatsapp_conversations()`: Limpieza automática

## 🔧 Configuración de Twilio

### 1. Configurar webhook en Twilio

En tu consola de Twilio, configura el webhook para WhatsApp:

```
URL: https://tu-dominio.com/webhook/whatsapp
HTTP Method: POST
```

### 2. Verificar firma (opcional pero recomendado)

```javascript
const twilio = require("twilio");
const url = "https://tu-dominio.com/webhook/whatsapp";
const params = request.body;
const signature = request.headers["x-twilio-signature"];

const requestIsValid = twilio.validateRequest(
  process.env.TWILIO_AUTH_TOKEN,
  signature,
  url,
  params
);
```

## 📱 Uso del Sistema

### 1. Iniciar servidor

```bash
node whatsapp-server-example.js
```

### 2. Endpoints disponibles

- **`POST /webhook/whatsapp`**: Webhook de Twilio
- **`GET /api/whatsapp/stats`**: Estadísticas
- **`POST /api/whatsapp/conversations/:id/close`**: Cerrar conversación
- **`GET /api/whatsapp/conversations/:id/history`**: Historial de mensajes

### 3. Flujo de mensajes

1. Usuario envía mensaje por WhatsApp
2. Twilio envía webhook a tu servidor
3. Sistema busca/crea conversación en BD
4. OpenAI genera respuesta
5. Respuesta se envía por WhatsApp
6. Todo se guarda en la base de datos

## 🤖 Configuración de OpenAI

### Personalizar respuestas

```javascript
// En whatsapp_configs puedes configurar:
{
  "system_prompt": "Eres un asistente de soporte técnico...",
  "openai_model": "gpt-4",
  "max_tokens": 1000,
  "temperature": 0.8
}
```

### Contexto de conversación

El sistema automáticamente incluye el historial de la conversación para mantener contexto:

```javascript
// Últimos 10 mensajes se incluyen en el prompt
let context = "Historial de la conversación:\n";
messageHistory.forEach((msg) => {
  const role = msg.direction === "incoming" ? "Usuario" : "Asistente";
  context += `${role}: ${msg.message_content}\n`;
});
```

## 🔒 Seguridad

### RLS Policies

- Usuarios solo ven sus propias conversaciones
- Validación de autenticación en todos los endpoints
- Logs de auditoría para webhooks

### Validación de Webhooks

```javascript
// Verificar que el webhook viene de Twilio
const twilioSignature = request.headers["x-twilio-signature"];
// Implementar validación de firma
```

## 📊 Monitoreo y Logs

### Logs del sistema

```
📱 [WHATSAPP] Mensaje recibido
🤖 [OPENAI] Generando respuesta para: Hola, necesito ayuda
✅ [WHATSAPP] Mensaje enviado exitosamente: msg_123
💾 [WHATSAPP] Mensaje guardado: uuid-123
```

### Métricas disponibles

- Conversaciones activas
- Total de mensajes
- Tiempo promedio de respuesta
- Usuarios activos (24h, 7d)

## 🚨 Troubleshooting

### Errores comunes

1. **"relation already exists"**: Usa `DROP TABLE IF EXISTS` antes de crear
2. **"constraint already exists"**: Las constraints se crean con manejo de errores
3. **Webhook no recibe mensajes**: Verifica URL y configuración en Twilio

### Debugging

```javascript
// Habilitar logs detallados
WHATSAPP_ENABLE_DEBUG = true;
WHATSAPP_LOG_LEVEL = debug;

// Verificar conexiones
console.log("Supabase:", supabase.supabaseUrl);
console.log("Twilio:", accountSid);
console.log("OpenAI:", openai.apiKey ? "Configurado" : "No configurado");
```

## 🔄 Integración con Sistema Existente

### Agregar a server.js existente

```javascript
const { handleWhatsAppMessage } = require("./whatsapp-handler");

// Agregar ruta de webhook
fastify.post("/webhook/whatsapp", async (request, reply) => {
  return await handleWhatsAppMessage(request, reply);
});
```

### Usar en componentes React

```javascript
// Obtener estadísticas
const stats = await fetch("/api/whatsapp/stats");
const data = await stats.json();

// Cerrar conversación
await fetch(`/api/whatsapp/conversations/${id}/close`, {
  method: "POST",
});
```

## 📈 Escalabilidad

### Optimizaciones recomendadas

- **Caché Redis**: Para respuestas frecuentes
- **Queue de mensajes**: Para alta concurrencia
- **CDN**: Para archivos multimedia
- **Load Balancer**: Para múltiples instancias

### Monitoreo en producción

- **New Relic** o **DataDog** para métricas
- **Sentry** para errores
- **Log aggregation** (ELK Stack)
- **Health checks** automáticos

## 🤝 Contribución

1. Fork el proyecto
2. Crea una rama para tu feature
3. Commit tus cambios
4. Push a la rama
5. Abre un Pull Request

## 📄 Licencia

Este proyecto está bajo la licencia MIT. Ver `LICENSE` para más detalles.

## 🆘 Soporte

- **Issues**: GitHub Issues
- **Documentación**: Este README
- **Ejemplos**: `whatsapp-server-example.js`
- **Tests**: `test_whatsapp.js` (por crear)

---

**Nota**: Este sistema está diseñado para manejar conversaciones de WhatsApp de forma automática. Asegúrate de cumplir con las políticas de WhatsApp Business y las regulaciones locales de tu región.
