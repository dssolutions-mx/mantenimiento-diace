# Maintenance Tasks Migration Guide

This guide explains how to migrate maintenance tasks from the source project (`txapndpstzcspgxlybll`) to the destination project (`rfsjdnuctrsippugwgpz` - DIACE).

## Overview

The migration script copies `maintenance_tasks` records from the source project to the destination project, matching them to the correct `maintenance_intervals` by model name and interval value.

## Prerequisites

1. **Environment Variables**: Ensure the following are set in your `.env.local` file:
   ```bash
   # Source project (txapndpstzcspgxlybll)
   SOURCE_SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

   # Destination project (rfsjdnuctrsippugwgpz - DIACE)
   NEXT_PUBLIC_SUPABASE_URL=https://rfsjdnuctrsippugwgpz.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   ```

2. **Node.js Dependencies**: Ensure `tsx` is available:
   ```bash
   npm install -g tsx
   # or
   npx tsx scripts/migrate-maintenance-tasks.ts
   ```

## Usage

### Basic Commands

#### 1. Dry Run (Recommended First Step)
Test the migration without writing any data:
```bash
tsx scripts/migrate-maintenance-tasks.ts --dry-run
```

#### 2. Verbose Dry Run
See detailed logging during dry run:
```bash
tsx scripts/migrate-maintenance-tasks.ts --dry-run --verbose
```

#### 3. Migrate Single Model
Test with one model first:
```bash
tsx scripts/migrate-maintenance-tasks.ts --models="T800 Water Truck" --verbose
```

#### 4. Full Migration
Run the complete migration:
```bash
tsx scripts/migrate-maintenance-tasks.ts
```

#### 5. Resume After Interruption
If migration is interrupted, resume from checkpoint:
```bash
tsx scripts/migrate-maintenance-tasks.ts --resume
```

### Command Line Options

- `--dry-run`: Simulate migration without writing data (recommended for first run)
- `--resume`: Resume from last checkpoint (uses `scripts/out/migration-progress.json`)
- `--models=<names>`: Comma-separated list of model names to migrate (e.g., `--models="Model1,Model2"`)
- `--verbose`: Enable detailed logging for debugging

## Migration Process

The script follows these steps for each model:

1. **Validation**: Verifies model exists in both source and destination
2. **Interval Matching**: Matches intervals by `interval_value` (must match exactly)
3. **Task Fetching**: Retrieves all tasks from source project for matched intervals
4. **Duplicate Detection**: Checks if task already exists (by `interval_id`, `description`, `type`)
5. **Batch Insertion**: Inserts tasks in batches of 100 (configurable)
6. **Progress Tracking**: Saves progress after each model

## Output Files

After running the migration, you'll find:

1. **Progress File**: `scripts/out/migration-progress.json`
   - Contains current migration state
   - Used for resume functionality
   - Includes statistics and error details

2. **CSV Report**: `scripts/out/migration-report-{timestamp}.csv`
   - Summary of migration results per model
   - Includes task counts, errors, and status

## Verification

After migration, run the verification queries:

```bash
# In Supabase SQL Editor, run:
cat scripts/verify-maintenance-tasks-migration.sql
```

Key verification queries:
1. Task counts per model
2. Intervals without tasks
3. Task distribution by type
4. Potential duplicates check
5. Overall migration summary

## Expected Results

Based on the migration plan:
- **Total Models**: 13
- **Total Tasks**: ~4,860
- **Estimated Time**: 10-15 minutes

## Error Handling

The script handles errors gracefully:

- **Model Not Found**: Logs warning and skips model
- **Interval Mismatch**: Logs details and skips affected tasks
- **Insert Failure**: Logs error and continues with next batch
- **Network Errors**: Retries with exponential backoff (3 attempts)

All errors are logged in the progress file and CSV report.

## Safety Features

1. **Dry-run by default**: Use `--dry-run` first to verify behavior
2. **Duplicate detection**: Prevents creating duplicate tasks
3. **Progress tracking**: Can resume from last checkpoint
4. **Comprehensive logging**: Full audit trail of all operations
5. **Batch processing**: Inserts in manageable batches

## Troubleshooting

### Model Not Found
If a model is not found in destination:
- Verify model name matches exactly (case-sensitive)
- Check that model exists in destination project

### Interval Mismatch
If intervals don't match:
- Verify `interval_value` matches exactly between projects
- Check that intervals exist in destination project

### Duplicate Tasks
If tasks are skipped as duplicates:
- This is expected behavior - prevents data duplication
- Check existing tasks in destination before migration

### Network Errors
If you encounter network errors:
- Script automatically retries with exponential backoff
- Check your internet connection
- Verify Supabase project URLs are correct

## Models to Migrate

The following 13 models are included in the migration:

1. T800 Water Truck (~906 tasks)
2. INT-7600-ISM-320 (~640 tasks)
3. INT-WORKSTAR 7600-310 (~636 tasks)
4. KENWORTH-T460 (~636 tasks)
5. C7H 360HP 6X4 (AUTOMATICO) (~371 tasks)
6. SIT-C7H-LONG CHASIS (~376 tasks)
7. C7H 360HP 6X4 (MANUAL) (~340 tasks)
8. CARGADOR FRONTAL 524 P (~265 tasks)
9. CARGADOR FRONTAL 524K (~190 tasks)
10. CARGADOR FRONTAL 524K II (~190 tasks)
11. INT- 7600SBA 6X4 (~205 tasks)
12. INTERNATIONAL-TRACTOCAMION-LONG CHASIS (~205 tasks)
13. BOM-PUTZMEISTER (~17 tasks)

## Testing Strategy

Recommended testing approach:

1. **Step 1**: Dry-run on single model
   ```bash
   tsx scripts/migrate-maintenance-tasks.ts --dry-run --models="BOM-PUTZMEISTER" --verbose
   ```

2. **Step 2**: Verify output matches expectations

3. **Step 3**: Dry-run on all models
   ```bash
   tsx scripts/migrate-maintenance-tasks.ts --dry-run --verbose
   ```

4. **Step 4**: Review logs and statistics

5. **Step 5**: Execute real migration on single model
   ```bash
   tsx scripts/migrate-maintenance-tasks.ts --models="BOM-PUTZMEISTER" --verbose
   ```

6. **Step 6**: Verify data integrity using SQL queries

7. **Step 7**: Execute full migration
   ```bash
   tsx scripts/migrate-maintenance-tasks.ts
   ```

## Support

If you encounter issues:
1. Check the progress file: `scripts/out/migration-progress.json`
2. Review the CSV report for detailed error information
3. Run with `--verbose` flag for detailed logging
4. Verify environment variables are set correctly
