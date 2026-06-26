const fs = require('fs');
const path = require('path');

const targetDir = "C:\\Users\\Shriyans\\.gemini\\antigravity\\mcp\\universal-orchestrator";
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function writeSchema(tool) {
  const schema = {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  };
  fs.writeFileSync(path.join(targetDir, `${tool.name}.json`), JSON.stringify(schema, null, 2));
}

writeSchema({
  name: "create_prd",
  description: "MUST be called before starting any significant task (website build, new feature, coding task). Generates a structured Implementation Plan / PRD, presents it to the user for review and confirmation. The user MUST confirm before work begins. This prevents wasted tokens and misaligned work.",
  inputSchema: {
    type: "object",
    properties: {
      taskDescription: { type: "string", description: "Full description of the task to plan" },
      agentType: { type: "string", description: "Type of agent/task: website_builder, coding, research, motion_animation, default", enum: ["website_builder", "coding", "research", "motion_animation", "default"] }
    },
    required: ["taskDescription", "agentType"]
  }
});

writeSchema({
  name: "confirm_prd",
  description: "Called by the orchestrator after the user reviews the PRD. Marks it as confirmed (optionally with revision feedback). Execution must not begin until this returns confirmed=true.",
  inputSchema: {
    type: "object",
    properties: {
      prdId: { type: "string", description: "The PRD ID returned by create_prd" },
      feedback: { type: "string", description: "Optional: user's feedback or change requests. If provided, the PRD is revised before confirmation." },
      confirmed: { type: "boolean", description: "true = proceed, false = reject (requires feedback)" }
    },
    required: ["prdId", "confirmed"]
  }
});

writeSchema({
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
});

writeSchema({
  name: "push_to_github",
  description: "Commits all current changes and pushes to GitHub. Always call this after a task is fully complete, verified, and debugged. Uses conventional commits format. Excludes skills/ and node_modules/ from commits automatically.",
  inputSchema: {
    type: "object",
    properties: {
      taskDescription: { type: "string", description: "Description of what was done — used to generate the commit message" },
      agentType: { type: "string", description: "Type of task: website_builder, coding, research, etc. Used for commit prefix (feat/fix/docs/chore)", enum: ["website_builder", "coding", "research", "motion_animation", "default"] },
      dryRun: { type: "boolean", description: "If true, shows what would be committed without actually committing. Useful for review." }
    },
    required: ["taskDescription", "agentType"]
  }
});

writeSchema({
  name: "run_debug_pass",
  description: "Runs a debugging pass using the debug-skill and Playwright. Checks for JS runtime errors, CSS conflicts, broken imports, and logic bugs. Always call this before push_to_github.",
  inputSchema: {
    type: "object",
    properties: {
      targetDescription: { type: "string", description: "Description of what was built — used to focus the debug analysis" },
      targetUrl: { type: "string", description: "Optional: URL or file path to open in Playwright for visual debugging" }
    },
    required: ["targetDescription"]
  }
});

writeSchema({
  name: "fork_verifier_agent",
  description: "Spawns a background sub-agent that verifies design quality. The agent uses Playwright to screenshot the output, checks React Bits components, validates animations, detects design slop (rainbow gradients on dark backgrounds, excessive glow, template patterns), and reports issues. Call after completing a design. You do NOT need to wait — the verifier runs asynchronously and reports back only if issues are found.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The specific verification task. E.g., 'Check spacing on hero section', 'Verify animations are working', or 'Full design quality audit'." },
      targetUrl: { type: "string", description: "Optional: URL or file path to verify. If omitted, verifier uses the most recently opened file." },
      focusAreas: { type: "array", items: { type: "string" }, description: "Optional: specific areas to focus on, e.g., ['layout', 'colors', 'animations', 'react-bits-rendering', 'mobile-responsiveness']" }
    },
    required: ["task"]
  }
});

writeSchema({
  name: "get_verifier_status",
  description: "Gets the status and report of a running or completed verifier sub-agent job.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "The job ID returned by fork_verifier_agent" }
    },
    required: ["jobId"]
  }
});

writeSchema({
  name: "react_bits_list_components",
  description: "Lists all available React Bits components organized by category (Animations, Backgrounds, Components, TextAnimations). Use this to discover what components are available before building any UI.",
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Optional: filter by category. One of: Animations, Backgrounds, Components, TextAnimations", enum: ["Animations", "Backgrounds", "Components", "TextAnimations"] }
    }
  }
});

writeSchema({
  name: "react_bits_get_source",
  description: "Retrieves the full source code for a specific React Bits component. Returns all files needed to use the component (JSX, CSS, etc.). Copy these files directly into your project.",
  inputSchema: {
    type: "object",
    properties: {
      componentName: { type: "string", description: "The component name to retrieve (e.g., 'SpotlightCard', 'Aurora', 'SplitText', 'FlowingMenu')" },
      variant: { type: "string", description: "Which variant to retrieve. Default: 'TS-CSS' (TypeScript + plain CSS). Options: JS-CSS, JS-TW, TS-CSS, TS-TW", enum: ["JS-CSS", "JS-TW", "TS-CSS", "TS-TW"] }
    },
    required: ["componentName"]
  }
});

writeSchema({
  name: "react_bits_search",
  description: "Searches React Bits components by name, category, or description keyword. Use this to find the right component for a specific UI need (e.g., 'cursor effect', 'text reveal', 'glassmorphism').",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query — can be a component name, visual effect type, category, or UI description" }
    },
    required: ["query"]
  }
});

console.log("Schemas written successfully.");
