-- Agregar campos necesarios para la nueva API de Responses de OpenAI
-- Ejecutar en Supabase SQL Editor

-- Agregar campo para el ID del último response de OpenAI
ALTER TABLE whatsapp_conversations 
ADD COLUMN IF NOT EXISTS last_response_id TEXT;

-- Agregar campo para la última respuesta de IA
ALTER TABLE whatsapp_conversations 
ADD COLUMN IF NOT EXISTS last_ai_response TEXT;

-- Agregar comentarios para documentar los nuevos campos
COMMENT ON COLUMN whatsapp_conversations.last_response_id IS 'ID del último response de OpenAI para mantener memoria de conversación';
COMMENT ON COLUMN whatsapp_conversations.last_ai_response IS 'Última respuesta generada por IA para referencia';

-- Verificar que los campos se agregaron correctamente
SELECT 
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'whatsapp_conversations' 
  AND column_name IN ('last_response_id', 'last_ai_response')
ORDER BY column_name;
