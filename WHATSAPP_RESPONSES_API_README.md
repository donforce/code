# WhatsApp Handler con OpenAI Responses API

## 🚀 Nueva Implementación

Este handler de WhatsApp ahora utiliza la **nueva API de Responses de OpenAI** que proporciona:

- ✅ **Memoria de conversación persistente** usando `previous_response_id`
- ✅ **Instrucciones SDR optimizadas** para calificación de leads
- ✅ **Respuestas más coherentes** y contextuales
- ✅ **Mejor rendimiento** que la API de Chat Completions

## 🔧 Configuración Requerida

### 1. Variables de Entorno

```bash
OPENAI_API_KEY=tu_api_key_aqui
OPENAI_MODEL=gpt-4o-mini  # o el modelo que prefieras
```

### 2. Base de Datos

Ejecutar el script SQL para agregar los campos necesarios:

```sql
-- Ejecutar en Supabase SQL Editor
ALTER TABLE whatsapp_conversations
ADD COLUMN IF NOT EXISTS last_response_id TEXT;

ALTER TABLE whatsapp_conversations
ADD COLUMN IF NOT EXISTS last_ai_response TEXT;
```

## 🎯 Funcionalidades SDR

### Instrucciones del Sistema

El bot está configurado como **SDR (Sales Development Representative)** con:

- **Tono**: Profesional, claro y cercano
- **Objetivo**: Calificar interés, pedir email y disponibilidad
- **CTA**: Proponer DEMO
- **Precios**: No dar precios exactos, ofrecer propuesta
- **Handoff**: Conectar con asesor humano cuando se solicite

### Flujo de Conversación

1. **Saludo inicial** y presentación
2. **Calificación de interés** del prospecto
3. **Recolección de información** (email, disponibilidad)
4. **Propuesta de DEMO** con CTA claro
5. **Handoff a humano** si es necesario

## 🔄 Memoria de Conversación

### Cómo Funciona

- Cada respuesta de OpenAI genera un `response.id` único
- Este ID se almacena en `conversation.last_response_id`
- La próxima interacción usa `previous_response_id` para mantener contexto
- **No se pierde el hilo** de la conversación

### Ventajas

- ✅ **Contexto persistente** entre mensajes
- ✅ **Respuestas coherentes** y relevantes
- ✅ **Mejor experiencia** del usuario
- ✅ **Menos repeticiones** de información

## 📊 Campos de Base de Datos

### Tabla: `whatsapp_conversations`

```sql
-- Campos existentes
id, user_id, phone_number, twilio_number, status,
message_count, last_message_at, created_at, updated_at

-- Nuevos campos para Responses API
last_response_id      -- ID del último response de OpenAI
last_ai_response     -- Última respuesta generada por IA
```

## 🚨 Manejo de Errores

### Fallbacks Implementados

- **Error de OpenAI**: Respuesta genérica amigable
- **Error de base de datos**: Log del error y continuar
- **Error de Twilio**: Reintento automático

### Logs Detallados

- 🤖 `[OPENAI]` - Generación de respuestas
- 📱 `[WHATSAPP]` - Operaciones de WhatsApp
- 💾 `[DATABASE]` - Operaciones de base de datos
- ❌ `[ERROR]` - Errores y excepciones

## 🔍 Testing

### Verificar Implementación

1. **Enviar mensaje** de WhatsApp
2. **Verificar logs** de OpenAI
3. **Confirmar** que se genera `response.id`
4. **Verificar** que se almacena en base de datos
5. **Probar** memoria de conversación

### Comandos de Debug

```bash
# Ver logs en tiempo real
tail -f logs/whatsapp.log

# Verificar campos en base de datos
SELECT last_response_id, last_ai_response
FROM whatsapp_conversations
WHERE status = 'active';
```

## 📈 Métricas y Monitoreo

### KPIs Importantes

- **Tiempo de respuesta** de OpenAI
- **Tasa de éxito** de generación de respuestas
- **Calidad** de las respuestas (longitud, relevancia)
- **Uso de memoria** de conversación

### Logs de Monitoreo

```javascript
console.log("🤖 [OPENAI] OK. response.id:", r.id);
console.log(
  "📊 [METRICS] Respuesta generada en:",
  Date.now() - startTime,
  "ms"
);
```

## 🔮 Próximas Mejoras

### RAG (Retrieval Augmented Generation)

```javascript
// Habilitar búsqueda en archivos
tools: [{ type: "file_search" }],
attachments: [{ file_id: "file_pricing_v3", tools: [{ type: "file_search" }] }]
```

### Fine-tuning Personalizado

- Entrenar modelo específico para SDR
- Optimizar respuestas para tu industria
- Mejorar tasa de conversión

### Analytics Avanzados

- Tracking de conversiones
- Análisis de sentimiento
- Optimización de prompts

---

## 📞 Soporte

Para dudas o problemas con la implementación:

1. Revisar logs detallados
2. Verificar configuración de variables de entorno
3. Confirmar estructura de base de datos
4. Contactar al equipo de desarrollo
