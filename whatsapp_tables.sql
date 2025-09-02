-- Tabla para conversaciones de WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL, -- Número del usuario
    twilio_number VARCHAR(20) NOT NULL, -- Número de Twilio
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    message_count INTEGER DEFAULT 0,
    last_message_at TIMESTAMP WITH TIME ZONE,
    last_ai_response TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    closed_at TIMESTAMP WITH TIME ZONE
);

-- Crear constraint único después de la tabla (con manejo de errores)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'unique_active_conversation'
    ) THEN
        ALTER TABLE whatsapp_conversations ADD CONSTRAINT unique_active_conversation UNIQUE (phone_number, twilio_number, status);
    END IF;
END $$;

-- Tabla para mensajes individuales
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    message_content TEXT NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    external_message_id VARCHAR(100), -- MessageSid de Twilio
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Crear foreign key después de la tabla (con manejo de errores)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_conversation'
    ) THEN
        ALTER TABLE whatsapp_messages ADD CONSTRAINT fk_conversation 
            FOREIGN KEY (conversation_id) REFERENCES whatsapp_conversations(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Tabla para configuraciones de WhatsApp por usuario
CREATE TABLE IF NOT EXISTS whatsapp_configs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    twilio_phone_number VARCHAR(20) NOT NULL,
    openai_model VARCHAR(50) DEFAULT 'gpt-3.5-turbo',
    system_prompt TEXT DEFAULT 'Eres un asistente virtual profesional y amigable.',
    max_tokens INTEGER DEFAULT 500,
    temperature DECIMAL(3,2) DEFAULT 0.7,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Crear constraint único después de la tabla (con manejo de errores)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'unique_user_phone'
    ) THEN
        ALTER TABLE whatsapp_configs ADD CONSTRAINT unique_user_phone UNIQUE (user_id, twilio_phone_number);
    END IF;
END $$;

-- Tabla para logs de webhooks de WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_webhook_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id),
    twilio_phone_number VARCHAR(20) NOT NULL,
    webhook_type VARCHAR(50) NOT NULL, -- 'message', 'status_update', etc.
    request_payload JSONB,
    response_status INTEGER,
    response_body TEXT,
    execution_time_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_whatsapp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para updated_at
CREATE TRIGGER update_whatsapp_conversations_updated_at
    BEFORE UPDATE ON whatsapp_conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_updated_at();

CREATE TRIGGER update_whatsapp_configs_updated_at
    BEFORE UPDATE ON whatsapp_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_updated_at();

-- Función para obtener estadísticas de WhatsApp
CREATE OR REPLACE FUNCTION get_whatsapp_stats(user_id_param UUID DEFAULT NULL)
RETURNS TABLE (
    total_conversations BIGINT,
    active_conversations BIGINT,
    total_messages BIGINT,
    avg_messages_per_conversation DECIMAL(10,2),
    conversations_24h BIGINT,
    messages_24h BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(DISTINCT wc.id)::BIGINT as total_conversations,
        COUNT(DISTINCT CASE WHEN wc.status = 'active' THEN wc.id END)::BIGINT as active_conversations,
        COUNT(wm.id)::BIGINT as total_messages,
        CASE 
            WHEN COUNT(DISTINCT wc.id) > 0 THEN 
                ROUND(COUNT(wm.id)::DECIMAL / COUNT(DISTINCT wc.id), 2)
            ELSE 0 
        END as avg_messages_per_conversation,
        COUNT(DISTINCT CASE WHEN wc.created_at >= NOW() - INTERVAL '24 hours' THEN wc.id END)::BIGINT as conversations_24h,
        COUNT(CASE WHEN wm.created_at >= NOW() - INTERVAL '24 hours' THEN wm.id END)::BIGINT as messages_24h
    FROM whatsapp_conversations wc
    LEFT JOIN whatsapp_messages wm ON wc.id = wm.conversation_id
    WHERE (user_id_param IS NULL OR wc.user_id = user_id_param);
END;
$$ LANGUAGE plpgsql;

-- RLS Policies para seguridad
ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Policy para conversaciones (usuarios solo ven sus propias conversaciones)
CREATE POLICY "Users can view own whatsapp conversations" ON whatsapp_conversations
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own whatsapp conversations" ON whatsapp_conversations
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own whatsapp conversations" ON whatsapp_conversations
    FOR UPDATE USING (auth.uid() = user_id);

-- Policy para mensajes
CREATE POLICY "Users can view messages from own conversations" ON whatsapp_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM whatsapp_conversations wc 
            WHERE wc.id = whatsapp_messages.conversation_id 
            AND wc.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert messages to own conversations" ON whatsapp_messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM whatsapp_conversations wc 
            WHERE wc.id = whatsapp_messages.conversation_id 
            AND wc.user_id = auth.uid()
        )
    );

