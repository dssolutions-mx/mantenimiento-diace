#!/usr/bin/env tsx
/**
 * Migration script to copy task_parts from source project to destination project
 * This script migrates task_parts for tasks that were already migrated
 * 
 * Usage:
 *   tsx scripts/migrate-task-parts.ts [options]
 * 
 * Options:
 *   --dry-run          Simulate migration without writing data
 *   --models <names>   Comma-separated list of model names to migrate
 *   --verbose          Enable verbose logging
 */

import dotenv from 'dotenv'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { MIGRATION_CONFIG } from './migrate-maintenance-tasks.config'

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// Parse CLI arguments
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const verbose = args.includes('--verbose')
const modelsArg = args.find((arg) => arg.startsWith('--models='))
const modelFilter = modelsArg
  ? modelsArg.split('=')[1].split(',').map((m) => m.trim())
  : null

// Validate environment variables
if (!MIGRATION_CONFIG.source.serviceRoleKey) {
  console.error('❌ Missing SOURCE_SUPABASE_SERVICE_ROLE_KEY environment variable')
  process.exit(1)
}

if (!MIGRATION_CONFIG.destination.url || !MIGRATION_CONFIG.destination.serviceRoleKey) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable')
  process.exit(1)
}

// Initialize Supabase clients
const sourceClient = createClient(
  MIGRATION_CONFIG.source.url,
  MIGRATION_CONFIG.source.serviceRoleKey,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  }
)

const destClient = createClient(
  MIGRATION_CONFIG.destination.url,
  MIGRATION_CONFIG.destination.serviceRoleKey,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  }
)

function log(message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
  const prefix = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    success: '✅',
  }[level]

  const timestamp = new Date().toISOString()
  console.log(`${prefix} [${timestamp}] ${message}`)
}

function verboseLog(message: string) {
  if (verbose) {
    log(message, 'info')
  }
}

