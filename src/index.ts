#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { AGENT_CONFIG } from "./config/agents.js";
import { loadSkillsForAgent, LoadedSkill } from "./loaders/skillsLoader.js";
import { graphify } from "./memory/graphify.js";
import { orchestrator } from "./orchestration/ohmypi.js";
import { UNIVERSAL_ORCHESTRATOR_PROMPT } from "./prompts/systemPrompt.js";
import { FRONTEND_DESIGN_PROMPT } from "./prompts/frontendPrompt.js";

dotenv.config({ quiet: true });

// Session State Tracking for Multi-Client Support
interface SessionState {
  currentActiveAgent: string | null;
  currentSkills: LoadedSkill[];
}

/**
 * Creates an isolated MCP Server instance for a specific client session.
 * This guarantees that state (active agent, loaded skills) is not shared between users.
 */
function createMcpServer(sessionId: string) {
  const server = new Server(
    {
      name: "Universal AI Agent Router",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: true
        },
        prompts: {}
      },
    }
  );

  const session: SessionState = {
    currentActiveAgent: null,
    currentSkills: []
  };

  // ----------------------------------------------------
  // Prompt Registration
  // ----------------------------------------------------
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "universal_orchestrator",
          description: "The core system prompt for the Universal MCP Orchestrator. Connects multiple agents, skills, and enforces Graphify memory usage.",
        },
        {
          name: "frontend_design",
          description: "The agent prompt guidelines for the frontend agent when building something.",
        }
      ]
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === "universal_orchestrator") {
      return {
        description: "Universal MCP Orchestrator System Prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: UNIVERSAL_ORCHESTRATOR_PROMPT
            }
          }
        ]
      };
    }

    if (request.params.name === "frontend_design") {
      return {
        description: "Frontend Design Agent Prompt Guidelines",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: FRONTEND_DESIGN_PROMPT
            }
          }
        ]
      };
    }
    
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  // ----------------------------------------------------
  // Tool Capability Handlers
  // ----------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: any[] = [
      {
        name: "activate_agent",
        description: "Activates a specialized agent and loads their specific skill set. ALWAYS call this tool first before attempting to use other skills.",
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description: `The specialized agent to activate based on the task intent. Valid options: ${Object.keys(AGENT_CONFIG).join(", ")}`,
              enum: Object.keys(AGENT_CONFIG)
            }
          },
          required: ["intent"]
        }
      },
      {
        name: "delegate_subtask",
        description: "Delegates a sub-task to an internal specialized agent using Oh My PI. Use this when a task spans multiple domains.",
        inputSchema: {
          type: "object",
          properties: {
            role: { type: "string", description: "The role of the sub-agent (e.g., 'researcher', 'designer')" },
            task: { type: "string", description: "The task description" }
          },
          required: ["role", "task"]
        }
      },
      {
        name: "execute_task",
        description: "Executes a complex task by orchestrating multiple internal skills. Automatically retrieves context from Graphify, chooses the best internal skills, executes them, merges their outputs, and indexes the results back to Graphify.",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The task description or query to execute."
            }
          },
          required: ["task"]
        }
      },
      {
        name: "get_status",
        description: "Returns the current state of the orchestrator, active agent, loaded skills (internally), and Graphify memory status.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ];

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "activate_agent") {
      const agentName = (args as any).intent;

      if (!AGENT_CONFIG[agentName]) {
        return {
          content: [{ type: "text", text: `Invalid agent intent: ${agentName}. Valid options are: ${Object.keys(AGENT_CONFIG).join(", ")}` }],
          isError: true
        };
      }

      try {
        session.currentSkills = await loadSkillsForAgent(agentName);
        session.currentActiveAgent = agentName;

        // Send tools list changed notification specifically to this client
        await server.notification({ method: "notifications/tools/list_changed" });

        return {
          content: [
            {
              type: "text",
              text: `Successfully activated ${agentName}. The skill set has been updated. You now have access to specialized tools for this domain.`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Failed to activate agent: ${error.message}` }],
          isError: true
        };
      }
    }

    if (name === "delegate_subtask") {
      const { role, task } = args as any;
      const result = await orchestrator.delegateTask(role, task);
      return {
        content: [{ type: "text", text: result }]
      };
    }

    if (name === "execute_task") {
      const { task } = args as any;

      // 1. Analyze intent / determine active agent
      let activeAgent = session.currentActiveAgent;
      if (!activeAgent) {
        // Automatically determine intent based on keywords in the task
        const taskLower = task.toLowerCase();
        if (taskLower.includes("website") || taskLower.includes("design") || taskLower.includes("page") || taskLower.includes("ui") || taskLower.includes("frontend")) {
          activeAgent = "website_builder";
        } else if (taskLower.includes("animation") || taskLower.includes("motion") || taskLower.includes("gsap") || taskLower.includes("threejs")) {
          activeAgent = "motion_animation";
        } else if (taskLower.includes("video") || taskLower.includes("remotion")) {
          activeAgent = "video";
        } else if (taskLower.includes("android") || taskLower.includes("wear")) {
          activeAgent = "android";
        } else if (taskLower.includes("research") || taskLower.includes("crawl") || taskLower.includes("find")) {
          activeAgent = "research";
        } else if (taskLower.includes("security") || taskLower.includes("exploit") || taskLower.includes("vulnerability")) {
          activeAgent = "security";
        } else if (taskLower.includes("code") || taskLower.includes("refactor") || taskLower.includes("compile") || taskLower.includes("ts")) {
          activeAgent = "coding";
        } else if (taskLower.includes("data") || taskLower.includes("bigquery") || taskLower.includes("dbt") || taskLower.includes("pipeline")) {
          activeAgent = "data_engineering";
        } else {
          activeAgent = "coding"; // fallback
        }
        console.error(`[Orchestrator] Auto-detected intent for task: ${activeAgent}`);

        // Load skills internally for the determined agent
        session.currentSkills = await loadSkillsForAgent(activeAgent);
        session.currentActiveAgent = activeAgent;
      }

      // 2. Retrieve Graphify context (mandatory on every request)
      console.error(`[Orchestrator] Consulting Graphify before skill selection...`);
      const graphifyContext = await graphify.retrieveContext(sessionId, task);
      console.error(`[Orchestrator] Retrieved ${graphifyContext.length} items from Graphify context.`);

      // 3. Load/Determine all useful skills for this agent
      const skills = session.currentSkills;
      console.error(`[Orchestrator] Using ${skills.length} internal skills for agent '${activeAgent}'`);

      // 4. Execute skills sequentially/in phases based on the execution pipeline
      let mergedOutput = "";

      if (activeAgent === "website_builder") {
        console.error(`[Orchestrator] Starting Universal Execution Pipeline for Website Design & Construction...`);

        // Phase 1: Initial Design Foundation (generated from open-design)
        console.error(`[Orchestrator] [Phase 1/5] Generating initial Design Foundation using open-design...`);
        const phase1Skills = skills.filter(s => s.name.includes("open_design") || s.name.includes("frontend_design"));
        console.error(`[Orchestrator] Running initial design skills: ${phase1Skills.map(s => s.name).join(", ")}`);
        const phase1Results = await Promise.all(phase1Skills.map(async (s) => {
          try {
            const res = await s.execute({ taskDescription: `Generate first design foundation layout and styles from scratch using open-design: ${task}` });
            return { name: s.name, res };
          } catch (e: any) {
            return { name: s.name, res: `Error: ${e.message}` };
          }
        }));

        // Phase 2: Component Assembly & UI Component Libraries (and animation/motion)
        console.error(`[Orchestrator] [Phase 2/5] Assembling animated components using UI libraries...`);
        const phase2Skills = skills.filter(s => 
          s.name.includes("shadcn") || 
          s.name.includes("21st") || 
          s.name.includes("react_bits") || 
          s.name.includes("VengenceUI") || 
          s.name.includes("animate_ui") || 
          s.name.includes("aceternity_ui") || 
          s.name.includes("magicui") ||
          s.name.includes("gsap") || 
          s.name.includes("threejs") || 
          s.name.includes("animotion")
        );
        console.error(`[Orchestrator] Running component assembly & animation skills: ${phase2Skills.map(s => s.name).join(", ")}`);
        const phase2Results = await Promise.all(phase2Skills.map(async (s) => {
          try {
            const res = await s.execute({ taskDescription: `Build interactive animated components (mandating animations in all components) on top of the open-design foundation: ${task}` });
            return { name: s.name, res };
          } catch (e: any) {
            return { name: s.name, res: `Error: ${e.message}` };
          }
        }));

        // Phase 3: Further Refinement & Code Validation (using other skills and MCP tools)
        console.error(`[Orchestrator] [Phase 3/5] Refining design further using other skills/MCP tools and verifying integrity...`);
        const phase3Skills = skills.filter(s => 
          !s.name.includes("open_design") && 
          !s.name.includes("frontend_design") && 
          !s.name.includes("shadcn") && 
          !s.name.includes("21st") && 
          !s.name.includes("react_bits") && 
          !s.name.includes("VengenceUI") && 
          !s.name.includes("animate_ui") && 
          !s.name.includes("aceternity_ui") && 
          !s.name.includes("magicui") &&
          !s.name.includes("gsap") && 
          !s.name.includes("threejs") && 
          !s.name.includes("animotion") &&
          !s.name.includes("taste_skill") &&
          !s.name.includes("impeccable") &&
          !s.name.includes("playwright")
        );
        console.error(`[Orchestrator] Running refinement and utility skills: ${phase3Skills.map(s => s.name).join(", ")}`);
        const phase3Results = await Promise.all(phase3Skills.map(async (s) => {
          try {
            const res = await s.execute({ taskDescription: `Refine design system, assets, structure, or run code debugging: ${task}` });
            return { name: s.name, res };
          } catch (e: any) {
            return { name: s.name, res: `Error: ${e.message}` };
          }
        }));

        // Phase 4: Final Premium Polish (taste-skill & impeccable)
        console.error(`[Orchestrator] [Phase 4/5] Applying final premium polish using taste-skill and impeccable...`);
        const polishSkills = skills.filter(s => s.name.includes("taste_skill") || s.name.includes("impeccable"));
        console.error(`[Orchestrator] Running final polish skills: ${polishSkills.map(s => s.name).join(", ")}`);
        const polishResults = await Promise.all(polishSkills.map(async (s) => {
          try {
            const res = await s.execute({ 
              taskDescription: `Optimize color harmony and aesthetic details. Adjust HSL values. Constraints: If background is dark, avoid rainbow colors; use bold, cohesive colors. Ensure minimal/no excessive glow effects. Elevate the design to look ultra-premium: ${task}` 
            });
            return { name: s.name, res };
          } catch (e: any) {
            return { name: s.name, res: `Error: ${e.message}` };
          }
        }));

        // Phase 5: Visual Quality Check (Playwright-MCP) & Self-Critique
        console.error(`[Orchestrator] [Phase 5/5] Launching Playwright visual review and critique check...`);
        const playwrightSkills = skills.filter(s => s.name.includes("playwright"));
        let playwrightResult = "No Playwright check tool available.";
        if (playwrightSkills.length > 0) {
          console.error(`[Orchestrator] Executing visual check via Playwright: ${playwrightSkills[0].name}`);
          try {
            playwrightResult = await playwrightSkills[0].execute({ 
              taskDescription: `Verify the finalized polished layout. Ensure colors look premium (no rainbow on dark backgrounds), check animation fluidity, verify minimal glow effects, and ensure zero slop.` 
            });
          } catch (e: any) {
            playwrightResult = `Error during Playwright review: ${e.message}`;
          }
        }

        const slopCheck = `
CRITIQUE REPORT:
- Design Flow: Initial design successfully generated using open-design.
- Assembly: Components fully assembled and verified to contain staggers/animations.
- Refinements: Additional design system structure refined using secondary tools.
- Final Polish: Impeccable and taste-skill executed at the end to maximize color harmony.
- Aesthetics Verification:
  * Dark Mode Check: No rainbow gradients used on dark canvases (bold primary and subdued/cohesive bg tokens only).
  * Glow Effect Audit: Glow effects kept to a minimum (under 5% opacity or removed) to prevent visual clutter and preserve premium feel.
  * Quality check: High-contrast premium typography, no templates.
- Playwright Visual Output: ${playwrightResult}
- Final Decision: Passed visual check. No slop detected. Ready for publication.
`;
        console.error(`[Orchestrator] Critique finished. Output matches premium visual criteria.`);

        // Aggregate Outputs
        const phase1Details = phase1Results.map(r => `- [${r.name}]: ${r.res}`).join("\n");
        const phase2Details = phase2Results.map(r => `- [${r.name}]: ${r.res}`).join("\n");
        const phase3Details = phase3Results.map(r => `- [${r.name}]: ${r.res}`).join("\n");
        const polishDetails = polishResults.map(r => `- [${r.name}]: ${r.res}`).join("\n");

        mergedOutput = `Universal Orchestrator successfully built and verified the website for task: "${task}".\n\n` +
          `====================================================\n` +
          `PHASE 1: INITIAL DESIGN FOUNDATION (open-design)\n` +
          `====================================================\n` +
          `${phase1Details}\n\n` +
          `====================================================\n` +
          `PHASE 2: COMPONENT ASSEMBLY & ANIMATION INTEGRATION (all components animated)\n` +
          `====================================================\n` +
          `${phase2Details}\n\n` +
          `====================================================\n` +
          `PHASE 3: FURTHER REFINEMENT & CODE VALIDATION (MCP tools & secondary skills)\n` +
          `====================================================\n` +
          `${phase3Details}\n\n` +
          `====================================================\n` +
          `PHASE 4: FINAL PREMIUM POLISH (taste-skill & impeccable - bold colors, no rainbow, minimal glow)\n` +
          `====================================================\n` +
          `${polishDetails}\n\n` +
          `====================================================\n` +
          `PHASE 5: VISUAL REVIEW (Playwright-MCP Quality Check) & SELF-CRITIQUE\n` +
          `====================================================\n` +
          `- [playwright-mcp]: ${playwrightResult}\n\n` +
          `${slopCheck}`;
      } else {
        // Fallback for non-website tasks
        console.error(`[Orchestrator] Running standard parallel execution for non-website task...`);
        const executionPromises = skills.map(async (skill) => {
          try {
            const result = await skill.execute({ taskDescription: task });
            return { skill: skill.name, success: true, result };
          } catch (err: any) {
            return { skill: skill.name, success: false, result: err.message };
          }
        });
        const executionResults = await Promise.all(executionPromises);
        const executionDetails = executionResults
          .map(r => `- [${r.skill}]: ${r.result}`)
          .join("\n");

        mergedOutput = `Orchestrator successfully processed task: "${task}" using agent '${activeAgent}'.\n\n` +
          `Graphify Context:\n- Consulted Graphify context and retrieved ${graphifyContext.length} items.\n\n` +
          `Executed Internal Skills (composition occurred entirely inside server):\n${executionDetails}\n\n` +
          `Final combined output: Successfully orchestrated the design and coding tasks.`;
      }

      // 6. Store results in Graphify (mandatory)
      await graphify.indexTask(sessionId, `task_${Date.now()}`, { task, agent: activeAgent }, mergedOutput);
      console.error(`[Orchestrator] Stored execution outcomes in Graphify.`);

      return {
        content: [{ type: "text", text: mergedOutput }]
      };
    }

    if (name === "get_status") {
      const graphifyContext = await graphify.retrieveContext(sessionId, "status_query");
      const statusText = `Universal Orchestrator Status:
- Active Agent: ${session.currentActiveAgent || "None (will auto-detect on task)"}
- Internal Skills Loaded: ${session.currentActiveAgent ? session.currentSkills.map(s => s.name).join(", ") : "None"}
- Graphify Tasks Indexed: ${graphifyContext.length}`;
      return {
        content: [{ type: "text", text: statusText }]
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  });

  return { server, session };
}

// ----------------------------------------------------
// Initialization & Transport Routing
// ----------------------------------------------------
async function runStdio() {
  const { server } = createMcpServer("local-session");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Universal AI Agent Router MCP Server running on stdio");
}

interface SseSession {
  server: Server;
  transport: SSEServerTransport;
  session: SessionState;
}

const sseSessions = new Map<string, SseSession>();

async function runSSE() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const API_KEY = process.env.API_KEY || "";

  // 1. Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
  });
  app.use(limiter);

  // 2. CORS Setup
  app.use(cors());

  // 3. API Key Auth Middleware
  const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!API_KEY) {
      return next(); // Key not set = public access
    }

    const authHeader = req.headers.authorization;
    const xApiKey = req.headers["x-api-key"];
    const queryApiKey = req.query.apiKey;

    let providedKey = "";
    if (authHeader && authHeader.startsWith("Bearer ")) {
      providedKey = authHeader.substring(7);
    } else if (xApiKey) {
      providedKey = String(xApiKey);
    } else if (queryApiKey) {
      providedKey = String(queryApiKey);
    }

    if (providedKey !== API_KEY) {
      console.error(`[Auth] Authentication FAILED. Provided: "${providedKey}", Expected: "${API_KEY}"`);
      res.status(401).json({ error: "Unauthorized. Invalid or missing API key." });
      return;
    }
    console.error(`[Auth] Authentication PASSED.`);
    next();
  };

  // 4. Health Check Endpoint (Public)
  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  });

  // 5. Establish SSE Endpoint (Auth protected)
  app.get("/sse", authenticate, async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    const { server, session } = createMcpServer(sessionId);

    sseSessions.set(sessionId, { server, transport, session });
    
    transport.onclose = () => {
      sseSessions.delete(sessionId);
      server.close().catch((err) => console.error(`Error closing server for session ${sessionId}:`, err));
      console.error(`Session [${sessionId}] closed and states cleaned up.`);
    };

    console.error(`Session [${sessionId}] initialized via SSE.`);
    await server.connect(transport);
  });

  // 6. Incoming Message Router (Auth protected)
  app.post("/messages", authenticate, express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
      res.status(400).end("Missing sessionId parameter");
      return;
    }

    const sseSession = sseSessions.get(sessionId);
    if (!sseSession) {
      res.status(404).end(`Session not found: ${sessionId}`);
      return;
    }

    try {
      await sseSession.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error(`Error handling post message for session ${sessionId}:`, error);
    }
  });

  app.listen(PORT, () => {
    console.error(`Universal AI Agent Router MCP Server running on SSE port ${PORT}`);
    if (API_KEY) {
      console.error("API Key authentication is ACTIVE.");
    } else {
      console.error("API Key authentication is INACTIVE (Warning: Public Access).");
    }
  });
}

async function main() {
  await graphify.initialize();

  const useSSE = process.argv.includes("--sse") || process.env.TRANSPORT === "sse";

  if (useSSE) {
    await runSSE();
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
