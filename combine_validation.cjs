const fs = require("fs");
const path = require("path");

console.log("🔄 [VALIDATION] Combinando datasets de validación...");

// Archivos de validación
const validationFiles = [
  "validation.jsonl",
  "validation_registered_users.jsonl",
];

// Array para almacenar todas las entradas de validación
let allValidationEntries = [];

// Leer y procesar cada archivo de validación
validationFiles.forEach((filename, index) => {
  try {
    if (fs.existsSync(filename)) {
      const content = fs.readFileSync(filename, "utf8");
      const lines = content.trim().split("\n");

      console.log(
        `📁 [VALIDATION] Procesando ${filename}: ${lines.length} entradas`
      );

      lines.forEach((line, lineIndex) => {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            allValidationEntries.push(entry);
          } catch (parseError) {
            console.warn(
              `⚠️ [VALIDATION] Error parseando línea ${
                lineIndex + 1
              } en ${filename}:`,
              parseError.message
            );
          }
        }
      });
    } else {
      console.warn(`⚠️ [VALIDATION] Archivo no encontrado: ${filename}`);
    }
  } catch (error) {
    console.error(`❌ [VALIDATION] Error leyendo ${filename}:`, error.message);
  }
});

// Crear archivo de validación combinado
const combinedValidationFile = "validation_combined.jsonl";
const combinedContent = allValidationEntries
  .map((entry) => JSON.stringify(entry))
  .join("\n");

try {
  fs.writeFileSync(combinedValidationFile, combinedContent);
  console.log(
    `✅ [VALIDATION] Archivo combinado creado: ${combinedValidationFile}`
  );
  console.log(
    `📊 [VALIDATION] Total de entradas: ${allValidationEntries.length}`
  );
} catch (error) {
  console.error(
    `❌ [VALIDATION] Error escribiendo archivo combinado:`,
    error.message
  );
}

// Crear archivo de estadísticas
const stats = {
  total_validation_entries: allValidationEntries.length,
  files_processed: validationFiles.filter((f) => fs.existsSync(f)).length,
  timestamp: new Date().toISOString(),
  validation_topics: {
    general_questions: 0,
    registered_user_questions: 0,
    tool_usage_examples: 0,
  },
};

// Analizar contenido para estadísticas
allValidationEntries.forEach((entry) => {
  const userMessage =
    entry.messages.find((m) => m.role === "user")?.content || "";
  const assistantMessage =
    entry.messages.find((m) => m.role === "assistant")?.content || "";

  if (
    userMessage.includes("créditos") ||
    userMessage.includes("leads") ||
    userMessage.includes("facturación")
  ) {
    stats.validation_topics.registered_user_questions++;
  } else if (
    assistantMessage.includes("herramientas") ||
    assistantMessage.includes("revisar")
  ) {
    stats.validation_topics.tool_usage_examples++;
  } else {
    stats.validation_topics.general_questions++;
  }
});

try {
  fs.writeFileSync("validation_stats.json", JSON.stringify(stats, null, 2));
  console.log(`📊 [VALIDATION] Estadísticas guardadas: validation_stats.json`);
} catch (error) {
  console.error(`❌ [VALIDATION] Error guardando estadísticas:`, error.message);
}

console.log("✅ [VALIDATION] Proceso completado exitosamente");
console.log("\n📋 [VALIDATION] Resumen:");
console.log(`   • Entradas totales: ${stats.total_validation_entries}`);
console.log(`   • Archivos procesados: ${stats.files_processed}`);
console.log(
  `   • Preguntas generales: ${stats.validation_topics.general_questions}`
);
console.log(
  `   • Preguntas de usuarios registrados: ${stats.validation_topics.registered_user_questions}`
);
console.log(
  `   • Ejemplos de uso de herramientas: ${stats.validation_topics.tool_usage_examples}`
);
console.log(`   • Archivo combinado: ${combinedValidationFile}`);
console.log(`   • Estadísticas: validation_stats.json`);
