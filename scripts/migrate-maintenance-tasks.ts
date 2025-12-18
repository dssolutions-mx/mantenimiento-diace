#!/usr/bin/env tsx
/**
 * Migration script to copy maintenance_tasks from source project to destination project
 * 
 * Usage:
 *   tsx scripts/migrate-maintenance-tasks.ts [options]
 * 
 * Options:
 *   --dry-run          Simulate migration without writing data
 *   --resume           Resume from last checkpoint
 *   --models <names>   Comma-separated list of model names to migrate
 *   --verbose          Enable verbose logging
 */

import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { MIGRATION_CONFIG, type MigrationProgress } from './migrate-maintenance-tasks.config'

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// Parse CLI arguments
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const shouldResume = args.includes('--resume')
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

// Progress file path
const progressFilePath = path.resolve(process.cwd(), 'scripts', 'out', 'migration-progress.json')
const outDir = path.resolve(process.cwd(), 'scripts', 'out')

// Utility functions
async function ensureOutDir() {
  try {
    await fs.mkdir(outDir, { recursive: true })
  } catch (error) {
    // Directory might already exist
  }
}

async function loadProgress(): Promise<MigrationProgress | null> {
  try {
    const content = await fs.readFile(progressFilePath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function saveProgress(progress: MigrationProgress) {
  await ensureOutDir()
  progress.lastUpdatedAt = new Date().toISOString()
  await fs.writeFile(progressFilePath, JSON.stringify(progress, null, 2), 'utf-8')
}

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

// Validation functions
async function validateModelExists(modelName: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await retryWithBackoff(async () => {
    return await destClient
      .from('equipment_models')
      .select('id, name')
      .eq('name', modelName)
      .maybeSingle()
  })

  if (error) {
    throw new Error(`Failed to validate model ${modelName}: ${error.message}`)
  }

  return data
}

async function getSourceIntervals(modelId: string): Promise<
  Array<{
    id: string
    interval_value: number
    name: string
    model_id: string
  }>
> {
  const { data, error } = await retryWithBackoff(async () => {
    return await sourceClient
      .from('maintenance_intervals')
      .select('id, interval_value, name, model_id')
      .eq('model_id', modelId)
  })

  if (error) {
    throw new Error(`Failed to fetch source intervals: ${error.message}`)
  }

  return data || []
}

async function getDestinationIntervals(modelId: string): Promise<
  Array<{
    id: string
    interval_value: number
    name: string
    model_id: string
  }>
> {
  const { data, error } = await retryWithBackoff(async () => {
    return await destClient
      .from('maintenance_intervals')
      .select('id, interval_value, name, model_id')
      .eq('model_id', modelId)
  })

  if (error) {
    throw new Error(`Failed to fetch destination intervals: ${error.message}`)
  }

  return data || []
}

async function getSourceTasks(intervalIds: string[]): Promise<
  Array<{
    id: string
    interval_id: string
    description: string
    type: string
    estimated_time: number | null
    requires_specialist: boolean | null
  }>
> {
  if (intervalIds.length === 0) {
    return []
  }

  // Fetch in batches to avoid query size limits
  const allTasks: Array<{
    id: string
    interval_id: string
    description: string
    type: string
    estimated_time: number | null
    requires_specialist: boolean | null
  }> = []

  for (let i = 0; i < intervalIds.length; i += 100) {
    const batch = intervalIds.slice(i, i + 100)
    const { data, error } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('maintenance_tasks')
        .select('id, interval_id, description, type, estimated_time, requires_specialist')
        .in('interval_id', batch)
    })

    if (error) {
      throw new Error(`Failed to fetch source tasks: ${error.message}`)
    }

    if (data) {
      allTasks.push(...data)
    }
  }

  return allTasks
}

async function getSourceTaskParts(taskIds: string[]): Promise<
  Array<{
    id: string
    task_id: string
    name: string
    part_number: string | null
    quantity: number
    cost: number | null
  }>
> {
  if (taskIds.length === 0) {
    return []
  }

  const allParts: Array<{
    id: string
    task_id: string
    name: string
    part_number: string | null
    quantity: number
    cost: number | null
  }> = []

  // Fetch in batches to avoid query size limits
  for (let i = 0; i < taskIds.length; i += 100) {
    const batch = taskIds.slice(i, i + 100)
    const { data, error } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('task_parts')
        .select('id, task_id, name, part_number, quantity, cost')
        .in('task_id', batch)
    })

    if (error) {
      throw new Error(`Failed to fetch source task parts: ${error.message}`)
    }

    if (data) {
      allParts.push(...data)
    }
  }

  return allParts
}

