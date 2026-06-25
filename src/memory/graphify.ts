import { promises as fs } from "fs";
import * as path from "path";

/**
 * Graphify Integration Module
 * Source: https://github.com/safishamsi/graphify.git
 * Purpose: Memory, context management, token optimization, knowledge storage.
 */

export class GraphifyManager {
  // Map of sessionId -> Map of taskId -> task data
  private sessionStore: Map<string, Map<string, any>> = new Map();

  /**
   * Initializes connection to the Graphify service and loads awesome-design-md training data.
   */
  async initialize(): Promise<void> {
    console.error("[Graphify] Initializing knowledge graph connection...");
    
    // Dynamically load awesome-design-md training files
    try {
      const designMdRoot = path.join(process.cwd(), "knowledge", "design-md");
      const stat = await fs.stat(designMdRoot).catch(() => null);
      if (stat && stat.isDirectory()) {
        console.error("[Graphify] Loading awesome-design-md files into the knowledge base...");
        const companies = await fs.readdir(designMdRoot);
        let loadedCount = 0;
        
        for (const company of companies) {
          const designPath = path.join(designMdRoot, company, "DESIGN.md");
          const designStat = await fs.stat(designPath).catch(() => null);
          if (designStat && designStat.isFile()) {
            const content = await fs.readFile(designPath, "utf-8");
            
            // Extract frontmatter / description if possible
            const nameMatch = content.match(/name:\s*(.+)/);
            const descMatch = content.match(/description:\s*(.+)/);
            const name = nameMatch ? nameMatch[1].trim() : `${company}-design`;
            const description = descMatch ? descMatch[1].trim() : `Design analysis for ${company}`;

            // Index in global session storage
            await this.indexTask("global-knowledge", `design_${company}`, {
              type: "design-system",
              company,
              name,
              description
            }, content);
            
            loadedCount++;
          }
        }
        console.error(`[Graphify] Successfully loaded and indexed ${loadedCount} design.md systems.`);
      } else {
        console.error("[Graphify] awesome-design-md directory not found at: " + designMdRoot);
      }
    } catch (e: any) {
      console.error("[Graphify] Error loading design.md files:", e.message);
    }
  }

  /**
   * Indexes a completed task into the session-scoped knowledge graph.
   */
  async indexTask(sessionId: string, taskId: string, context: any, result: any): Promise<void> {
    console.error(`[Graphify] Session [${sessionId}] - Indexing completed task: ${taskId}`);
    if (!this.sessionStore.has(sessionId)) {
      this.sessionStore.set(sessionId, new Map());
    }
    this.sessionStore.get(sessionId)!.set(taskId, { context, result, timestamp: Date.now() });
  }

  /**
   * Retrieves relevant context for a new task within a session.
   */
  async retrieveContext(sessionId: string, query: string): Promise<any[]> {
    console.error(`[Graphify] Session [${sessionId}] - Retrieving context for query: ${query}`);
    const store = this.sessionStore.get(sessionId);
    const globalStore = this.sessionStore.get("global-knowledge");
    
    const results: any[] = [];
    
    // Add global design.md knowledge results
    if (globalStore) {
      for (const [key, value] of globalStore.entries()) {
        const company = value.context.company || "";
        const desc = value.context.description || "";
        const queryLower = query.toLowerCase();
        
        // Simple search: check if query matches company name or general design keywords
        if (queryLower.includes(company.toLowerCase()) || 
            queryLower.includes("design") || 
            queryLower.includes("website") || 
            queryLower.includes("ui") ||
            queryLower.includes("theme") ||
            queryLower.includes("styles")) {
          results.push({
            context: value.context,
            result: value.result
          });
        }
      }
    }
    
    if (store) {
      for (const value of store.values()) {
        results.push({
          context: value.context,
          result: value.result
        });
      }
    }
    
    // Cap results size/tokens for performance/context limits
    return results.slice(0, 10);
  }
}

export const graphify = new GraphifyManager();
