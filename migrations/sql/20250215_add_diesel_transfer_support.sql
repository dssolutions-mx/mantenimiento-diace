-- Migration: Add diesel transfer support
-- Date: 2025-02-15
-- Description: Add is_transfer flag to diesel_transactions to properly handle transfers between plants

-- Add is_transfer column to diesel_transactions
ALTER TABLE diesel_transactions 
ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN DEFAULT false NOT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN diesel_transactions.is_transfer IS 
'Indicates if this transaction is part of a transfer between plants. Transfers should be excluded from consumption reports but still affect inventory.';

-- Create index for efficient filtering of transfers
CREATE INDEX IF NOT EXISTS idx_diesel_transactions_is_transfer 
ON diesel_transactions(is_transfer) 
WHERE is_transfer = true;

-- Create index for reference_transaction_id lookups (for transfer pairs)
CREATE INDEX IF NOT EXISTS idx_diesel_transactions_reference_transaction_id 
ON diesel_transactions(reference_transaction_id) 
WHERE reference_transaction_id IS NOT NULL;
