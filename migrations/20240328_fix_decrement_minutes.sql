-- Drop existing function if it exists
DROP FUNCTION IF EXISTS decrement_minutes;

-- Create the corrected function that handles seconds
CREATE OR REPLACE FUNCTION decrement_minutes(uid UUID, mins INTEGER)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Update user's available minutes, ensuring it doesn't go below 0
    -- mins parameter is in seconds, so we subtract it directly
    UPDATE users
    SET available_minutes = GREATEST(0, available_minutes - mins)
    WHERE id = uid;
END;
$$; 