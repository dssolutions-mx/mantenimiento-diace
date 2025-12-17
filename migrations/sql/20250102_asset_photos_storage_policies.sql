-- Asset Photos Storage RLS Policies
-- Safe to run multiple times (uses IF NOT EXISTS and DROP IF EXISTS)

BEGIN;

-- Drop existing policies if they exist (to allow re-running)
DROP POLICY IF EXISTS "Authenticated users can view asset photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload asset photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own asset photos within 1h" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own asset photos within 1h" ON storage.objects;

-- Policy: Authenticated users can view asset photos
CREATE POLICY "Authenticated users can view asset photos"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'asset-photos'
    AND auth.role() = 'authenticated'
  );

-- Policy: Authenticated users can upload asset photos
CREATE POLICY "Authenticated users can upload asset photos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'asset-photos'
    AND auth.role() = 'authenticated'
  );

-- Policy: Users can update their own uploads (within 1 hour)
CREATE POLICY "Users can update own asset photos within 1h"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'asset-photos'
    AND owner = auth.uid()
    AND created_at > NOW() - INTERVAL '1 hour'
  );

-- Policy: Users can delete their own uploads (within 1 hour)
CREATE POLICY "Users can delete own asset photos within 1h"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'asset-photos'
    AND owner = auth.uid()
    AND created_at > NOW() - INTERVAL '1 hour'
  );

COMMIT;

-- =====================================================
-- RLS Policies Complete for asset-photos bucket
-- =====================================================
-- Summary:
-- ✅ Authenticated users can view all asset photos
-- ✅ Authenticated users can upload asset photos
-- ✅ Users can update their own uploads within 1 hour
-- ✅ Users can delete their own uploads within 1 hour
-- =====================================================
