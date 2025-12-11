# Diesel Transfer FIFO Behavior & Recommendations

## Overview

This document explains how the FIFO (First-In-First-Out) costing system handles diesel transfers, particularly for Plant 4 closure scenarios, and provides recommendations for scalability and performance.

## FIFO Behavior for Transfers

### Current Implementation

The FIFO system **excludes transfers** from cost calculations:

```typescript
// From lib/fifo-diesel-costs.ts
.eq('is_transfer', false)  // Excludes transfers from entries
.eq('is_transfer', false)  // Excludes transfers from consumptions
```

### How Transfers Affect FIFO

1. **Transfer-Out (Consumption at Plant 4)**
   - Marked with `is_transfer = true`
   - **Excluded** from consumption cost calculations
   - **Does NOT** consume from FIFO inventory lots
   - Still affects physical inventory balance

2. **Transfer-In (Entry at Receiving Plant)**
   - Marked with `is_transfer = true`
   - **Excluded** from entry cost calculations
   - **Does NOT** add to FIFO inventory lots
   - Still affects physical inventory balance

### Price Handling for Transfers

#### Scenario: Plant 4 Transfer with Price

**Current Behavior:**
- Transfer-out (Plant 4 consumption) may have `unit_cost` from Plant 4's purchase
- Transfer-in (receiving plant entry) can inherit this price via `preserve_price` option
- **However**, since transfers are excluded from FIFO, these prices don't affect costing calculations

**Recommended Approach:**
1. **Preserve Price** (Recommended for Plant 4):
   - When marking Plant 4 transactions as transfers, enable `preserve_price = true`
   - This copies `unit_cost` from transfer-out to transfer-in
   - Maintains historical cost basis for audit purposes
   - **Note**: This price is informational only - FIFO still excludes transfers

2. **No Price** (Alternative):
   - If transfers have no price, FIFO behavior is unchanged
   - Transfers remain excluded from costing
   - Physical inventory still adjusts correctly

### FIFO Matching Logic

The FIFO system matches consumptions to entries in chronological order:

```typescript
// Simplified FIFO logic
1. Sort all entries (non-transfer) by date
2. Sort all consumptions (non-transfer) by date
3. For each consumption:
   a. Match against oldest available entry lots
   b. Calculate cost = quantity × unit_cost from matched lot
   c. Reduce lot inventory
4. If lots exhausted, use weighted average fallback
```

**Transfers are skipped** in steps 1-2, so they never participate in matching.

## Recommendations

### 1. Price Preservation Strategy

**For Plant 4 Transfers:**
- ✅ **Enable `preserve_price`** when marking transactions as transfers
- ✅ Maintains cost traceability for accounting/audit
- ✅ Transfer-in inherits Plant 4's historical cost
- ✅ No impact on FIFO calculations (as intended)

**Why This Matters:**
- Accounting may need to track transfer costs separately
- Audit trail shows original cost basis
- Future reporting might need transfer cost analysis

### 2. Scalability Considerations

#### Database Performance

**Current Indexes:**
```sql
-- Already created in migration
CREATE INDEX idx_diesel_transactions_is_transfer
ON diesel_transactions(is_transfer)
WHERE is_transfer = true;

CREATE INDEX idx_diesel_transactions_reference_transaction_id
ON diesel_transactions(reference_transaction_id)
WHERE reference_transaction_id IS NOT NULL;
```

**Recommendations:**
1. **Materialized View Refresh Strategy**
   - `diesel_current_inventory` is a materialized view
   - Consider refreshing periodically (not on every transaction)
   - Use `REFRESH MATERIALIZED VIEW CONCURRENTLY` for zero-downtime updates

2. **Query Optimization**
   - FIFO queries already filter `is_transfer = false` early
   - Index on `(transaction_type, is_transfer, transaction_date)` would help
   - Consider partitioning by date for large datasets

3. **Batch Processing**
   - For marking many transactions as transfers, use batch API
   - Process in chunks of 100-500 transactions
   - Use database transactions for atomicity

#### Frontend Performance

**Current Implementation:**
- Modal searches matching entries on-demand
- Limits to 10 matches for performance
- Warehouse list loaded once per modal open

**Recommendations:**
1. **Debounce Search**
   - Add 300ms debounce to warehouse selection
   - Prevents excessive API calls

