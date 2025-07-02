-- Script para agregar el campo transcript_summary_es a la tabla calls
-- Ejecutar en el SQL Editor de Supabase

-- Agregar la columna transcript_summary_es para almacenar el resumen traducido al español
ALTER TABLE calls 
ADD COLUMN transcript_summary_es TEXT;

-- Agregar comentario descriptivo a la columna
COMMENT ON COLUMN calls.transcript_summary_es IS 'Resumen de la conversación traducido al español usando OpenAI';

-- Verificar que la columna se agregó correctamente
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default
FROM information_schema.columns 
WHERE table_name = 'calls' 
AND column_name = 'transcript_summary_es'; 