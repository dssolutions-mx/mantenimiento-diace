import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get current user and check permissions
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if user has admin permissions
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!profile || !['GERENCIA_GENERAL', 'AREA_ADMINISTRATIVA'].includes(profile.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    console.log('Applying asset-photos storage RLS policies...')

    // Read the migration SQL file
    const migrationPath = join(process.cwd(), 'migrations', 'sql', '20250102_asset_photos_storage_policies.sql')
    const migrationSQL = readFileSync(migrationPath, 'utf-8')

    // Use admin client to execute the migration
    const adminClient = createAdminClient()

    // Execute the migration SQL
    // Note: Supabase JS client doesn't have direct SQL execution, so we'll use the REST API
    // For storage policies, we need to execute via Postgres directly
    // This requires using the Supabase Management API or executing via SQL editor
    
    // Try to execute via RPC if exec_sql function exists
    const { error: rpcError } = await adminClient.rpc('exec_sql', {
      sql: migrationSQL
    })

    if (rpcError) {
      // If RPC doesn't work, try alternative approach
      console.log('RPC exec_sql not available, trying alternative method...')
      
      // Split SQL into individual statements and execute via REST API
      // For storage policies, we need to use the Postgres connection
      // Since we can't execute raw SQL via JS client, we'll return instructions
      
      return NextResponse.json({
        success: false,
        message: 'Direct SQL execution not available via API',
        instructions: [
          'Please run the migration SQL manually in Supabase SQL Editor:',
          '1. Go to Supabase Dashboard > SQL Editor',
          '2. Copy the contents of migrations/sql/20250102_asset_photos_storage_policies.sql',
          '3. Paste and execute the SQL',
          '4. Verify policies were created successfully'
        ],
        migrationSQL: migrationSQL,
        error: rpcError.message
      }, { status: 200 })
    }

    console.log('✅ Asset photos storage RLS policies applied successfully')

    return NextResponse.json({
      success: true,
      message: 'Asset photos storage RLS policies applied successfully',
      changes: [
        'Authenticated users can view asset photos',
        'Authenticated users can upload asset photos',
        'Users can update their own uploads within 1 hour',
        'Users can delete their own uploads within 1 hour'
      ]
    })

  } catch (error: any) {
    console.error('Storage policy migration error:', error)
    
    // Read migration file to include in response
    try {
      const migrationPath = join(process.cwd(), 'migrations', 'sql', '20250102_asset_photos_storage_policies.sql')
      const migrationSQL = readFileSync(migrationPath, 'utf-8')
      
      return NextResponse.json({
        success: false,
        error: error.message,
        message: 'Please run the migration SQL manually',
        instructions: [
          'Go to Supabase Dashboard > SQL Editor',
          'Copy and execute the SQL below:'
        ],
        migrationSQL: migrationSQL
      }, { status: 500 })
    } catch (readError) {
      return NextResponse.json({ 
        error: 'Failed to apply migration. Please run migrations/sql/20250102_asset_photos_storage_policies.sql manually in Supabase SQL Editor.',
        details: error.message
      }, { status: 500 })
    }
  }
}
