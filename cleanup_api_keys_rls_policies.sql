-- Limpiar políticas RLS duplicadas para api_keys
-- Eliminar políticas antiguas que solo permiten acceso propio

-- Eliminar políticas para {authenticated} que son más restrictivas
DROP POLICY IF EXISTS "Users can view own api keys" ON api_keys;
DROP POLICY IF EXISTS "Users can insert own api keys" ON api_keys;
DROP POLICY IF EXISTS "Users can update own api keys" ON api_keys;
DROP POLICY IF EXISTS "Users can delete own api keys" ON api_keys;

-- Eliminar política duplicada de SELECT
DROP POLICY IF EXISTS "Users can view their own API keys" ON api_keys;

-- Mantener solo las políticas que permiten acceso de administradores:
-- - "Users can view own api_keys, admins can view all"
-- - "Users can insert own api_keys, admins can insert for any user"
-- - "Users can update own api_keys, admins can update any api_key"
-- - "Users can delete own api_keys, admins can delete any api_key"
-- - "Admins can view all API keys"
-- - "Service role can manage api keys"

-- Verificar las políticas finales
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename = 'api_keys'
ORDER BY cmd, policyname;
