# Sistema de SMS con Twilio y OpenAI

Este sistema permite manejar conversaciones de SMS de forma automática usando Twilio para la comunicación y OpenAI para generar respuestas inteligentes.

## 🚀 Características

- **Integración con Twilio**: Manejo completo de webhooks de SMS
- **IA con OpenAI**: Respuestas automáticas usando GPT-4o-mini
- **Base de datos Supabase**: Almacenamiento de conversaciones y mensajes
- **API REST**: Endpoints para gestión de conversaciones
- **Seguridad**: RLS policies y validación de webhooks
- **Logging**: Sistema completo de logs para debugging
- **Respuestas concisas**: Optimizado para el límite de caracteres de SMS

## 📋 Requisitos

- Node.js 16+
- Cuenta de Twilio con SMS habilitado
- API Key de OpenAI
- Base de datos Supabase

## 🛠️ Instalación

### 1. Instalar dependencias

```bash
npm install twilio openai @supabase/supabase-js dotenv fastify
```

### 2. Configurar variables de entorno

Copia `sms.env.example` a `.env` y configura:

```bash
# OpenAI
OPENAI_API_KEY=tu_api_key_aqui

# Twilio
TWILIO_ACCOUNT_SID=tu_account_sid_aqui
TWILIO_AUTH_TOKEN=tu_auth_token_aqui
TWILIO_PHONE_NUMBER=+1234567890

# Supabase
NEXT_PUBLIC_SUPABASE_URL=tu_url_supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu_anon_key_supabase

# SMS
SMS_WEBHOOK_SECRET=tu_webhook_secret
```

### 3. Crear tablas en Supabase

Ejecuta el archivo `sms_tables.sql` en tu base de datos Supabase:

```bash
psql -h tu_host -U tu_usuario -d tu_base -f sms_tables.sql
```

O copia y pega el contenido en el SQL Editor de Supabase.

## 🗄️ Estructura de la Base de Datos

### Tablas principales

- **`sms_conversations`**: Conversaciones activas
- **`sms_messages`**: Todos los mensajes individuales
- **`sms_configs`**: Configuraciones por usuario
- **`sms_webhook_logs`**: Logs de webhooks

### Funciones útiles

- `get_sms_stats()`: Estadísticas generales
- `get_sms_engagement_metrics()`: Métricas de engagement
- `cleanup_old_sms_conversations()`: Limpieza automática
- `get_sms_conversation_history()`: Historial de conversación
- `get_user_sms_stats()`: Estadísticas por usuario

## 🔧 Configuración de Twilio

### 1. Configurar webhook en Twilio

En tu consola de Twilio, configura el webhook para SMS:

```
URL: https://tu-dominio.com/webhook/sms
HTTP Method: POST
```

### 2. Verificar firma (opcional pero recomendado)

```javascript
const twilio = require("twilio");
const url = "https://tu-dominio.com/webhook/sms";
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
node server.js
```

### 2. Endpoints disponibles

- **`POST /webhook/sms`**: Webhook de Twilio
- **`GET /api/sms/stats`**: Estadísticas
- **`POST /api/sms/conversations/:id/close`**: Cerrar conversación
- **`GET /api/sms/conversations/:id/history`**: Historial de mensajes

### 3. Flujo de mensajes

1. Usuario envía mensaje por SMS
2. Twilio envía webhook a tu servidor
3. Sistema busca/crea conversación en BD
4. OpenAI genera respuesta
5. Respuesta se envía por SMS
6. Todo se guarda en la base de datos

## 🤖 Configuración de OpenAI

### Personalizar respuestas

```javascript
// En sms_configs puedes configurar:
{
  "system_prompt": "Eres un asistente de soporte técnico...",
  "openai_model": "gpt-4o-mini",
  "max_tokens": 150, // SMS tiene límite de caracteres
  "temperature": 0.7
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
📱 [SMS] Mensaje recibido
🤖 [OPENAI] Generando respuesta para: Hola, necesito ayuda
✅ [SMS] Mensaje enviado exitosamente: msg_123
💾 [SMS] Mensaje guardado: uuid-123
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
SMS_ENABLE_DEBUG = true;
SMS_LOG_LEVEL = debug;

// Verificar conexiones
console.log("Supabase:", supabase.supabaseUrl);
console.log("Twilio:", accountSid);
console.log("OpenAI:", openai.apiKey ? "Configurado" : "No configurado");
```

## 🔄 Integración con Sistema Existente

### Agregar a server.js existente

```javascript
const { handleSMSMessage } = require("./sms-handler");

// Agregar ruta de webhook
fastify.post("/webhook/sms", async (request, reply) => {
  return await handleSMSMessage(supabase, request, reply);
});
```

### Usar en componentes React

```javascript
// Obtener estadísticas
const stats = await fetch("/api/sms/stats");
const data = await stats.json();

// Cerrar conversación
await fetch(`/api/sms/conversations/${id}/close`, {
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

## 🔧 Diferencias con WhatsApp

### Limitaciones de SMS

- **Límite de caracteres**: 160 caracteres por mensaje
- **Sin multimedia**: Solo texto plano
- **Sin estado de entrega**: No hay confirmación de lectura
- **Costo por mensaje**: Cada SMS tiene costo

### Adaptaciones del sistema

- **Respuestas más cortas**: `max_tokens` reducido a 150
- **Prompts optimizados**: Enfoque en brevedad
- **Sin archivos adjuntos**: Solo procesamiento de texto
- **Tracking simplificado**: Sin estados de entrega

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
- **Ejemplos**: `sms-handler.cjs`
- **Tests**: `test_sms.js` (por crear)

---

**Nota**: Este sistema está diseñado para manejar conversaciones de SMS de forma automática. Asegúrate de cumplir con las políticas de Twilio SMS y las regulaciones locales de tu región.
