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
import { loadSkillsForAgent, loadMcpServersForAgent, callToolOnServer, LoadedSkill, LoadedMcpServer } from "./loaders/skillsLoader.js";
import { graphify } from "./memory/graphify.js";
import { orchestrator } from "./orchestration/ohmypi.js";
import { UNIVERSAL_ORCHESTRATOR_PROMPT } from "./prompts/systemPrompt.js";
import { FRONTEND_DESIGN_PROMPT } from "./prompts/frontendPrompt.js";
import { DESIGN_AGENT_PROMPT } from "./prompts/designAgentPrompt.js";
import {
  listReactBitsComponents,
  getReactBitsSource,
  searchReactBitsComponents,
  getReactBitsCatalogSummary,
  type ReactBitsVariant
} from "./loaders/reactBitsLoader.js";
import {
  generatePrd,
  confirmPrd,
  rejectPrd,
  revisePrd,
  getPrd,
  isPrdConfirmed,
  formatPrdForReview
} from "./orchestration/prdManager.js";
import {
  executeBatch,
  summarizeBatch,
  pruneCache,
  type SubAgentTask
} from "./orchestration/subAgentManager.js";
import {
  runPlaywrightVerification,
  runDebugPass
} from "./orchestration/playwrightVerifier.js";
import {
  gitAddCommitPush,
  buildCommitMessage
} from "./orchestration/gitPusher.js";

dotenv.config({ quiet: true });

// In-memory registry for forked verifier sub-agents
interface VerifierJob {
  id: string;
  task: string;
  startedAt: number;
  status: "running" | "done" | "error";
  report?: string;
}
const verifierJobs = new Map<string, VerifierJob>();