// Retry utility with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  attempts: number = MIGRATION_CONFIG.retryAttempts,
  delayMs: number = MIGRATION_CONFIG.retryDelayMs
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      if (attempt < attempts) {
        const delay = delayMs * Math.pow(2, attempt - 1)
        verboseLog(`Attempt ${attempt} failed, retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error('Retry failed')
}

async function migrateTaskPartsForModel(modelName: string): Promise<{
  partsFound: number
  partsMigrated: number
  partsSkipped: number
  errors: number
}> {
  const stats = {
    partsFound: 0,
    partsMigrated: 0,
    partsSkipped: 0,
    errors: 0,
  }

  log(`Processing task_parts for model: ${modelName}`, 'info')

  try {
    // Step 1: Get source model
    const { data: sourceModel, error: sourceModelError } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('equipment_models')
        .select('id, name')
        .eq('name', modelName)
        .maybeSingle()
    })

    if (sourceModelError || !sourceModel) {
      log(`Model not found in source: ${modelName}`, 'warn')
      stats.errors++
      return stats
    }

    // Step 2: Get destination model
    const { data: destModel, error: destModelError } = await retryWithBackoff(async () => {
      return await destClient
        .from('equipment_models')
        .select('id, name')
        .eq('name', modelName)
        .maybeSingle()
    })

    if (destModelError || !destModel) {
      log(`Model not found in destination: ${modelName}`, 'warn')
      stats.errors++
      return stats
    }

    // Step 3: Get source intervals first
    const { data: sourceIntervals, error: sourceIntervalsError } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('maintenance_intervals')
        .select('id, interval_value, model_id')
        .eq('model_id', sourceModel.id)
    })

    if (sourceIntervalsError || !sourceIntervals || sourceIntervals.length === 0) {
      log(`No intervals found for model: ${modelName}`, 'info')
      return stats
    }

    const sourceIntervalIds = sourceIntervals.map((i) => i.id)

    // Step 4: Get source tasks
    const { data: sourceTasks, error: sourceTasksError } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('maintenance_tasks')
        .select('id, interval_id, description, type')
        .in('interval_id', sourceIntervalIds)
    })

    if (sourceTasksError || !sourceTasks || sourceTasks.length === 0) {
      log(`No tasks found for model: ${modelName}`, 'info')
      return stats
    }

    verboseLog(`Found ${sourceTasks.length} source tasks`)

    // Step 5: Get source task_parts
    const sourceTaskIds = sourceTasks.map((t) => t.id)
    const { data: sourceParts, error: sourcePartsError } = await retryWithBackoff(async () => {
      // Fetch in batches
      const allParts: any[] = []
      for (let i = 0; i < sourceTaskIds.length; i += 100) {
        const batch = sourceTaskIds.slice(i, i + 100)
        const { data, error } = await sourceClient
          .from('task_parts')
          .select('id, task_id, name, part_number, quantity, cost')
          .in('task_id', batch)

        if (error) throw error
        if (data) allParts.push(...data)
      }
      return { data: allParts, error: null }
    })

    if (sourcePartsError) {
      log(`Error fetching source task_parts: ${sourcePartsError.message}`, 'error')
      stats.errors++
      return stats
    }

    if (!sourceParts || sourceParts.length === 0) {
      log(`No task_parts found for model: ${modelName}`, 'info')
      return stats
    }

    stats.partsFound = sourceParts.length
    verboseLog(`Found ${sourceParts.length} task_parts to migrate`)

    // Step 6: Get destination intervals
    const { data: destIntervals, error: destIntervalsError } = await retryWithBackoff(async () => {
      return await destClient
        .from('maintenance_intervals')
        .select('id, interval_value, model_id')
        .eq('model_id', destModel.id)
    })

    if (destIntervalsError || !destIntervals) {
      log(`Error fetching destination intervals: ${destIntervalsError?.message}`, 'error')
      stats.errors++
      return stats
    }

    // Create interval mapping
    const intervalMap = new Map<string, string>()
    for (const sourceInterval of sourceIntervals) {
      const destInterval = destIntervals.find(
        (di) => di.interval_value === sourceInterval.interval_value
      )
      if (destInterval) {
        intervalMap.set(sourceInterval.id, destInterval.id)
      }
    }

    // Step 7: Map source task IDs to destination task IDs
    // Match by: interval_id (mapped) + description + type
    const taskIdMap = new Map<string, string>()

    // Map source task IDs to destination task IDs
    for (const sourceTask of sourceTasks) {
      const destIntervalId = intervalMap.get(sourceTask.interval_id)
      if (!destIntervalId) continue

      // Find matching destination task (handle duplicates by taking first match)
      const { data: destTasks, error: destTaskError } = await retryWithBackoff(async () => {
        return await destClient
          .from('maintenance_tasks')
          .select('id')
          .eq('interval_id', destIntervalId)
          .eq('description', sourceTask.description)
          .eq('type', sourceTask.type)
          .limit(1)
      })

      if (destTaskError) {
        verboseLog(`Error finding destination task: ${destTaskError.message}`)
        continue
      }

      if (destTasks && destTasks.length > 0) {
        taskIdMap.set(sourceTask.id, destTasks[0].id)
      }
    }

    verboseLog(`Mapped ${taskIdMap.size} tasks`)

    // Step 8: Migrate task_parts
    const partsToInsert = sourceParts
      .map((part) => {
        const destTaskId = taskIdMap.get(part.task_id)
        if (!destTaskId) {
          stats.partsSkipped++
          return null
        }

        // Check if part already exists
        return {
          task_id: destTaskId,
          name: part.name,
          part_number: part.part_number,
          quantity: part.quantity,
          cost: part.cost,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    if (partsToInsert.length === 0) {
      log(`No task_parts to migrate for ${modelName}`, 'info')
      return stats
    }

    if (isDryRun) {
      log(`[DRY RUN] Would insert ${partsToInsert.length} task_parts for ${modelName}`, 'info')
      stats.partsMigrated = partsToInsert.length
    } else {
      // Check for duplicates before inserting
      const partsToInsertFiltered: typeof partsToInsert = []
      for (const part of partsToInsert) {
        const { data: existing } = await retryWithBackoff(async () => {
          return await destClient
            .from('task_parts')
            .select('id')
            .eq('task_id', part.task_id)
            .eq('name', part.name)
            .maybeSingle()
        })

        if (!existing) {
          partsToInsertFiltered.push(part)
        } else {
          stats.partsSkipped++
        }
      }

      if (partsToInsertFiltered.length > 0) {
        // Insert in batches
        for (let i = 0; i < partsToInsertFiltered.length; i += MIGRATION_CONFIG.batchSize) {
          const batch = partsToInsertFiltered.slice(i, i + MIGRATION_CONFIG.batchSize)

          try {
            const { error: insertError } = await retryWithBackoff(async () => {
              return await destClient.from('task_parts').insert(batch)
            })

            if (insertError) {
              throw insertError
            }

            stats.partsMigrated += batch.length
            verboseLog(`Inserted batch ${Math.floor(i / MIGRATION_CONFIG.batchSize) + 1} (${batch.length} parts)`)
          } catch (error) {
            stats.errors++
            log(`Failed to insert batch: ${(error as Error).message}`, 'error')
          }
        }
      }
    }

    log(
      `Completed ${modelName}: ${stats.partsMigrated} migrated, ${stats.partsSkipped} skipped, ${stats.errors} errors`,
      stats.errors > 0 ? 'warn' : 'success'
    )
  } catch (error) {
    stats.errors++
    log(`Error processing model ${modelName}: ${(error as Error).message}`, 'error')
  }

  return stats
}

async function main() {
  log('Starting task_parts migration...', 'info')
  log(`Mode: ${isDryRun ? 'DRY RUN (no data will be written)' : 'LIVE MIGRATION'}`, 'info')

  const modelsToProcess = modelFilter || MIGRATION_CONFIG.models

  let totalPartsFound = 0
  let totalPartsMigrated = 0
  let totalPartsSkipped = 0
  let totalErrors = 0

  for (const modelName of modelsToProcess) {
    const stats = await migrateTaskPartsForModel(modelName)
    totalPartsFound += stats.partsFound
    totalPartsMigrated += stats.partsMigrated
    totalPartsSkipped += stats.partsSkipped
    totalErrors += stats.errors
  }

  console.log('\n' + '='.repeat(60))
  console.log('TASK_PARTS MIGRATION SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total Parts Found: ${totalPartsFound}`)
  console.log(`Total Parts Migrated: ${totalPartsMigrated}`)
  console.log(`Total Parts Skipped: ${totalPartsSkipped}`)
  console.log(`Total Errors: ${totalErrors}`)
  console.log('='.repeat(60) + '\n')

  log('Task parts migration completed!', 'success')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