-- Policy para configuraciones
CREATE POLICY "Users can view own whatsapp configs" ON whatsapp_configs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own whatsapp configs" ON whatsapp_configs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own whatsapp configs" ON whatsapp_configs
    FOR UPDATE USING (auth.uid() = user_id);

-- Policy para logs (usuarios solo ven sus propios logs)
CREATE POLICY "Users can view own whatsapp logs" ON whatsapp_webhook_logs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own whatsapp logs" ON whatsapp_webhook_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Insertar configuraciones por defecto para usuarios existentes (opcional)
-- INSERT INTO whatsapp_configs (user_id, twilio_phone_number, system_prompt)
-- SELECT id, '+1234567890', 'Eres un asistente virtual profesional y amigable.'
-- FROM auth.users
-- WHERE NOT EXISTS (
--     SELECT 1 FROM whatsapp_configs wc WHERE wc.user_id = auth.users.id
-- );

-- Comentarios para documentación
COMMENT ON TABLE whatsapp_conversations IS 'Almacena conversaciones activas de WhatsApp';
COMMENT ON TABLE whatsapp_messages IS 'Almacena todos los mensajes de WhatsApp';
COMMENT ON TABLE whatsapp_configs IS 'Configuraciones personalizadas de WhatsApp por usuario';
COMMENT ON TABLE whatsapp_webhook_logs IS 'Logs de webhooks de WhatsApp para debugging';

COMMENT ON COLUMN whatsapp_conversations.phone_number IS 'Número de teléfono del usuario de WhatsApp';
COMMENT ON COLUMN whatsapp_conversations.twilio_number IS 'Número de Twilio que recibe/envía mensajes';
COMMENT ON COLUMN whatsapp_conversations.status IS 'Estado de la conversación: active, closed, archived';
COMMENT ON COLUMN whatsapp_conversations.last_ai_response IS 'Última respuesta generada por IA';

COMMENT ON COLUMN whatsapp_messages.direction IS 'Dirección del mensaje: incoming (del usuario) o outgoing (de la IA)';
COMMENT ON COLUMN whatsapp_messages.external_message_id IS 'ID del mensaje en Twilio (MessageSid)';

COMMENT ON COLUMN whatsapp_configs.system_prompt IS 'Prompt del sistema para OpenAI';
COMMENT ON COLUMN whatsapp_configs.openai_model IS 'Modelo de OpenAI a usar';
COMMENT ON COLUMN whatsapp_configs.temperature IS 'Temperatura para la generación de respuestas (0.0 a 1.0)';