async function checkDuplicateTask(
  intervalId: string,
  description: string,
  type: string
): Promise<boolean> {
  const { data, error } = await retryWithBackoff(async () => {
    return await destClient
      .from('maintenance_tasks')
      .select('id')
      .eq('interval_id', intervalId)
      .eq('description', description)
      .eq('type', type)
      .maybeSingle()
  })

  if (error) {
    throw new Error(`Failed to check duplicate task: ${error.message}`)
  }

  return !!data
}

// Migration functions
async function migrateModel(
  modelName: string,
  progress: MigrationProgress
): Promise<{
  tasksFound: number
  tasksMigrated: number
  tasksSkipped: number
  errors: number
  skippedReasons: string[]
}> {
  const stats = {
    tasksFound: 0,
    tasksMigrated: 0,
    tasksSkipped: 0,
    errors: 0,
    skippedReasons: [] as string[],
  }

  log(`Processing model: ${modelName}`, 'info')

  try {
    // Step 1: Validate model exists in destination
    const destModel = await validateModelExists(modelName)
    if (!destModel) {
      const errorMsg = `Model not found in destination: ${modelName}`
      log(errorMsg, 'warn')
      stats.errors++
      stats.skippedReasons.push(errorMsg)
      return stats
    }

    verboseLog(`Found destination model: ${destModel.id}`)

    // Step 2: Get source model
    const { data: sourceModel, error: sourceModelError } = await retryWithBackoff(async () => {
      return await sourceClient
        .from('equipment_models')
        .select('id, name')
        .eq('name', modelName)
        .maybeSingle()
    })

    if (sourceModelError || !sourceModel) {
      const errorMsg = `Model not found in source: ${modelName}`
      log(errorMsg, 'warn')
      stats.errors++
      stats.skippedReasons.push(errorMsg)
      return stats
    }

    verboseLog(`Found source model: ${sourceModel.id}`)

    // Step 3: Get intervals from both projects
    const sourceIntervals = await getSourceIntervals(sourceModel.id)
    const destIntervals = await getDestinationIntervals(destModel.id)

    verboseLog(
      `Found ${sourceIntervals.length} source intervals, ${destIntervals.length} destination intervals`
    )

    // Step 4: Create interval mapping (match by interval_value)
    const intervalMap = new Map<string, string>()
    const unmatchedIntervals: string[] = []

    for (const sourceInterval of sourceIntervals) {
      const destInterval = destIntervals.find(
        (di) => di.interval_value === sourceInterval.interval_value
      )

      if (destInterval) {
        intervalMap.set(sourceInterval.id, destInterval.id)
        verboseLog(
          `Matched interval: ${sourceInterval.interval_value} (${sourceInterval.id} -> ${destInterval.id})`
        )
      } else {
        unmatchedIntervals.push(
          `${sourceInterval.name} (${sourceInterval.interval_value})`
        )
      }
    }

    if (unmatchedIntervals.length > 0) {
      const warningMsg = `Unmatched intervals for ${modelName}: ${unmatchedIntervals.join(', ')}`
      log(warningMsg, 'warn')
      stats.skippedReasons.push(warningMsg)
    }

    // Step 5: Get source tasks
    const sourceIntervalIds = Array.from(intervalMap.keys())
    const sourceTasks = await getSourceTasks(sourceIntervalIds)
    stats.tasksFound = sourceTasks.length

    verboseLog(`Found ${sourceTasks.length} tasks to migrate`)

    if (sourceTasks.length === 0) {
      log(`No tasks found for model: ${modelName}`, 'info')
      return stats
    }

    // Step 6: Process tasks in batches and create task ID mapping
    const tasksToInsert: Array<{
      sourceTaskId: string
      interval_id: string
      description: string
      type: string
      estimated_time: number | null
      requires_specialist: boolean | null
    }> = []

    // Map: source task ID -> destination task ID
    const taskIdMap = new Map<string, string>()

    for (const task of sourceTasks) {
      const destIntervalId = intervalMap.get(task.interval_id)

      if (!destIntervalId) {
        stats.tasksSkipped++
        stats.skippedReasons.push(
          `Task skipped: interval ${task.interval_id} not matched`
        )
        continue
      }

      // Check for duplicates
      try {
        const existingTask = await retryWithBackoff(async () => {
          return await destClient
            .from('maintenance_tasks')
            .select('id')
            .eq('interval_id', destIntervalId)
            .eq('description', task.description)
            .eq('type', task.type)
            .maybeSingle()
        })

        if (existingTask.data) {
          // Task already exists, map to existing task ID for parts migration
          taskIdMap.set(task.id, existingTask.data.id)
          stats.tasksSkipped++
          stats.skippedReasons.push(
            `Duplicate task: ${task.description} (${task.type})`
          )
          continue
        }

        tasksToInsert.push({
          sourceTaskId: task.id,
          interval_id: destIntervalId,
          description: task.description,
          type: task.type,
          estimated_time: task.estimated_time,
          requires_specialist: task.requires_specialist,
        })
      } catch (error) {
        stats.errors++
        const errorMsg = `Error checking duplicate for task ${task.id}: ${(error as Error).message}`
        log(errorMsg, 'error')
        stats.skippedReasons.push(errorMsg)
      }
    }

    verboseLog(`Prepared ${tasksToInsert.length} tasks for insertion (${stats.tasksSkipped} skipped)`)

    // Step 7: Insert tasks in batches and track task ID mappings
    if (isDryRun) {
      log(`[DRY RUN] Would insert ${tasksToInsert.length} tasks for ${modelName}`, 'info')
      stats.tasksMigrated = tasksToInsert.length
    } else {
      for (let i = 0; i < tasksToInsert.length; i += MIGRATION_CONFIG.batchSize) {
        const batch = tasksToInsert.slice(i, i + MIGRATION_CONFIG.batchSize)

        try {
          const batchData = batch.map((t) => ({
            interval_id: t.interval_id,
            description: t.description,
            type: t.type,
            estimated_time: t.estimated_time,
            requires_specialist: t.requires_specialist,
          }))

          const { data: insertedTasks, error: insertError } = await retryWithBackoff(async () => {
            return await destClient
              .from('maintenance_tasks')
              .insert(batchData)
              .select('id, interval_id, description, type')
          })

          if (insertError) {
            throw insertError
          }

          // Map source task IDs to destination task IDs
          if (insertedTasks) {
            for (let j = 0; j < batch.length; j++) {
              const sourceTask = batch[j]
              const insertedTask = insertedTasks[j]
              if (insertedTask) {
                // Match by description and type to ensure correct mapping
                const matchedTask = insertedTasks.find(
                  (it) =>
                    it.description === sourceTask.description &&
                    it.type === sourceTask.type &&
                    it.interval_id === sourceTask.interval_id
                )
                if (matchedTask) {
                  taskIdMap.set(sourceTask.sourceTaskId, matchedTask.id)
                }
              }
            }
          }

          stats.tasksMigrated += batch.length
          verboseLog(`Inserted batch ${Math.floor(i / MIGRATION_CONFIG.batchSize) + 1} (${batch.length} tasks)`)
        } catch (error) {
          stats.errors++
          const errorMsg = `Failed to insert batch: ${(error as Error).message}`
          log(errorMsg, 'error')
          stats.skippedReasons.push(errorMsg)
        }
      }
    }

    // Step 8: Migrate task_parts
    const sourceTaskIds = Array.from(taskIdMap.keys())
    if (sourceTaskIds.length > 0) {
      verboseLog(`Migrating task_parts for ${sourceTaskIds.length} tasks`)
      const sourceParts = await getSourceTaskParts(sourceTaskIds)

      if (sourceParts.length > 0) {
        verboseLog(`Found ${sourceParts.length} task_parts to migrate`)

        const partsToInsert = sourceParts
          .map((part) => {
            const destTaskId = taskIdMap.get(part.task_id)
            if (!destTaskId) {
              return null
            }
            return {
              task_id: destTaskId,
              name: part.name,
              part_number: part.part_number,
              quantity: part.quantity,
              cost: part.cost,
            }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)

        if (partsToInsert.length > 0) {
          if (isDryRun) {
            log(`[DRY RUN] Would insert ${partsToInsert.length} task_parts for ${modelName}`, 'info')
          } else {
            try {
              // Insert parts in batches
              for (let i = 0; i < partsToInsert.length; i += MIGRATION_CONFIG.batchSize) {
                const batch = partsToInsert.slice(i, i + MIGRATION_CONFIG.batchSize)
                const { error: partsError } = await retryWithBackoff(async () => {
                  return await destClient.from('task_parts').insert(batch)
                })

                if (partsError) {
                  throw partsError
                }

                verboseLog(`Inserted ${batch.length} task_parts (batch ${Math.floor(i / MIGRATION_CONFIG.batchSize) + 1})`)
              }
              log(`Migrated ${partsToInsert.length} task_parts for ${modelName}`, 'success')
            } catch (error) {
              stats.errors++
              const errorMsg = `Failed to insert task_parts: ${(error as Error).message}`
              log(errorMsg, 'error')
              stats.skippedReasons.push(errorMsg)
            }
          }
        }
      }
    }

    log(
      `Completed ${modelName}: ${stats.tasksMigrated} migrated, ${stats.tasksSkipped} skipped, ${stats.errors} errors`,
      stats.errors > 0 ? 'warn' : 'success'
    )
  } catch (error) {
    stats.errors++
    const errorMsg = `Error processing model ${modelName}: ${(error as Error).message}`
    log(errorMsg, 'error')
    stats.skippedReasons.push(errorMsg)
  }

  return stats
}

// Reporting functions
async function generateReport(progress: MigrationProgress) {
  await ensureOutDir()

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const csvPath = path.join(outDir, `migration-report-${timestamp}.csv`)

  // CSV Header
  const csvRows = [
    'Model,Tasks Found,Tasks Migrated,Tasks Skipped,Errors,Status',
  ]

  // Add model statistics
  for (const modelName of MIGRATION_CONFIG.models) {
    const modelStats = progress.modelStats[modelName] || {
      tasksFound: 0,
      tasksMigrated: 0,
      tasksSkipped: 0,
      errors: 0,
    }

    const status =
      progress.completedModels.includes(modelName)
        ? 'Completed'
        : progress.currentModel === modelName
          ? 'In Progress'
          : 'Pending'

    csvRows.push(
      [
        modelName,
        modelStats.tasksFound,
        modelStats.tasksMigrated,
        modelStats.tasksSkipped,
        modelStats.errors,
        status,
      ].join(',')
    )
  }

  // Add summary row
  csvRows.push('')
  csvRows.push('Summary')
  csvRows.push(`Total Models,${progress.stats.totalModels}`)
  csvRows.push(`Total Tasks Found,${progress.stats.totalTasksFound}`)
  csvRows.push(`Total Tasks Migrated,${progress.stats.totalTasksMigrated}`)
  csvRows.push(`Total Tasks Skipped,${progress.stats.totalTasksSkipped}`)
  csvRows.push(`Total Errors,${progress.stats.totalErrors}`)

  await fs.writeFile(csvPath, csvRows.join('\n'), 'utf-8')
  log(`Report generated: ${csvPath}`, 'success')

  // Print summary to console
  console.log('\n' + '='.repeat(60))
  console.log('MIGRATION SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total Models: ${progress.stats.totalModels}`)
  console.log(`Total Tasks Found: ${progress.stats.totalTasksFound}`)
  console.log(`Total Tasks Migrated: ${progress.stats.totalTasksMigrated}`)
  console.log(`Total Tasks Skipped: ${progress.stats.totalTasksSkipped}`)
  console.log(`Total Errors: ${progress.stats.totalErrors}`)
  console.log('='.repeat(60) + '\n')
}

// Main execution
async function main() {
  log('Starting maintenance tasks migration...', 'info')
  log(`Mode: ${isDryRun ? 'DRY RUN (no data will be written)' : 'LIVE MIGRATION'}`, 'info')

  // Determine models to process
  let modelsToProcess = modelFilter || MIGRATION_CONFIG.models

  // Load progress if resuming
  let progress: MigrationProgress | null = null
  if (shouldResume) {
    progress = await loadProgress()
    if (progress) {
      log('Resuming from checkpoint...', 'info')
      // Filter out already completed models
      modelsToProcess = modelsToProcess.filter(
        (m) => !progress!.completedModels.includes(m)
      )
    }
  }

  // Initialize progress
  if (!progress) {
    progress = {
      completedModels: [],
      stats: {
        totalModels: modelsToProcess.length,
        totalTasksFound: 0,
        totalTasksMigrated: 0,
        totalTasksSkipped: 0,
        totalErrors: 0,
      },
      modelStats: {},
      errors: [],
      startedAt: new Date().toISOString(),
    }
  }

  // Process each model
  for (const modelName of modelsToProcess) {
    progress.currentModel = modelName

    try {
      const modelStats = await migrateModel(modelName, progress)

      // Update progress
      progress.modelStats[modelName] = modelStats
      progress.stats.totalTasksFound += modelStats.tasksFound
      progress.stats.totalTasksMigrated += modelStats.tasksMigrated
      progress.stats.totalTasksSkipped += modelStats.tasksSkipped
      progress.stats.totalErrors += modelStats.errors

      if (modelStats.errors > 0) {
        progress.errors.push({
          model: modelName,
          error: modelStats.skippedReasons.join('; '),
          timestamp: new Date().toISOString(),
        })
      }

      progress.completedModels.push(modelName)
      delete progress.currentModel

      // Save progress after each model
      await saveProgress(progress)
    } catch (error) {
      const errorMsg = `Fatal error processing ${modelName}: ${(error as Error).message}`
      log(errorMsg, 'error')
      progress.errors.push({
        model: modelName,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      })
      progress.stats.totalErrors++
      await saveProgress(progress)
    }
  }

  // Generate final report
  await generateReport(progress)
  log('Migration completed!', 'success')
}

// Run migration
main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
