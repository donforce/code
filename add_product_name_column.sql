-- Add product_name column to user_subscriptions table
ALTER TABLE user_subscriptions 
ADD COLUMN IF NOT EXISTS product_name TEXT;

-- Add comment to document the column
COMMENT ON COLUMN user_subscriptions.product_name IS 'Name of the Stripe product associated with this subscription';

-- Verify the column was added
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'user_subscriptions' 
AND column_name = 'product_name'; 