-- Índices adicionales para performance
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone_status ON whatsapp_conversations(phone_number, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_user_status ON whatsapp_conversations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_created ON whatsapp_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_created ON whatsapp_messages(phone_number, created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_configs_user_active ON whatsapp_configs(user_id, is_active);

-- Vista para conversaciones con información resumida
CREATE OR REPLACE VIEW whatsapp_conversations_summary AS
SELECT 
    wc.id,
    wc.phone_number,
    wc.twilio_number,
    wc.status,
    wc.message_count,
    wc.last_message_at,
    wc.last_ai_response,
    wc.created_at,
    wc.updated_at,
    wc.closed_at,
    -- Último mensaje del usuario
    (SELECT wm.message_content 
     FROM whatsapp_messages wm 
     WHERE wm.conversation_id = wc.id 
     AND wm.direction = 'incoming' 
     ORDER BY wm.created_at DESC 
     LIMIT 1) as last_user_message,
    -- Tiempo desde el último mensaje
    EXTRACT(EPOCH FROM (NOW() - wc.last_message_at)) / 3600 as hours_since_last_message
FROM whatsapp_conversations wc
ORDER BY wc.last_message_at DESC;

-- Función para limpiar conversaciones antiguas (opcional)
CREATE OR REPLACE FUNCTION cleanup_old_whatsapp_conversations(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM whatsapp_conversations 
    WHERE status = 'closed' 
    AND closed_at < NOW() - INTERVAL '1 day' * days_to_keep;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Función para obtener métricas de engagement
CREATE OR REPLACE FUNCTION get_whatsapp_engagement_metrics(user_id_param UUID DEFAULT NULL)
RETURNS TABLE (
    total_users BIGINT,
    active_users_24h BIGINT,
    active_users_7d BIGINT,
    avg_response_time_minutes DECIMAL(10,2),
    total_ai_responses BIGINT,
    avg_messages_per_user DECIMAL(10,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(DISTINCT wc.phone_number)::BIGINT as total_users,
        COUNT(DISTINCT CASE WHEN wc.last_message_at >= NOW() - INTERVAL '24 hours' THEN wc.phone_number END)::BIGINT as active_users_24h,
        COUNT(DISTINCT CASE WHEN wc.last_message_at >= NOW() - INTERVAL '7 days' THEN wc.phone_number END)::BIGINT as active_users_7d,
        ROUND(AVG(
            EXTRACT(EPOCH FROM (wm_out.created_at - wm_in.created_at)) / 60
        ), 2) as avg_response_time_minutes,
        COUNT(CASE WHEN wm.direction = 'outgoing' THEN wm.id END)::BIGINT as total_ai_responses,
        ROUND(AVG(message_count), 2) as avg_messages_per_user
    FROM whatsapp_conversations wc
    LEFT JOIN whatsapp_messages wm ON wc.id = wm.conversation_id
    LEFT JOIN whatsapp_messages wm_in ON wc.id = wm_in.conversation_id AND wm_in.direction = 'incoming'
    LEFT JOIN whatsapp_messages wm_out ON wc.id = wm_out.conversation_id AND wm_out.direction = 'outgoing'
    WHERE (user_id_param IS NULL OR wc.user_id = user_id_param)
    AND wm_out.created_at > wm_in.created_at;
END;
$$ LANGUAGE plpgsql;

-- Comentarios finales
COMMENT ON FUNCTION get_whatsapp_stats IS 'Obtiene estadísticas generales de WhatsApp';
COMMENT ON FUNCTION cleanup_old_whatsapp_conversations IS 'Limpia conversaciones cerradas antiguas';
COMMENT ON FUNCTION get_whatsapp_engagement_metrics IS 'Obtiene métricas de engagement de usuarios';
COMMENT ON VIEW whatsapp_conversations_summary IS 'Vista resumida de conversaciones con información adicional';

-- Verificar que las tablas se crearon correctamente
SELECT 'whatsapp_conversations' as table_name, COUNT(*) as row_count FROM whatsapp_conversations
UNION ALL
SELECT 'whatsapp_messages' as table_name, COUNT(*) as row_count FROM whatsapp_messages
UNION ALL
SELECT 'whatsapp_configs' as table_name, COUNT(*) as row_count FROM whatsapp_configs
UNION ALL
SELECT 'whatsapp_webhook_logs' as table_name, COUNT(*) as row_count FROM whatsapp_webhook_logs;