2. **Caching**
   - Cache warehouse list in component state
   - Cache recent transaction lookups

3. **Pagination**
   - For large transaction lists, paginate search results
   - Virtual scrolling for warehouse dropdowns

### 3. Data Integrity

#### Validation Rules

**When Marking as Transfer:**
1. ✅ Quantities must match (±0.01L tolerance)
2. ✅ Products must match
3. ✅ Warehouses must be different
4. ✅ Dates should be within 7 days (suggestion, not enforced)
5. ✅ Neither transaction already marked as transfer

#### Rollback Strategy

**API Implementation:**
- If transfer-in update fails, rollback transfer-out update
- Uses database transaction for atomicity
- Error messages guide user to fix issues

### 4. Reporting Impact

**Reports That Exclude Transfers:**
- ✅ Consumption reports (gerencial, analytics)
- ✅ Entry reports (ingresos-gastos)
- ✅ Asset maintenance summaries
- ✅ FIFO cost calculations

**Reports That Include Transfers:**
- ✅ Inventory balance (physical stock)
- ✅ Warehouse detail views (shown but marked)
- ✅ Transaction history (visible with transfer badge)

### 5. Future Enhancements

#### Potential Improvements

1. **Transfer Cost Tracking**
   - Separate table for transfer costs
   - Track transfer-specific expenses (transport, handling)
   - Report transfer costs separately from consumption

2. **Bulk Transfer Marking**
   - UI to select multiple transactions
   - Batch mark as transfers
   - Progress indicator for large batches

3. **Transfer Validation Dashboard**
   - View all potential transfers (using `diesel_transfer_candidates` view)
   - Bulk approve/reject
   - Audit log of transfer marking actions

4. **Advanced FIFO Options**
   - Option to include transfers in FIFO (for specific scenarios)
   - Weighted average for transfers
   - Transfer cost allocation methods

## Example Scenarios

### Scenario 1: Plant 4 Closure Transfer

**Setup:**
- Plant 4 has 1000L diesel at $25.00/L (from purchase)
- Transferred to Plant 1
- Marked as transfer with `preserve_price = true`

**Result:**
- Transfer-out: `is_transfer = true`, `unit_cost = 25.00`
- Transfer-in: `is_transfer = true`, `unit_cost = 25.00` (inherited)
- FIFO: Neither transaction affects FIFO calculations
- Inventory: Plant 4 -1000L, Plant 1 +1000L
- Reports: No consumption/entry counted in reports

### Scenario 2: Transfer Without Price

**Setup:**
- Plant 2 transfers 500L to Plant 3
- No price information available
- Marked as transfer with `preserve_price = false`

**Result:**
- Transfer-out: `is_transfer = true`, `unit_cost = null`
- Transfer-in: `is_transfer = true`, `unit_cost = null`
- FIFO: Neither transaction affects FIFO calculations
- Inventory: Plant 2 -500L, Plant 3 +500L
- Reports: No consumption/entry counted in reports

### Scenario 3: Mixed Transfer and Consumption

**Setup:**
- Plant 1 has 2000L inventory (from $24/L purchase)
- 500L transferred to Plant 2 (transfer)
- 300L consumed by Asset A (consumption)

**FIFO Calculation:**
- Transfer: Excluded (no cost assigned)
- Consumption: 300L × $24/L = $7,200
- Remaining inventory: 1200L at $24/L

## Performance Benchmarks

### Expected Performance

**Marking Single Transfer:**
- API call: < 200ms
- Database update: < 50ms
- UI refresh: < 100ms
- **Total: < 350ms**

**FIFO Calculation (1000 transactions):**
- Query time: < 500ms
- Processing time: < 200ms
- **Total: < 700ms**

**Bulk Marking (100 transfers):**
- Batch API: < 5 seconds
- Individual API: < 35 seconds
- **Recommendation: Use batch API**

## Conclusion

The current FIFO implementation correctly excludes transfers from cost calculations while maintaining inventory accuracy. The `preserve_price` option provides audit trail benefits without affecting FIFO logic. For Plant 4 transfers, enabling price preservation is recommended for accounting and audit purposes.

For scalability, the existing indexes and query patterns are well-optimized. Consider materialized view refresh strategies and batch processing for large-scale operations.
