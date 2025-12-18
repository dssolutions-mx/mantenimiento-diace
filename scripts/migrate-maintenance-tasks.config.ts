/**
 * Configuration for maintenance tasks migration
 * Migrates maintenance_tasks from source project to destination project
 */

import dotenv from 'dotenv'
import path from 'path'

// Load environment variables from .env.local before accessing them
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

export const MIGRATION_CONFIG = {
  source: {
    projectRef: 'txapndpstzcspgxlybll',
    url: 'https://txapndpstzcspgxlybll.supabase.co',
    serviceRoleKey: process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY!,
  },
  destination: {
    projectRef: 'rfsjdnuctrsippugwgpz',
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  models: [
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER',
  ],
  batchSize: 100, // Number of tasks to insert per batch
  retryAttempts: 3, // Number of retry attempts for failed operations
  retryDelayMs: 1000, // Initial delay between retries (exponential backoff)
}

export interface MigrationProgress {
  completedModels: string[]
  currentModel?: string
  stats: {
    totalModels: number
    totalTasksFound: number
    totalTasksMigrated: number
    totalTasksSkipped: number
    totalErrors: number
  }
  modelStats: Record<
    string,
    {
      tasksFound: number
      tasksMigrated: number
      tasksSkipped: number
      errors: number
      skippedReasons: string[]
    }
  >
  errors: Array<{
    model: string
    error: string
    timestamp: string
  }>
  startedAt?: string
  lastUpdatedAt?: string
}
