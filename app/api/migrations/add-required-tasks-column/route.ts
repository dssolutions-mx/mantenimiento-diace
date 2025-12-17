import { NextRequest, NextResponse } from "next/server"
import { createClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get current user and check permissions
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log('Checking work_orders table schema for required_tasks column...')

    // Check if the column already exists by querying the information_schema
    const { data: columnCheck, error: checkError } = await supabase
      .rpc('exec_sql', {
        sql: `
          SELECT column_name, data_type, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
          AND table_name = 'work_orders'
          AND column_name = 'required_tasks';
        `
      })
      .catch(async () => {
        // If exec_sql doesn't work, try alternative approach
        const { data: altCheck } = await supabase
          .from('work_orders')
          .select('required_tasks')
          .limit(1)
        
        return { data: altCheck ? [{ column_name: 'required_tasks' }] : null, error: null }
      })

    // If column exists, return success
    if (columnCheck && Array.isArray(columnCheck) && columnCheck.length > 0) {
      console.log('Column required_tasks already exists')
      return NextResponse.json({ 
        success: true, 
        message: 'Column required_tasks already exists',
        columnExists: true
      })
    }

    console.log('Column required_tasks does not exist. Applying migration...')

    // Apply the migration (using DO block for safety)
    const migrationSQL = `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 
          FROM information_schema.columns 
          WHERE table_schema = 'public' 
          AND table_name = 'work_orders' 
          AND column_name = 'required_tasks'
        ) THEN
          ALTER TABLE work_orders 
          ADD COLUMN required_tasks JSONB DEFAULT '[]'::jsonb;
          
          COMMENT ON COLUMN work_orders.required_tasks IS 'Array of maintenance tasks from the maintenance plan, stored as JSONB with task details including id, description, type, estimated_time, requires_specialist, and associated parts';
        END IF;
      END $$;
    `

    // Try to execute via RPC if exec_sql function exists
    const { error: rpcError } = await supabase.rpc('exec_sql', {
      sql: migrationSQL
    })

    if (rpcError) {
      console.log('RPC exec_sql failed, trying alternative approach...')
      
      // Alternative: Use a migration function approach
      // Since we can't execute DDL directly, we'll return the SQL for manual execution
      return NextResponse.json({
        success: false,
        message: 'Please execute the following SQL in Supabase SQL Editor',
        sql: migrationSQL,
        instructions: [
          '1. Go to Supabase Dashboard',
          '2. Navigate to SQL Editor',
          '3. Execute the SQL provided above',
          '4. Verify the column was added by checking the table schema'
        ]
      })
    }

    console.log('Migration applied successfully')
    return NextResponse.json({ 
      success: true, 
      message: 'Column required_tasks added successfully',
      columnExists: true
    })

  } catch (error: any) {
    console.error('Error applying migration:', error)
    return NextResponse.json({ 
      error: error.message || 'Failed to apply migration',
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'work_orders' 
            AND column_name = 'required_tasks'
          ) THEN
            ALTER TABLE work_orders 
            ADD COLUMN required_tasks JSONB DEFAULT '[]'::jsonb;
            
            COMMENT ON COLUMN work_orders.required_tasks IS 'Array of maintenance tasks from the maintenance plan, stored as JSONB with task details including id, description, type, estimated_time, requires_specialist, and associated parts';
          END IF;
        END $$;
      `,
      instructions: 'Please execute the SQL above in Supabase SQL Editor'
    }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Migration: Add required_tasks column to work_orders table',
    sql: `
      ALTER TABLE work_orders 
      ADD COLUMN IF NOT EXISTS required_tasks JSONB DEFAULT '[]'::jsonb;
    `,
    instructions: [
      '1. Go to Supabase Dashboard',
      '2. Navigate to SQL Editor',
      '3. Execute the SQL provided above',
      '4. Verify the column was added by checking the table schema'
    ]
  })
}
