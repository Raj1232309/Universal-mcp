/**
 * Efficient Sub-Agent Manager
 *
 * Manages parallel sub-agent dispatch with:
 *  - Token budget tracking (prevents unnecessary calls)
 *  - Result deduplication (same tool, same args → cached)
 *  - Parallel execution of independent workstreams
 *  - Selective activation (only activate agents that add value)
 */

export interface SubAgentTask {
  id: string;
  role: string;
  description: string;
  priority: "critical" | "high" | "normal" | "low";
  estimatedTokens: number;
  dependencies: string[]; // IDs of tasks that must complete first
}

export interface SubAgentResult {
  id: string;
  role: string;
  success: boolean;
  output: string;
  tokensUsed: number;
  durationMs: number;
}

export interface SubAgentBatch {
  batchId: string;
  tasks: SubAgentTask[];
  results: SubAgentResult[];
  totalTokensBudget: number;
  totalTokensUsed: number;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed";
}

// Cache: prevents re-calling the same tool with the same args
const resultCache = new Map<string, { result: SubAgentResult; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Active batches
const activeBatches = new Map<string, SubAgentBatch>();

/**
 * Creates a new sub-agent batch for parallel execution.
 * Tasks with no dependencies run immediately in parallel.
 * Tasks with dependencies run after their dependencies complete.
 *
 * Token budget prevents runaway usage — low-priority tasks are
 * skipped if the budget is exhausted.
 */
export async function executeBatch(
  tasks: SubAgentTask[],
  tokenBudget: number,
  executor: (task: SubAgentTask) => Promise<string>
): Promise<SubAgentBatch> {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const batch: SubAgentBatch = {
    batchId,
    tasks,
    results: [],
    totalTokensBudget: tokenBudget,
    totalTokensUsed: 0,
    startedAt: Date.now(),
    status: "running"
  };
  activeBatches.set(batchId, batch);

  // Track completed task IDs
  const completed = new Set<string>();
  const failed = new Set<string>();

  // Resolve execution order using simple dependency graph traversal
  const remaining = [...tasks];
  const maxIterations = tasks.length * 2; // safety ceiling
  let iterations = 0;

  while (remaining.length > 0 && iterations < maxIterations) {
    iterations++;

    // Find all tasks whose dependencies are satisfied
    const ready = remaining.filter(t =>
      t.dependencies.every(dep => completed.has(dep)) &&
      !t.dependencies.some(dep => failed.has(dep))
    );

    if (ready.length === 0) {
      // Circular dependency or all remaining tasks have failed deps
      console.error(`[SubAgentManager] No ready tasks. Remaining: ${remaining.map(t => t.id).join(", ")}`);
      break;
    }

    // Remove ready tasks from remaining
    for (const r of ready) {
      remaining.splice(remaining.indexOf(r), 1);
    }

    // Sort by priority for budget allocation
    ready.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // Execute ready tasks in parallel, respecting token budget
    const parallelTasks: Promise<SubAgentResult>[] = [];

    for (const task of ready) {
      // Skip low-priority tasks if we're over 85% of budget
      const budgetPercent = batch.totalTokensUsed / tokenBudget;
      if (task.priority === "low" && budgetPercent > 0.85) {
        console.error(`[SubAgentManager] Skipping low-priority task '${task.id}' — budget at ${Math.round(budgetPercent * 100)}%`);
        completed.add(task.id); // mark as "done" so dependents can proceed
        batch.results.push({
          id: task.id,
          role: task.role,
          success: true,
          output: "[Skipped: token budget conserved]",
          tokensUsed: 0,
          durationMs: 0
        });
        continue;
      }

      // Check cache first
      const cacheKey = `${task.role}::${task.description}`;
      const cached = resultCache.get(cacheKey);
      if (cached && cached.expiry > Date.now()) {
        console.error(`[SubAgentManager] Cache hit for task '${task.id}' (${task.role})`);
        completed.add(task.id);
        batch.results.push({ ...cached.result, id: task.id });
        continue;
      }

      // Queue for parallel execution
      parallelTasks.push(
        runTask(task, executor).then(result => {
          // Store in cache
          resultCache.set(cacheKey, {
            result,
            expiry: Date.now() + CACHE_TTL_MS
          });
          return result;
        })
      );
    }

    // Await all parallel tasks in this wave
    if (parallelTasks.length > 0) {
      const waveResults = await Promise.allSettled(parallelTasks);
      for (const settlement of waveResults) {
        if (settlement.status === "fulfilled") {
          const result = settlement.value;
          batch.results.push(result);
          batch.totalTokensUsed += result.tokensUsed;
          if (result.success) {
            completed.add(result.id);
          } else {
            failed.add(result.id);
          }
        }
      }
    }
  }

  batch.status = failed.size === 0 ? "completed" : "failed";
  batch.completedAt = Date.now();
  activeBatches.set(batchId, batch);

  return batch;
}

async function runTask(
  task: SubAgentTask,
  executor: (task: SubAgentTask) => Promise<string>
): Promise<SubAgentResult> {
  const start = Date.now();
  try {
    console.error(`[SubAgentManager] Running task '${task.id}' (${task.role}, priority: ${task.priority})`);
    const output = await executor(task);
    const durationMs = Date.now() - start;
    // Estimate tokens from output length (rough heuristic: 4 chars ≈ 1 token)
    const tokensUsed = Math.ceil(output.length / 4);
    console.error(`[SubAgentManager] Task '${task.id}' completed in ${durationMs}ms (~${tokensUsed} tokens)`);
    return { id: task.id, role: task.role, success: true, output, tokensUsed, durationMs };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    console.error(`[SubAgentManager] Task '${task.id}' FAILED: ${err.message}`);
    return { id: task.id, role: task.role, success: false, output: `Error: ${err.message}`, tokensUsed: 0, durationMs };
  }
}

/**
 * Returns a summary of a completed batch for logging/reporting.
 */
export function summarizeBatch(batch: SubAgentBatch): string {
  const duration = batch.completedAt ? batch.completedAt - batch.startedAt : 0;
  const successCount = batch.results.filter(r => r.success).length;
  const skipCount = batch.results.filter(r => r.output.includes("[Skipped")).length;

  return [
    `Batch ${batch.batchId}:`,
    `  Status: ${batch.status}`,
    `  Tasks: ${successCount}/${batch.tasks.length} succeeded (${skipCount} skipped to save tokens)`,
    `  Tokens: ${batch.totalTokensUsed} / ${batch.totalTokensBudget} budget used`,
    `  Duration: ${Math.round(duration / 1000)}s`
  ].join("\n");
}

/**
 * Clears expired cache entries.
 */
export function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of resultCache.entries()) {
    if (entry.expiry < now) {
      resultCache.delete(key);
    }
  }
}
