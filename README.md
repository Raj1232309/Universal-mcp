# Universal AI Agent Router (Infinity MCP) Orchestrator

The **Universal AI Agent Router** (powered by **Infinity MCP**) is an autonomous orchestration layer designed to coordinate specialized agent capabilities, memory systems, and design frameworks to build premium, slop-free software and web experiences.

By using persistent memory, dynamic capability loading, and a sequenced execution pipeline, it abstracts the complexity of selecting individual design and coding tools from the client.

---

## 🚀 Core Features

### 1. Sequenced 5-Phase Web Construction Pipeline
When website tasks are detected, the orchestrator executes a strict sequence instead of raw parallel execution to prevent AI slop:
* **Phase 1: Initial Design Foundation**: Utilizes `open-design` and the `frontend-design` prompt guidelines to initialize CSS variables, HSL colors, layout grids, and typographic scales.
* **Phase 2: Component Assembly & Animations**: Integrates components using premium libraries (`shadcn`, `magicui`, `aceternity-ui`, etc.) and mandates animations (entrance, exit, hover, scroll-triggered, and ambient micro-animations) across all components.
* **Phase 3: Refinement & Validation**: Enhances the code structure using secondary layout tools and performs static syntax checks via `debug-skill`.
* **Phase 4: Final Premium Polish**: Employs `taste-skill` and `impeccable` at the end to adjust spacing, typography, and colors. Checks for styling constraints:
  - **No rainbow gradients on dark backgrounds** (uses bold/cohesive colors).
  - **No excessive glow effects** (prevents visual noise/clutter).
* **Phase 5: Visual Quality Check & Critique**: Launches `playwright-mcp` to capture screenshots and run visual sanity checks, performing a final self-critique pass to guarantee a premium look.

### 2. Integrated Design Knowledge Training
Pre-loaded with **74 top-tier design system guides** from the `awesome-design-md` repository (e.g., Stripe, Linear, Vercel, Apple). When a design task is received, the context is automatically retrieved from Graphify and injected into the execution pipeline, enabling the orchestrator to model its outputs after world-class design systems.

### 3. Graphify Memory Integration
Maintains session-scoped knowledge. Every completed task indexes its outcomes back into the graph, while new tasks begin by retrieving relevant context, past patterns, and developer preferences from Graphify.

---

## 🛠️ MCP Tools Exposed

Clients (IDE extension, AI agent, or custom UI) interface with the orchestrator using four primary MCP tools:

1. **`activate_agent`**: Activates a specialized agent configuration (e.g., `website_builder`, `motion_animation`, `coding`, `research`, `security`) and loads its specific capabilities.
2. **`execute_task`**: Executes complex multi-step workflows. Automatically resolves agent intents, fetches context from Graphify, runs the sequential pipeline, performs visual reviews, and index results.
3. **`delegate_subtask`**: Delegates specific sub-tasks to internal sub-agents.
4. **`get_status`**: Queries active orchestrator states, loaded skills, and Graphify tasks.

---

## 🚀 Installation & Setup

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+)
* [npm](https://www.npmjs.com/)

### 1. Install Dependencies
Clone the repository and install packages:
```bash
npm install
```

### 2. Build the Server
Compile the TypeScript code:
```bash
npm run build
```

### 3. Add to MCP Config
Add the server definition to your MCP client config (e.g. Claude Desktop Config or Cursor MCP config):

**Stdio Transport (Default)**:
```json
{
  "mcpServers": {
    "universal-orchestrator": {
      "command": "node",
      "args": [
        "c:/Users/Shriyans/Desktop/MCP/universal-mcp/dist/index.js"
      ]
    }
  }
}
```

**SSE Transport**:
To start the server using Server-Sent Events (SSE):
```bash
npm run start -- --sse
```
And add it to your configuration using HTTP:
```json
{
  "mcpServers": {
    "universal-orchestrator-sse": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/client",
        "http://localhost:3000/sse"
      ]
    }
  }
}
```

---

## 📂 Project Structure

```
universal-mcp/
├── src/
│   ├── config/          # Agent capabilities configuration (agents.ts)
│   ├── loaders/         # Dynamic skill loader (skillsLoader.ts)
│   ├── memory/          # Graphify memory manager (graphify.ts)
│   ├── orchestration/   # OhMyPI framework delegation (ohmypi.ts)
│   ├── prompts/         # Core system and frontend prompt guidelines
│   └── index.ts         # Server entry point and MCP tool handlers
├── knowledge/           # awesome-design-md training data
├── SKILL.md             # Orchestrator orchestration guide (antigravity skill)
└── tsconfig.json        # TypeScript configuration
```
