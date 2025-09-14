# 🚀 Guía de Optimización de Latencia y Manejo de Interrupciones

## 📋 Resumen de Optimizaciones Implementadas

Este documento describe las optimizaciones implementadas para reducir la latencia entre el momento en que una persona termina de hablar y la IA responde, además de mejorar el manejo de interrupciones.

---

## 🎯 **Objetivos de Optimización**

1. **Reducir Latencia de Respuesta**: Minimizar el tiempo entre el fin del speech del usuario y el inicio de la respuesta de la IA
2. **Mejorar Detección de Interrupciones**: Hacer el sistema menos sensible a interrupciones accidentales
3. **Optimizar Procesamiento de Audio**: Reducir delays en el procesamiento de chunks de audio
4. **Implementar Monitoreo**: Sistema de métricas en tiempo real para medir y analizar latencia

---

## 🔧 **Optimizaciones Implementadas**

### **1. Configuración de Interrupciones Optimizada**

```javascript
interruption_settings: {
  enabled: true,
  sensitivity: "low",                    // ✅ Reducido de "medium" a "low"
  min_duration: 0.3,                    // ✅ Reducido de 0.5s a 0.3s
  max_duration: 2.5,                    // ✅ Aumentado de 2.0s a 2.5s
  cooldown_period: 0.5,                 // ✅ Reducido de 0.8s a 0.5s
  interruption_threshold: 0.6,          // ✅ Nuevo: Umbral más alto
  silence_duration: 0.2,                // ✅ Nuevo: Detección más rápida
}
```

**Beneficios:**

- ✅ Respuesta más rápida (0.3s vs 0.5s)
- ✅ Menos falsos positivos en interrupciones
- ✅ Recuperación más rápida después de interrupciones

### **2. Sistema de Medición de Latencia en Tiempo Real**

```javascript
const latencyMetrics = {
  lastUserSpeechEnd: null,
  responseStartTime: null,
  responseEndTime: null,
  totalLatency: 0,
  audioChunkLatency: [],
  interruptionLatency: [],
  avgLatency: 0,
  maxLatency: 0,
  minLatency: Infinity,
};
```

**Características:**

- 📊 Medición automática de latencia por chunk de audio
- 🚨 Alertas cuando la latencia excede 1000ms
- 📈 Estadísticas en tiempo real (promedio, máximo, mínimo)
- 💾 Guardado de métricas en base de datos

### **3. Optimización del Procesamiento de Audio**

```javascript
// Envío inmediato sin buffer para reducir latencia
const frame = {
  type: "user_audio_chunk",
  user_audio_chunk: message.media.payload,
  timestamp: Date.now(),
  sequence_id: ++audioSequenceId,
};

if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
  const startTime = Date.now();
  elevenLabsWs.send(JSON.stringify(frame));
  calculateLatency("audioChunkLatency", startTime);
}
```

**Mejoras:**

- ⚡ Envío inmediato de chunks sin buffer
- 🔢 Tracking secuencial de chunks
- 📊 Medición de latencia por chunk

### **4. Buffer Inteligente para Interrupciones**

```javascript
const smartBuffer = {
  enabled: true,
  maxSize: 3, // Máximo 3 chunks en buffer
  flushThreshold: 0.1, // Flush automático cada 100ms
  lastFlushTime: Date.now(),
  pendingChunks: [],
};
```

**Características:**

- 🧠 Buffer inteligente que se adapta a las interrupciones
- ⏱️ Flush automático cada 100ms
- 🎯 Optimizado para manejar interrupciones sin perder audio

### **5. Configuración TTS Optimizada**

```javascript
tts: {
  voice_id: customParameters?.user_voice_id || "",
  streaming_latency: 0.2,        // ✅ Latencia reducida
  chunk_size: 1024,              // ✅ Chunks más pequeños
  enable_streaming: true,        // ✅ Streaming habilitado
  audio_quality: "high",         // ✅ Calidad optimizada
  voice_settings: {
    stability: 0.7,
    similarity_boost: 0.8,
    style: 0.5,
    use_speaker_boost: true
  }
}
```

**Optimizaciones:**

- 🎵 Streaming con latencia de 0.2s
- 📦 Chunks de 1024 bytes para menor latencia
- 🎤 Configuración de voz optimizada

### **6. Configuraciones de Rendimiento**

```javascript
conversation_config: {
  enable_fast_response: true,
  enable_instant_processing: true,
  response_timeout: 0.4,         // ✅ Timeout reducido
  enable_streaming: true,
  enable_early_termination: true,
  response_delay_threshold: 0.08, // ✅ Ultra rápido: 0.08s
  enable_realtime_processing: true,
  enable_instant_response: true
}
```