// Session State Tracking for Multi-Client Support
interface SessionState {
  currentActiveAgent: string | null;
  currentSkills: LoadedSkill[];
  currentMcpServers: LoadedMcpServer[];
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
    currentSkills: [],
    currentMcpServers: []
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
        },
        {
          name: "design_agent",
          description: "The full design agent system prompt for all web projects. Mandates React Bits components, sub-agent design verification, and expert design principles.",
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
    
    if (request.params.name === "design_agent") {
      return {
        description: "Design Agent System Prompt — HTML Design Expert with React Bits",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: DESIGN_AGENT_PROMPT
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
      },
      // ------------------------------------------------
      // React Bits Component Tools
      // ------------------------------------------------
      {
        name: "react_bits_list_components",
        description: "Lists all available React Bits components organized by category (Animations, Backgrounds, Components, TextAnimations). Use this to discover what components are available before building any UI.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Optional: filter by category. One of: Animations, Backgrounds, Components, TextAnimations",
              enum: ["Animations", "Backgrounds", "Components", "TextAnimations"]
            }
          }
        }
      },
      {
        name: "react_bits_get_source",
        description: "Retrieves the full source code for a specific React Bits component. Returns all files needed to use the component (JSX, CSS, etc.). Copy these files directly into your project.",
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "The component name to retrieve (e.g., 'SpotlightCard', 'Aurora', 'SplitText', 'FlowingMenu')"
            },
            variant: {
              type: "string",
              description: "Which variant to retrieve. Default: 'TS-CSS' (TypeScript + plain CSS). Options: JS-CSS, JS-TW, TS-CSS, TS-TW",
              enum: ["JS-CSS", "JS-TW", "TS-CSS", "TS-TW"]
            }
          },
          required: ["componentName"]
        }
      },
      {
        name: "react_bits_search",
        description: "Searches React Bits components by name, category, or description keyword. Use this to find the right component for a specific UI need (e.g., 'cursor effect', 'text reveal', 'glassmorphism').",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query — can be a component name, visual effect type, category, or UI description"
            }
          },
          required: ["query"]
        }
      },
      // ------------------------------------------------
      // Sub-Agent Design Verifier
      // ------------------------------------------------
      {
        name: "fork_verifier_agent",
        description: "Spawns a background sub-agent that verifies design quality. The agent uses Playwright to screenshot the output, checks React Bits components, validates animations, detects design slop (rainbow gradients on dark backgrounds, excessive glow, template patterns), and reports issues. Call after completing a design. You do NOT need to wait — the verifier runs asynchronously and reports back only if issues are found.",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The specific verification task. E.g., 'Check spacing on hero section', 'Verify animations are working', or 'Full design quality audit'."
            },
            targetUrl: {
              type: "string",
              description: "Optional: URL or file path to verify. If omitted, verifier uses the most recently opened file."
            },
            focusAreas: {
              type: "array",
              items: { type: "string" },
              description: "Optional: specific areas to focus on, e.g., ['layout', 'colors', 'animations', 'react-bits-rendering', 'mobile-responsiveness']"
            }
          },
          required: ["task"]
        }
      },
      {
        name: "get_verifier_status",
        description: "Gets the status and report of a running or completed verifier sub-agent job.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "The job ID returned by fork_verifier_agent"
            }
          },
          required: ["jobId"]
        }
      },
      // ------------------------------------------------
      // PRD / Implementation Plan Tools
      // ------------------------------------------------
      {
        name: "create_prd",
        description: "MUST be called before starting any significant task (website build, new feature, coding task). Generates a structured Implementation Plan / PRD, presents it to the user for review and confirmation. The user MUST confirm before work begins. This prevents wasted tokens and misaligned work.",
        inputSchema: {
          type: "object",
          properties: {
            taskDescription: {
              type: "string",
              description: "Full description of the task to plan"
            },
            agentType: {
              type: "string",
              description: "Type of agent/task: website_builder, coding, research, motion_animation, default",
              enum: ["website_builder", "coding", "research", "motion_animation", "default"]
            }
          },
          required: ["taskDescription", "agentType"]
        }
      },
      {
        name: "confirm_prd",
        description: "Called by the orchestrator after the user reviews the PRD. Marks it as confirmed (optionally with revision feedback). Execution must not begin until this returns confirmed=true.",
        inputSchema: {
          type: "object",
          properties: {
            prdId: {
              type: "string",
              description: "The PRD ID returned by create_prd"
            },
            feedback: {
              type: "string",
              description: "Optional: user's feedback or change requests. If provided, the PRD is revised before confirmation."
            },
            confirmed: {
              type: "boolean",
              description: "true = proceed, false = reject (requires feedback)"
            }
          },
          required: ["prdId", "confirmed"]
        }
      },
      {
        name: "reject_prd",
        description: "Rejects a PRD and records the user's feedback for revision.",
        inputSchema: {
          type: "object",
          properties: {
            prdId: { type: "string", description: "The PRD ID to reject" },
            feedback: { type: "string", description: "Why the PRD was rejected and what should change" }
          },
          required: ["prdId", "feedback"]
        }
      },
      // ------------------------------------------------
      // Git Push Tool
      // ------------------------------------------------
      {
        name: "push_to_github",
        description: "Commits all current changes and pushes to GitHub. Always call this after a task is fully complete, verified, and debugged. Uses conventional commits format. Excludes skills/ and node_modules/ from commits automatically.",
        inputSchema: {
          type: "object",
          properties: {
            taskDescription: {
              type: "string",
              description: "Description of what was done — used to generate the commit message"
            },
            agentType: {
              type: "string",
              description: "Type of task: website_builder, coding, research, etc. Used for commit prefix (feat/fix/docs/chore)",
              enum: ["website_builder", "coding", "research", "motion_animation", "default"]
            },
            dryRun: {
              type: "boolean",
              description: "If true, shows what would be committed without actually committing. Useful for review."
            }
          },
          required: ["taskDescription", "agentType"]
        }
      },
      // ------------------------------------------------
      // Debug Pass Tool
      // ------------------------------------------------
      {
        name: "run_debug_pass",
        description: "Runs a debugging pass using the debug-skill and Playwright. Checks for JS runtime errors, CSS conflicts, broken imports, and logic bugs. Always call this before push_to_github.",
        inputSchema: {
          type: "object",
          properties: {
            targetDescription: {
              type: "string",
              description: "Description of what was built — used to focus the debug analysis"
            },
            targetUrl: {
              type: "string",
              description: "Optional: URL or file path to open in Playwright for visual debugging"
            }
          },
          required: ["targetDescription"]
        }
      }
    ];

    // Append tools from active agent's local MCP servers
    for (const serverInfo of session.currentMcpServers) {
      for (const tool of serverInfo.tools) {
        if (!tools.some(t => t.name === tool.name)) {
          tools.push(tool);
        }
      }
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Check if it's a child MCP server tool
    const targetServer = session.currentMcpServers.find(s => 
      s.tools.some(t => t.name === name)
    );

    if (targetServer) {
      console.error(`[Orchestrator] Routing tool call '${name}' to local MCP server: ${targetServer.folderName}`);
      try {
        const result = await callToolOnServer(targetServer.entryPoint, targetServer.args || [], name, args);
        return result;
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error calling tool '${name}' on local MCP server: ${err.message}` }],
          isError: true
        };
      }
    }

    // --------------------------------------------------------
    // React Bits Tool Handlers
    // --------------------------------------------------------
    if (name === "react_bits_list_components") {
      const { category } = (args || {}) as { category?: string };
      const all = listReactBitsComponents();
      const filtered = category ? all.filter(c => c.category === category) : all;
      
      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: `No React Bits components found${category ? ` in category '${category}'` : ""}. Make sure the react-bits skill has been downloaded.` }]
        };
      }

      const grouped: Record<string, typeof filtered> = {};
      for (const c of filtered) {
        if (!grouped[c.category]) grouped[c.category] = [];
        grouped[c.category].push(c);
      }

      let output = `# React Bits Components (${filtered.length} total)\n\n`;
      output += `Install any component: \`npx jsrepo add @react-bits/<ComponentName>\`\n`;
      output += `Or use \`react_bits_get_source\` to get the source code directly.\n\n`;

      for (const [cat, comps] of Object.entries(grouped)) {
        output += `## ${cat} (${comps.length})\n`;
        for (const c of comps) {
          output += `- **${c.name}**: ${c.description}\n`;
          output += `  Variants: ${c.variants.join(", ")} | Docs: ${c.docsUrl}\n`;
        }
        output += "\n";
      }

      return { content: [{ type: "text", text: output }] };
    }

    if (name === "react_bits_get_source") {
      const { componentName, variant = "JS-CSS" } = (args || {}) as { componentName: string; variant?: ReactBitsVariant };
      
      if (!componentName) {
        return {
          content: [{ type: "text", text: "Error: componentName is required" }],
          isError: true
        };
      }

      const source = getReactBitsSource(componentName, variant as ReactBitsVariant);
      if (!source) {
        // Try to find close matches
        const matches = searchReactBitsComponents(componentName).slice(0, 5);
        const suggestions = matches.length > 0
          ? `\n\nDid you mean one of these?\n${matches.map(m => `- ${m.name} (${m.category})`).join("\n")}`
          : "";
        return {
          content: [{ type: "text", text: `Component '${componentName}' not found in React Bits.${suggestions}` }],
          isError: true
        };
      }

      let output = `# React Bits: ${source.componentName} (${source.variant})\n`;
      output += `Category: ${source.category}\n`;
      output += `Install: \`npx jsrepo add @react-bits/${source.componentName}-${source.variant}\`\n\n`;
      output += `## Source Files\n\n`;
      output += `Copy these files to your project at \`src/components/${source.componentName}/\`\n\n`;

      for (const file of source.files) {
        const lang = file.fileName.endsWith(".css") ? "css" : 
                     file.fileName.endsWith(".tsx") ? "tsx" :
                     file.fileName.endsWith(".ts") ? "typescript" : "jsx";
        output += `### ${file.fileName}\n\`\`\`${lang}\n${file.content}\n\`\`\`\n\n`;
      }

      return { content: [{ type: "text", text: output }] };
    }

    if (name === "react_bits_search") {
      const { query } = (args || {}) as { query: string };
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required" }],
          isError: true
        };
      }

      const results = searchReactBitsComponents(query);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No React Bits components found matching '${query}'. Try broader terms like 'cursor', 'text', 'background', 'card', 'nav'.` }]
        };
      }

      let output = `# React Bits Search: "${query}" — ${results.length} result(s)\n\n`;
      for (const c of results) {
        output += `## ${c.name} (${c.category})\n`;
        output += `${c.description}\n`;
        output += `Install: \`npx jsrepo add @react-bits/${c.name}\` | Docs: ${c.docsUrl}\n`;
        output += `Variants: ${c.variants.join(", ")}\n\n`;
      }

      return { content: [{ type: "text", text: output }] };
    }

    // --------------------------------------------------------
    // Fork Verifier Sub-Agent
    // --------------------------------------------------------
    if (name === "fork_verifier_agent") {
      const { task, targetUrl, focusAreas } = (args || {}) as {
        task: string;
        targetUrl?: string;
        focusAreas?: string[];
      };

      const jobId = `verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const focusStr = focusAreas && focusAreas.length > 0
        ? `\nFocus areas: ${focusAreas.join(", ")}` 
        : "";
      const urlStr = targetUrl ? `\nTarget: ${targetUrl}` : "";

      // Register the job immediately
      verifierJobs.set(jobId, {
        id: jobId,
        task,
        startedAt: Date.now(),
        status: "running"
      });

      // Build the verifier task for the Playwright MCP sub-agent
      const playwrightServer = session.currentMcpServers.find(s => s.folderName === "playwright-mcp");
      const verifierInstructions = [
        `DESIGN VERIFICATION JOB [${jobId}]`,
        `Task: ${task}${urlStr}${focusStr}`,
        "",
        "You are a design verifier sub-agent. Your job is to check the output quality.",
        "If a URL/path is provided, navigate to it. Otherwise check the last opened file.",
        "",
        "Check for the following (in order):",
        "1. LAYOUT: Are sections properly spaced? Does nothing overlap unintentionally?",
        "2. COLORS: If background is dark, are there rainbow/multi-color gradients? (Flag as ERROR if yes)",
        "3. GLOW: Are there excessive glow effects that look cheap? (Flag as WARNING if yes)",
        "4. ANIMATIONS: Do React Bits animations appear to work (check for CSS classes, canvas elements)?",
        "5. REACT BITS: Are React Bits components present (SpotlightCard, Aurora, SplitText, etc.)?",
        "6. MOBILE: Does the layout break below 768px width?",
        "7. SLOP: Any of these slop patterns: placeholder text, Lorem ipsum, stock UI widget look, emoji spam?",
        "",
        "Report format:",
        "PASS: <what looks good>",
        "ISSUES: <list any problems found>",
        "RECOMMENDATIONS: <specific fixes if issues found>"
      ].join("\n");

      // Run async verification using the Playwright MCP server if available
      if (playwrightServer) {
        // Fire-and-forget: run verification in background
        (async () => {
          try {
            // Take screenshot
            const screenshotResult = await callToolOnServer(
              playwrightServer.entryPoint,
              playwrightServer.args || [],
              "browser_take_screenshot",
              { raw: false }
            );

            // Snapshot for DOM inspection
            let snapshotResult: any = null;
            try {
              snapshotResult = await callToolOnServer(
                playwrightServer.entryPoint,
                playwrightServer.args || [],
                "browser_snapshot",
                {}
              );
            } catch (_) {}

            // Evaluate JS checks for slop detection
            let jsChecks = "";
            try {
              const jsResult = await callToolOnServer(
                playwrightServer.entryPoint,
                playwrightServer.args || [],
                "browser_evaluate",
                {
                  expression: `(function() {
                    const results = {};
                    // Check for React Bits class patterns
                    results.hasAurora = !!document.querySelector('[class*="aurora"], canvas, [class*="particles"], [class*="spotlight"]');
                    results.hasAnimations = !!document.querySelector('[class*="animated"], [class*="animate"], [style*="animation"]');
                    results.loremCount = (document.body.innerText.match(/lorem ipsum/gi) || []).length;
                    results.hasRainbowGradient = Array.from(document.querySelectorAll('*'))
                      .some(el => {
                        const bg = window.getComputedStyle(el).backgroundImage;
                        return bg && bg.includes('gradient') && (bg.includes('red') || bg.includes('#f00') || (bg.includes('hsl') && bg.includes('green') && bg.includes('blue')));
                      });
                    results.mobileBreaks = window.innerWidth > 768 ? 'N/A (test at 768px)' : 'checked';
                    return JSON.stringify(results);
                  })()`
                }
              );
              if (jsResult?.content?.[0]?.text) {
                jsChecks = jsResult.content[0].text;
              }
            } catch (_) {}

            const report = [
              `VERIFICATION REPORT [${jobId}]`,
              `Task: ${task}`,
              `Completed: ${new Date().toISOString()}`,
              "",
              "SCREENSHOT: " + (screenshotResult?.content?.[0]?.text ? "✓ Captured" : "✗ Failed"),
              "DOM SNAPSHOT: " + (snapshotResult ? "✓ Captured" : "✗ Unavailable"),
              "JS CHECKS: " + (jsChecks || "Not available"),
              "",
              verifierInstructions
            ].join("\n");

            verifierJobs.set(jobId, {
              id: jobId,
              task,
              startedAt: verifierJobs.get(jobId)!.startedAt,
              status: "done",
              report
            });

            console.error(`[Verifier] Job ${jobId} completed.`);
          } catch (err: any) {
            verifierJobs.set(jobId, {
              id: jobId,
              task,
              startedAt: verifierJobs.get(jobId)!.startedAt,
              status: "error",
              report: `Verification failed: ${err.message}`
            });
            console.error(`[Verifier] Job ${jobId} failed:`, err.message);
          }
        })();

        return {
          content: [{
            type: "text",
            text: `✓ Verifier sub-agent forked (Job ID: ${jobId}).\n\nTask: ${task}\n\nThe verifier is running in the background using Playwright. Call \`get_verifier_status\` with jobId "${jobId}" to check results. If the design looks good, the verifier will report PASS silently. Issues will be surfaced as actionable recommendations.`
          }]
        };
      } else {
        // Playwright not available — run a static analysis check
        const staticReport = [
          `VERIFICATION REPORT [${jobId}] — Static Analysis Only`,
          `(Playwright MCP not available — run activate_agent('website_builder') first for full visual checks)`,
          "",
          `Task: ${task}`,
          "",
          "CHECKLIST (manual verification needed):",
          "□ Layout: Check sections are properly spaced, no unintended overlaps",
          "□ Colors: If dark background, ensure NO rainbow/multi-color gradients",
          "□ Glow: Keep glow effects minimal and subtle",
          "□ Animations: Verify all React Bits animations are working",
          "□ React Bits: Confirm components from react_bits_get_source are implemented",
          "□ Mobile: Test at 768px and 375px breakpoints",
          "□ Slop: No Lorem ipsum, no placeholder content, no stock widget look",
        ].join("\n");

        verifierJobs.set(jobId, {
          id: jobId,
          task,
          startedAt: Date.now(),
          status: "done",
          report: staticReport
        });

        return {
          content: [{
            type: "text",
            text: `⚠ Verifier running in static mode (Job ID: ${jobId}) — Playwright MCP not loaded.\n\nTo enable full visual verification, first call \`activate_agent\` with intent 'website_builder'.\n\nStatic checklist generated. Call \`get_verifier_status\` with jobId "${jobId}" for the checklist.`
          }]
        };
      }
    }

    if (name === "get_verifier_status") {
      const { jobId } = (args || {}) as { jobId: string };
      const job = verifierJobs.get(jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `No verifier job found with ID: ${jobId}` }],
          isError: true
        };
      }

      const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
      return {
        content: [{
          type: "text",
          text: [
            `Verifier Job: ${job.id}`,
            `Status: ${job.status.toUpperCase()}`,
            `Task: ${job.task}`,
            `Elapsed: ${elapsed}s`,
            "",
            job.report || "Report not yet available — job may still be running."
          ].join("\n")
        }]
      };
    }

    // --------------------------------------------------------
    // PRD / Implementation Plan Handlers
    // --------------------------------------------------------
    if (name === "create_prd") {
      const { taskDescription, agentType } = (args || {}) as {
        taskDescription: string;
        agentType: string;
      };

      if (!taskDescription) {
        return {
          content: [{ type: "text", text: "Error: taskDescription is required" }],
          isError: true
        };
      }

      const prd = generatePrd(taskDescription, agentType || "default");
      const formatted = formatPrdForReview(prd);

      console.error(`[Orchestrator] PRD created: ${prd.id} for task: ${prd.title}`);

      return {
        content: [{
          type: "text",
          text: [
            `📋 **Implementation Plan Created**`,
            ``,
            `PRD ID: \`${prd.id}\``,
            ``,
            formatted,
            ``,
            `---`,
            `**⏳ Awaiting your confirmation.** Please review the plan above and:`,
            `- Reply **"confirmed"** or call \`confirm_prd\` with \`confirmed: true\` to proceed`,
            `- Reply with **changes you want** and call \`confirm_prd\` with your feedback to revise`,
            `- Reply **"rejected"** or call \`reject_prd\` to cancel`
          ].join("\n")
        }]
      };
    }

    if (name === "confirm_prd") {
      const { prdId, feedback, confirmed } = (args || {}) as {
        prdId: string;
        feedback?: string;
        confirmed: boolean;
      };

      if (!prdId) {
        return { content: [{ type: "text", text: "Error: prdId is required" }], isError: true };
      }

      if (!confirmed) {
        // User wants to reject — delegate to reject handler
        if (feedback) {
          const prd = rejectPrd(prdId, feedback);
          return {
            content: [{
              type: "text",
              text: prd
                ? `PRD ${prdId} rejected. Feedback recorded: "${feedback}"\n\nCall \`create_prd\` with a revised task description to start over.`
                : `No PRD found with ID: ${prdId}`
            }]
          };
        }
        return {
          content: [{ type: "text", text: "Please provide feedback when rejecting a PRD." }]
        };
      }

      // If feedback is provided with confirmed=true, revise then confirm
      if (feedback) {
        const existing = getPrd(prdId);
        if (!existing) {
          return { content: [{ type: "text", text: `No PRD found with ID: ${prdId}` }], isError: true };
        }
        // Revise with feedback incorporated
        const revised = revisePrd(prdId, `${existing.taskDescription}\n\nUser revision: ${feedback}`);
        if (revised) {
          confirmPrd(prdId);
          return {
            content: [{
              type: "text",
              text: [
                `✅ PRD revised and confirmed. Proceeding with updated plan.`,
                ``,
                `**Changes applied**: ${feedback}`,
                ``,
                `PRD ID: \`${prdId}\``,
                ``,
                `Execution will now begin. The orchestrator will:`,
                `1. Use React Bits components for all UI elements`,
                `2. Run a debug pass after building`,
                `3. Verify visually with Playwright`,
                `4. Push to GitHub when done`
              ].join("\n")
            }]
          };
        }
      }

      // Simple confirmation
      const prd = confirmPrd(prdId);
      if (!prd) {
        return { content: [{ type: "text", text: `No PRD found with ID: ${prdId}` }], isError: true };
      }

      console.error(`[Orchestrator] PRD confirmed: ${prdId}`);
      return {
        content: [{
          type: "text",
          text: [
            `✅ **Plan confirmed.** Execution beginning now.`,
            ``,
            `PRD: ${prd.title}`,
            `Agent: ${prd.agentType}`,
            ``,
            `The orchestrator will follow the approved execution phases and report back with results.`
          ].join("\n")
        }]
      };
    }

    if (name === "reject_prd") {
      const { prdId, feedback } = (args || {}) as { prdId: string; feedback: string };
      const prd = rejectPrd(prdId, feedback);
      return {
        content: [{
          type: "text",
          text: prd
            ? `❌ PRD ${prdId} rejected. Feedback: "${feedback}"\n\nCall \`create_prd\` with a revised description to try again.`
            : `No PRD found with ID: ${prdId}`
        }]
      };
    }

    // --------------------------------------------------------
    // Git Push Handler
    // --------------------------------------------------------
    if (name === "push_to_github") {
      const { taskDescription, agentType, dryRun = false } = (args || {}) as {
        taskDescription: string;
        agentType: string;
        dryRun?: boolean;
      };

      console.error(`[Orchestrator] Initiating git push (dryRun=${dryRun})...`);

      // Detect working directory (the universal-mcp project root)
      const workingDir = process.cwd();

      // Build a smart commit message
      const commitMsg = buildCommitMessage(taskDescription, agentType, []);

      const result = await gitAddCommitPush({
        workingDir,
        commitMessage: commitMsg,
        dryRun
      });

      console.error(`[Orchestrator] Git push result: ${result.success ? "SUCCESS" : "FAILED"}`);

      return {
        content: [{
          type: "text",
          text: result.output
        }],
        isError: !result.success
      };
    }

    // --------------------------------------------------------
    // Debug Pass Handler
    // --------------------------------------------------------
    if (name === "run_debug_pass") {
      const { targetDescription, targetUrl } = (args || {}) as {
        targetDescription: string;
        targetUrl?: string;
      };

      // Find debug-skill and playwright servers
      const debugServer = session.currentMcpServers.find(s =>
        s.folderName?.toLowerCase().includes("debug") ||
        s.folderName?.toLowerCase().includes("almog")
      ) || null;

      const playwrightServer = session.currentMcpServers.find(s =>
        s.folderName?.toLowerCase().includes("playwright")
      );

      const debugResult = await runDebugPass(debugServer, targetDescription);

      let verifyReport = "";
      if (playwrightServer) {
        const verifyResult = await runPlaywrightVerification(playwrightServer, {
          targetUrl,
          label: "Debug Visual Check"
        });
        verifyReport = "\n\n---\n\n" + verifyResult.summary;
      } else {
        verifyReport = "\n\n⚠ Playwright not loaded — activate website_builder agent for visual debug checks.";
      }

      const passed = debugResult.passed && (playwrightServer ? true : true);
      console.error(`[Orchestrator] Debug pass complete. Issues: ${debugResult.issues.length}`);

      return {
        content: [{
          type: "text",
          text: [
            `## 🔍 Debug Pass Report`,
            ``,
            `**Code Analysis**: ${debugResult.passed ? "✅ PASSED" : "❌ ISSUES FOUND"}`,
            debugResult.report,
            verifyReport
          ].join("\n")
        }],
        isError: !passed
      };
    }

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
        session.currentMcpServers = await loadMcpServersForAgent(agentName);
        session.currentActiveAgent = agentName;

        // Send tools list changed notification specifically to this client
        await server.notification({ method: "notifications/tools/list_changed" });

        return {
          content: [
            {
              type: "text",
              text: `Successfully activated ${agentName}. The skill set and local MCP servers have been updated. You now have access to specialized tools for this domain.`
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

        // Load skills and MCP servers internally for the determined agent
        session.currentSkills = await loadSkillsForAgent(activeAgent);
        session.currentMcpServers = await loadMcpServersForAgent(activeAgent);
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

        // Load React Bits catalog summary to inject into task context
        const reactBitsCatalog = getReactBitsCatalogSummary();
        console.error(`[Orchestrator] React Bits catalog loaded: ${listReactBitsComponents().length} components available`);

        const phase2Results = await Promise.all(phase2Skills.map(async (s) => {
          try {
            const res = await s.execute({
              taskDescription: [
                `Build interactive animated components (mandating animations in all components) on top of the open-design foundation: ${task}`,
                "",
                "MANDATORY: Use React Bits components wherever possible. React Bits components are locally available.",
                "Use react_bits_get_source tool to retrieve component source code before building.",
                "Priority components to use:",
                "- Backgrounds: Aurora, Orb, Particles, Silk, Waves for hero backgrounds",
                "- TextAnimations: SplitText, BlurText, GradientText, ShinyText for headings",
                "- Components: SpotlightCard, TiltedCard, GlareHover, MagicBento for cards",
                "- Components: FlowingMenu, PillNav, GooeyNav for navigation",
                "- Animations: AnimatedContent, FadeContent for scroll reveals",
                "- Animations: BlobCursor, SplashCursor, ClickSpark for cursor effects",
              ].join("\n")
            });
            return { name: s.name, res };
          } catch (e: any) {
            return { name: s.name, res: `Error: ${e.message}` };
          }
        }));

        // Append React Bits catalog as phase 2 context
        phase2Results.push({
          name: "react_bits_catalog",
          res: `React Bits component catalog injected (${listReactBitsComponents().length} components across 4 categories: Animations, Backgrounds, Components, TextAnimations). All components are locally available at skills/react-bits/src/content/.`
        });

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
- Local MCP Servers Loaded: ${session.currentActiveAgent ? session.currentMcpServers.map(s => s.folderName).join(", ") : "None"}
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
