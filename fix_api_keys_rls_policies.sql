-- Actualizar políticas RLS para api_keys para permitir acceso de administradores
-- Primero, eliminar las políticas existentes
DROP POLICY IF EXISTS "Users can view own api_keys" ON api_keys;
DROP POLICY IF EXISTS "Users can insert own api_keys" ON api_keys;
DROP POLICY IF EXISTS "Users can update own api_keys" ON api_keys;
DROP POLICY IF EXISTS "Users can delete own api_keys" ON api_keys;

-- Crear nuevas políticas que permitan acceso de administradores

-- Política para SELECT: Usuarios pueden ver sus propias API keys, admins pueden ver todas
CREATE POLICY "Users can view own api_keys, admins can view all" ON api_keys
FOR SELECT USING (
  auth.uid() = user_id OR 
  EXISTS (
    SELECT 1 FROM users 
    WHERE users.id = auth.uid() AND users.is_admin = true
  )
);

-- Política para INSERT: Usuarios pueden crear sus propias API keys, admins pueden crear para cualquier usuario
CREATE POLICY "Users can insert own api_keys, admins can insert for any user" ON api_keys
FOR INSERT WITH CHECK (
  auth.uid() = user_id OR 
  EXISTS (
    SELECT 1 FROM users 
    WHERE users.id = auth.uid() AND users.is_admin = true
  )
);

-- Política para UPDATE: Usuarios pueden actualizar sus propias API keys, admins pueden actualizar cualquier API key
CREATE POLICY "Users can update own api_keys, admins can update any api_key" ON api_keys
FOR UPDATE USING (
  auth.uid() = user_id OR 
  EXISTS (
    SELECT 1 FROM users 
    WHERE users.id = auth.uid() AND users.is_admin = true
  )
);

-- Política para DELETE: Usuarios pueden eliminar sus propias API keys, admins pueden eliminar cualquier API key
CREATE POLICY "Users can delete own api_keys, admins can delete any api_key" ON api_keys
FOR DELETE USING (
  auth.uid() = user_id OR 
  EXISTS (
    SELECT 1 FROM users 
    WHERE users.id = auth.uid() AND users.is_admin = true
  )
);

-- Verificar que las políticas se crearon correctamente
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename = 'api_keys';
