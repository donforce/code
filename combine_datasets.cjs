const fs = require("fs");
const path = require("path");

// Función para combinar datasets
function combineDatasets() {
  try {
    console.log("🔄 Combinando datasets...");

    // Leer el dataset original
    const originalData = fs.readFileSync("train.jsonl", "utf8");
    const originalLines = originalData.trim().split("\n");

    // Leer el dataset de usuarios registrados
    const registeredData = fs.readFileSync(
      "train_registered_users.jsonl",
      "utf8"
    );
    const registeredLines = registeredData.trim().split("\n");

    // Combinar ambos datasets
    const combinedLines = [...originalLines, ...registeredLines];

    // Crear el dataset combinado
    const combinedData = combinedLines.join("\n");

    // Guardar el dataset combinado
    fs.writeFileSync("train_combined.jsonl", combinedData);

    console.log("✅ Dataset combinado creado exitosamente!");
    console.log(`📊 Total de ejemplos: ${combinedLines.length}`);
    console.log(`   - Prospectos nuevos: ${originalLines.length}`);
    console.log(`   - Usuarios registrados: ${registeredLines.length}`);
    console.log("📁 Archivo guardado como: train_combined.jsonl");

    // Crear también un archivo de estadísticas
    const stats = {
      total_examples: combinedLines.length,
      new_prospects: originalLines.length,
      registered_users: registeredLines.length,
      created_at: new Date().toISOString(),
      description:
        "Dataset combinado para fine-tuning de OpenAI con conversaciones de prospectos nuevos y usuarios registrados",
    };

    fs.writeFileSync("dataset_stats.json", JSON.stringify(stats, null, 2));
    console.log("📊 Estadísticas guardadas en: dataset_stats.json");
  } catch (error) {
    console.error("❌ Error combinando datasets:", error);
  }
}

// Función para validar el formato JSONL
function validateJSONL(filename) {
  try {
    console.log(`🔍 Validando formato de ${filename}...`);

    const data = fs.readFileSync(filename, "utf8");
    const lines = data.trim().split("\n");

    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]);
        validCount++;
      } catch (error) {
        console.error(
          `❌ Línea ${i + 1} inválida en ${filename}:`,
          error.message
        );
        invalidCount++;
      }
    }

    console.log(
      `✅ ${filename}: ${validCount} líneas válidas, ${invalidCount} inválidas`
    );
    return validCount;
  } catch (error) {
    console.error(`❌ Error validando ${filename}:`, error);
    return 0;
  }
}

// Función principal
function main() {
  console.log("🚀 Iniciando proceso de combinación de datasets...\n");

  // Validar ambos archivos
  const originalValid = validateJSONL("train.jsonl");
  const registeredValid = validateJSONL("train_registered_users.jsonl");

  if (originalValid > 0 && registeredValid > 0) {
    console.log(
      "\n✅ Ambos archivos son válidos, procediendo con la combinación...\n"
    );
    combineDatasets();
  } else {
    console.log("\n❌ No se puede proceder con archivos inválidos");
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main();
}

module.exports = { combineDatasets, validateJSONL };
