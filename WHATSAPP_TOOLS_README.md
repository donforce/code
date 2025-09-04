# WhatsApp Handler con OpenAI Tools/Functions

## 🚀 **Nueva Arquitectura: Modelo + Tools**

Este handler ahora implementa un sistema híbrido donde:

- **El modelo se entrena** con datos genéricos (sin precios específicos)
- **Las tools se ejecutan** para obtener datos dinámicos en tiempo real
- **La respuesta se personaliza** con información actualizada del usuario

## 🔧 **Sistema de Tools Implementado**

### **1. getUserInfo(userId)**

Obtiene información completa del usuario registrado:

- Nombre completo
- Plan de suscripción
- Créditos disponibles/totales
- Email y teléfono
- Fecha de registro

### **2. getUserLeadsStats(userId, period)**

Estadísticas de leads del usuario:

- Total de leads (semana/mes)
- Leads calificados
- Tasa de conversión
- Fuente principal

### **3. getPricingInfo(country)**

Información de precios por país:

- Costo por crédito
- Moneda local
- Planes disponibles
- Precios actualizados

### **4. getCallQueueStatus(userId)**

Estado de la cola de llamadas:

- Llamadas en cola
- Llamadas programadas
- Prioridades
- Total pendientes

### **5. getUserBillingInfo(userId)**

Información de facturación:

- Plan actual
- Próxima facturación
- Método de pago
- Estado de cuenta

### **6. getAvailableDiscounts(userId, plan)**

Descuentos disponibles:

- Por plan de suscripción
- Créditos adicionales
- Renovación anticipada
- Funcionalidades premium

## 📊 **Dataset de Entrenamiento**

### **Dataset Original (Prospectos Nuevos)**

- 101 conversaciones
- Objeciones comunes
- Respuestas genéricas
- Sin datos específicos

### **Dataset de Usuarios Registrados**

- 25 conversaciones
- Consultas sobre cuenta
- Respuestas que invocan tools
- Personalización por usuario

### **Características del Entrenamiento**

- ✅ **Sin precios específicos** (se obtienen dinámicamente)
- ✅ **Sin descuentos hardcodeados** (se calculan por plan)
- ✅ **Sin estadísticas fijas** (se consultan en tiempo real)
- ✅ **Respuestas genéricas** que invocan tools cuando es necesario

## 🔄 **Flujo de Ejecución**

### **1. Usuario Envía Mensaje**

```
Usuario: "¿Cuántos créditos me quedan?"
```

### **2. Modelo Analiza y Decide**

```
🤖 [OPENAI] Analizando mensaje...
🔧 [TOOLS] Modelo decide usar getUserInfo()
```

### **3. Tool Se Ejecuta**

```
🔧 [TOOL] Ejecutando getUserInfo con args: { userId: "123" }
📊 [DATA] Resultado: { creditos_disponibles: 87, plan: "Premium" }
```

### **4. Respuesta Final Generada**

```
🤖 [OPENAI] Generando respuesta con datos de tool...
👤 [USER] Respuesta personalizada para: Carlos
```

### **5. Respuesta Personalizada**

```
"¡Hola Carlos! 👋 Según tu cuenta Premium, tienes 87 créditos disponibles.
¿Te parece bien si te envío un resumen detallado por email?"
```

## 🎯 **Ventajas del Sistema**

### **Para el Entrenamiento**

- ✅ **Dataset más limpio** sin datos que cambian
- ✅ **Mejor generalización** del modelo
- ✅ **Fácil mantenimiento** del dataset
- ✅ **Escalabilidad** a nuevos países/planes

### **Para el Usuario**

- ✅ **Información siempre actualizada**
- ✅ **Respuestas personalizadas** con datos reales
- ✅ **Experiencia consistente** independiente del momento
- ✅ **Datos precisos** de su cuenta

### **Para el Desarrollo**

- ✅ **Separación de responsabilidades**
- ✅ **Fácil agregar nuevas tools**
- ✅ **Testing independiente** de tools
- ✅ **Monitoreo granular** de cada función

## 🛠️ **Implementación Técnica**

### **Estructura de Tools**

```javascript
{
  type: "function",
  function: {
    name: "getUserInfo",
    description: "Obtener información completa del usuario",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID del usuario"
        }
      },
      required: ["userId"]
    }
  }
}
```

### **Manejo de Tool Calls**

```javascript
if (r.tool_calls && r.tool_calls.length > 0) {
  // Ejecutar cada tool solicitada
  for (const toolCall of r.tool_calls) {
    const result = await executeTool(toolCall);
    toolResults.push(result);
  }

  // Generar respuesta final con resultados
  const finalResponse = await generateFinalResponse(toolResults);
}
```

## 📈 **Casos de Uso**

### **Consulta de Créditos**

```
Usuario: "¿Cuántos créditos me quedan?"
Tool: getUserInfo()
Respuesta: "Tienes 87 créditos disponibles de tu plan Premium"
```

### **Estadísticas de Leads**

```
Usuario: "¿Cómo van mis leads esta semana?"
Tool: getUserLeadsStats(week)
Respuesta: "Esta semana has generado 12 leads y 3 citas agendadas"
```

### **Información de Precios**

```
Usuario: "¿Cuánto cuestan los créditos en México?"
Tool: getPricingInfo("MX")
Respuesta: "En México, cada crédito cuesta $2.00 MXN"
```

### **Estado de Cola**

```
Usuario: "¿Tengo llamadas pendientes?"
Tool: getCallQueueStatus()
Respuesta: "Tienes 5 llamadas en cola y 2 programadas para hoy"
```

## 🔮 **Próximas Mejoras**

### **Tools Adicionales**

- **getUserPreferences()** - Configuraciones del usuario
- **getIntegrationStatus()** - Estado de integraciones (CRM, calendario)
- **getSupportTickets()** - Tickets de soporte abiertos
- **getReferralStats()** - Estadísticas de referidos

### **Optimizaciones**

- **Caching inteligente** de resultados de tools
- **Ejecución paralela** de tools independientes
- **Fallbacks** para tools que fallen
- **Métricas de performance** de cada tool

### **Integración Avanzada**

- **Webhooks** para datos en tiempo real
- **APIs externas** para precios de competencia
- **Machine Learning** para predicción de necesidades
- **A/B Testing** de diferentes respuestas

## 📋 **Configuración Requerida**

### **Variables de Entorno**

```bash
SUPABASE_URL=tu_url_de_supabase
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
OPENAI_API_KEY=tu_api_key_de_openai
OPENAI_MODEL=gpt-4o-mini
```

### **Dependencias**

```bash
npm install @supabase/supabase-js openai
```

## 🧪 **Testing**

### **Probar Tools Individualmente**

```javascript
const tools = require("./whatsapp-tools");

// Probar getUserInfo
const userInfo = await tools.getUserInfo("user-id-123");
console.log("User Info:", userInfo);

// Probar getPricingInfo
const pricing = await tools.getPricingInfo("MX");
console.log("Pricing MX:", pricing);
```

### **Probar Flujo Completo**

1. Enviar mensaje de WhatsApp
2. Verificar logs de tools
3. Confirmar respuesta personalizada
4. Validar datos en base de datos

---

## 📞 **Soporte**

Para implementar nuevas tools o resolver problemas:

1. Revisar logs de ejecución de tools
2. Verificar parámetros y respuestas
3. Validar permisos de base de datos
4. Contactar al equipo de desarrollo
