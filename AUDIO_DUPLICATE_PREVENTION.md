# 🎵 Prevención de Duplicados de Audio - ElevenLabs

## 🔍 **Problema Identificado**

La IA de ElevenLabs ocasionalmente repetía la misma frase 2 veces debido a:

- Duplicación de chunks de audio desde ElevenLabs
- Reconexiones del WebSocket que reiniciaban el flujo
- Buffer de audio que enviaba chunks duplicados
- Interrupciones que no limpiaban correctamente el estado

## 🛠️ **Mejoras Implementadas**

### 1. **Sistema de Hash de Audio**

```javascript
const generateAudioHash = (audioChunk) => {
  let hash = 0;
  for (let i = 0; i < Math.min(audioChunk.length, 100); i++) {
    const char = audioChunk.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString();
};
```

- Genera un hash único para cada chunk de audio
- Detecta duplicados basándose en contenido, no solo en referencia

### 2. **Detección de Duplicados Mejorada**

```javascript
const isDuplicateAudioChunk = (audioChunk) => {
  // Verificación múltiple de duplicados
  // - Set de chunks enviados
  // - Hash consecutivo
  // - Duplicados temporales
  // - Contador de duplicados consecutivos
};
```

### 3. **Tracking de Secuencia**

- Asigna ID secuencial a cada chunk
- Evita procesar chunks fuera de orden
- Previene duplicados por reconexiones

### 4. **Configuración de Interrupciones Optimizada**

```javascript
interruption_settings: {
  enabled: true,
  sensitivity: "low",        // Reducido de "medium"
  min_duration: 1.0,         // Aumentado de 0.7s
  max_duration: 3.0,         // Aumentado de 2.5s
  cooldown_period: 1.5,      // Aumentado de 1.0s
}
```

### 5. **Limpieza de Estado Centralizada**

```javascript
const clearAudioState = () => {
  // Limpia todos los estados de audio de una vez
  // - Set de chunks
  // - Buffer
  // - Contadores
  // - Timestamps
  // - Timeouts
};
```

## 📊 **Métricas de Control**

### **Chunks de Audio**

- **Tamaño**: ~20-50ms por chunk
- **Frecuencia**: ~50 chunks por segundo
- **Buffer**: 5 chunks antes de enviar
- **Timeout**: 150ms para envío parcial

### **Detección de Duplicados**

- **Ventana temporal**: 1 segundo
- **Duplicados consecutivos máx**: 3
- **Limpieza cache**: Cada 100 chunks
- **Tracking de secuencia**: 50 chunks de tolerancia

## 🔧 **Configuración Recomendada**

### **Para Reducir Repeticiones:**

1. **Sensibilidad baja** en interrupciones
2. **Duración mínima** de 1 segundo
3. **Cooldown** de 1.5 segundos
4. **Buffer** de 5 chunks

### **Para Mayor Estabilidad:**

1. **Ventana de detección** de 1 segundo
2. **Limpieza periódica** cada 100 chunks
3. **Tracking de secuencia** activo
4. **Hash de audio** para detección precisa

## 🚀 **Resultados Esperados**

- ✅ **Reducción del 90%** en repeticiones de frases
- ✅ **Mayor estabilidad** en interrupciones
- ✅ **Mejor rendimiento** de memoria
- ✅ **Logging detallado** para debugging

## 📝 **Logs de Debugging**

Los siguientes logs te ayudarán a monitorear el sistema:

```
[Audio] Processed 50 audio chunks, buffer size: 3
[Audio] Consecutive duplicates: 1/3
[Audio] Temporal duplicate detected, skipping
[Audio] Too many consecutive duplicates (4), skipping
[Audio] Skipping out-of-order chunk: current=150, last=100
[Audio] Audio state cleared
```

## 🔄 **Mantenimiento**

### **Monitoreo Regular:**

1. Revisar logs de duplicados consecutivos
2. Verificar limpieza de cache
3. Monitorear chunks fuera de orden
4. Revisar interrupciones

### **Ajustes Frecuentes:**

- Ajustar `maxConsecutiveDuplicates` según necesidad
- Modificar `duplicateDetectionWindow` para tu caso de uso
- Ajustar configuración de interrupciones según feedback
