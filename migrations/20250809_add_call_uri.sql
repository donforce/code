-- Add Call URI for Twilio reference
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_uri TEXT;
COMMENT ON COLUMN calls.call_uri IS 'Twilio Call URI (/2010-04-01/Accounts/.../Calls/{CallSid}.json)'; 