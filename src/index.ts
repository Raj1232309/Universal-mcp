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

dotenv.config();

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
      }
    ];

    if (session.currentActiveAgent) {
      for (const skill of session.currentSkills) {
        tools.push({
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema
        });
      }
    }

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

    // Handle dynamic skill execution
    if (session.currentActiveAgent) {
      const skill = session.currentSkills.find(s => s.name === name);
      if (skill) {
        try {
          const result = await skill.execute(args);
          
          // Save execution to session-scoped memory
          await graphify.indexTask(sessionId, `task_${Date.now()}`, args, result);

          return {
            content: [{ type: "text", text: result }]
          };
        } catch (error: any) {
          return {
            content: [{ type: "text", text: `Error executing skill ${name}: ${error.message}` }],
            isError: true
          };
        }
      }
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