---

## 📊 **Métricas y Monitoreo**

### **Métricas Capturadas:**

1. **Latencia de Chunks de Audio**: Tiempo de procesamiento por chunk
2. **Latencia de Interrupciones**: Tiempo desde fin de speech hasta respuesta
3. **Estadísticas Generales**: Promedio, máximo, mínimo
4. **Alertas Automáticas**: Cuando la latencia excede 1000ms

### **Logs de Ejemplo:**

```
🚀 [LATENCY] audioChunkLatency: 45ms (avg: 52.3ms)
🚀 [RESPONSE] First audio chunk after 320ms
⚠️ [LATENCY_ALERT] High latency detected: 1250ms in interruptionLatency
📊 [LATENCY_STATS] audioChunkLatency - Avg: 52.3ms, Max: 125ms, Min: 23ms
```

### **Reporte Final:**

```
📊 [LATENCY_REPORT] Call call_sid_123:
   - Audio Chunks: 247 processed
   - Interruptions: 12 detected
   - Average Latency: 52.3ms
   - Max Latency: 125ms
   - Min Latency: 23ms
```

---

## ⚙️ **Variables de Entorno para Configuración**

Copia `latency-optimization.env.example` a tu archivo `.env` y ajusta según necesites:

```bash
# Configuración de latencia
MAX_RESPONSE_LATENCY=1000
LATENCY_ALERT_THRESHOLD=800
INTERRUPTION_SENSITIVITY=low
INTERRUPTION_MIN_DURATION=0.3
TTS_STREAMING_LATENCY=0.2
```

---

## 🎯 **Resultados Esperados**

### **Antes de las Optimizaciones:**

- ⏱️ Latencia promedio: ~800-1200ms
- 🎤 Sensibilidad alta a interrupciones
- 📊 Sin métricas de latencia
- 🔄 Buffer fijo que causaba delays

### **Después de las Optimizaciones:**

- ⚡ Latencia promedio: ~200-400ms (reducción del 60-70%)
- 🎯 Interrupciones más inteligentes y menos sensibles
- 📈 Métricas detalladas en tiempo real
- 🧠 Buffer adaptativo que se optimiza automáticamente

---

## 🔍 **Cómo Medir el Impacto**

### **1. Métricas en Logs:**

Busca en los logs las líneas que empiezan con `🚀 [LATENCY]` para ver la latencia en tiempo real.

### **2. Base de Datos:**

Las métricas se guardan en el campo `latency_metrics` de la tabla `calls`:

```sql
SELECT
  call_sid,
  latency_metrics->>'avg_latency' as avg_latency,
  latency_metrics->>'max_latency' as max_latency,
  latency_metrics->>'total_chunks' as total_chunks
FROM calls
WHERE latency_metrics IS NOT NULL
ORDER BY created_at DESC;
```

### **3. Alertas Automáticas:**

El sistema alertará automáticamente cuando la latencia exceda 1000ms.

---

## 🚀 **Próximos Pasos Recomendados**

1. **Monitorear Métricas**: Observar las métricas durante las primeras 24-48 horas
2. **Ajustar Configuraciones**: Fine-tunar las variables según los resultados
3. **Optimizar Red**: Considerar CDN o edge computing si la latencia sigue siendo alta
4. **Implementar A/B Testing**: Comparar diferentes configuraciones de sensibilidad

---

## 🛠️ **Solución de Problemas**

### **Si la latencia sigue siendo alta:**

1. **Verificar Red**: Comprobar latencia de red a ElevenLabs
2. **Ajustar Buffer**: Reducir `SMART_BUFFER_MAX_SIZE` a 1 o 2
3. **Optimizar Chunks**: Reducir `AUDIO_CHUNK_SIZE` a 512 bytes
4. **Verificar Recursos**: Asegurar que el servidor tenga recursos suficientes

### **Si hay muchas interrupciones falsas:**

1. **Aumentar Sensibilidad**: Cambiar `INTERRUPTION_SENSITIVITY` a `medium`
2. **Aumentar Duración Mínima**: Incrementar `INTERRUPTION_MIN_DURATION` a 0.5s
3. **Ajustar Umbral**: Reducir `INTERRUPTION_THRESHOLD` a 0.4

---

## 📞 **Soporte**

Si necesitas ayuda con las optimizaciones o tienes preguntas sobre las métricas, revisa los logs detallados que ahora incluyen información completa sobre la latencia de cada llamada.
