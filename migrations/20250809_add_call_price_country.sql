-- Add call pricing and destination info for admin reporting
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_price NUMERIC(10,5);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_price_unit TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS to_number TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS to_country TEXT;

COMMENT ON COLUMN calls.call_price IS 'Costo de la llamada (valor absoluto, Twilio entrega negativo)';
COMMENT ON COLUMN calls.call_price_unit IS 'Unidad de precio reportada por Twilio (e.g., USD)';
COMMENT ON COLUMN calls.to_number IS 'Número de destino marcado (E.164)';
COMMENT ON COLUMN calls.to_country IS 'País del número destino (código ISO)'; 