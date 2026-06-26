import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CONFIG } from "../config/agents.js";

const execAsync = promisify(exec);

export interface LoadedSkill {
  name: string;
  description: string;
  inputSchema: any;
  execute: (args: any) => Promise<any>;
}

export interface LoadedMcpServer {
  folderName: string;
  entryPoint: string;
  args: string[];
  tools: any[];
}

function getLocalSkillPath(skillSource: string): string | null {
  const cleanSource = skillSource.trim();
  let folderName = "";

  if (cleanSource.startsWith("http://") || cleanSource.startsWith("https://")) {
    folderName = cleanSource.split("/").pop()?.replace(/\.git$/, "") || "";
  } else if (cleanSource.includes("skills add") || cleanSource.includes("skills@latest add")) {
    const gitMatch = cleanSource.match(/https:\/\/github\.com\/[^\s]+/);
    if (gitMatch) {
      const url = gitMatch[0].replace(/--skill.*/, "").trim();
      folderName = url.split("/").pop()?.replace(/\.git$/, "") || "";
    } else {
      const parts = cleanSource.split(" ");
      const addIndex = parts.findIndex((p) => p === "add");
      if (addIndex !== -1 && parts[addIndex + 1]) {
        const repoPath = parts[addIndex + 1];
        if (repoPath.includes("/") && !repoPath.startsWith("http")) {
          folderName = repoPath.replace("/", "-");
        }
      }
    }
  } else if (cleanSource.includes("skillfish add")) {
    const parts = cleanSource.split(" ");
    const addIndex = parts.findIndex((p) => p === "add");
    if (addIndex !== -1 && parts[addIndex + 1]) {
      const repoPath = parts[addIndex + 1];
      if (repoPath.includes("/")) {
        folderName = repoPath.replace("/", "-");
      }
    }
  } else if (cleanSource.includes("/") && !cleanSource.includes(" ") && !cleanSource.includes("@")) {
    folderName = cleanSource.replace("/", "-");
  }

  if (!folderName) return null;
  return path.resolve(process.cwd(), "skills", folderName);
}

function getEntryPoint(serverPath: string): string | null {
  let entryPoint = "";
  const packageJsonPath = path.join(serverPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      if (pkg.main && fs.existsSync(path.join(serverPath, pkg.main))) {
        entryPoint = path.join(serverPath, pkg.main);
      } else if (pkg.bin) {
        const binVal = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
        if (typeof binVal === "string" && fs.existsSync(path.join(serverPath, binVal))) {
          entryPoint = path.join(serverPath, binVal);
        }
      }
    } catch (e) {}
  }
  
  if (!entryPoint) {
    const fallbacks = ["dist/index.js", "build/index.js", "index.js"];
    for (const f of fallbacks) {
      const p = path.join(serverPath, f);
      if (fs.existsSync(p)) {
        entryPoint = p;
        break;
      }
    }
  }

  return entryPoint || null;
}

const nodeBin = "C:\\Users\\Shriyans\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin";
const nodeExe = path.join(nodeBin, "node.exe");

function getCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key in process.env) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  env.PATH = env.PATH ? `${nodeBin};${env.PATH}` : nodeBin;
  return env;
}

async function listToolsForServer(entryPoint: string, serverArgs: string[] = []): Promise<any[]> {
  const env = getCleanEnv();

  const transport = new StdioClientTransport({
    command: nodeExe,
    args: [entryPoint, ...serverArgs],
    env: env
  });

  const client = new Client({
    name: "Discovery Client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    await client.close();
    return result.tools || [];
  } catch (error) {
    console.error(`[Orchestrator] Failed to list tools for ${entryPoint} with args ${JSON.stringify(serverArgs)}:`, error);
    try { await client.close(); } catch (_) {}
    return [];
  }
}

export async function callToolOnServer(entryPoint: string, serverArgs: string[], toolName: string, args: any): Promise<any> {
  const env = getCleanEnv();

  const transport = new StdioClientTransport({
    command: nodeExe,
    args: [entryPoint, ...serverArgs],
    env: env
  });

  const client = new Client({
    name: "Execution Client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });
    await client.close();
    return result;
  } catch (error: any) {
    console.error(`[Orchestrator] Failed to call tool ${toolName} on ${entryPoint} with args ${JSON.stringify(serverArgs)}:`, error);
    try { await client.close(); } catch (_) {}
    throw error;
  }
}

function getServerArgs(mcpDir: string): string[] {
  const packageJsonPath = path.join(mcpDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      if (pkg.name === "@open-design/daemon") {
        return ["mcp"];
      }
    } catch (e) {}
  }
  return [];
}

function findMcpServersInDir(dir: string, found: string[] = []): string[] {
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const hasMcp = pkg.dependencies?.["@modelcontextprotocol/sdk"] || pkg.devDependencies?.["@modelcontextprotocol/sdk"];
      if (hasMcp) {
        found.push(dir);
        return found; // Found MCP server, no need to look deeper in this directory branch
      }
    } catch (e) {}
  }

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file === "node_modules" || file === ".git" || file === "dist" || file === "build" || file === "out") {
        continue;
      }
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        findMcpServersInDir(fullPath, found);
      }
    }
  } catch (e) {}

  return found;
}

export async function loadMcpServersForAgent(intent: string): Promise<LoadedMcpServer[]> {
  const intentsToLoad = [intent];
  if (intent === "website_builder") {
    intentsToLoad.push("motion_animation", "coding");
  }

  const servers: LoadedMcpServer[] = [];
  const processedSources = new Set<string>();

  for (const currentIntent of intentsToLoad) {
    const config = AGENT_CONFIG[currentIntent];
    if (!config) continue;

    for (const skillSource of config.skills) {
      if (processedSources.has(skillSource)) continue;
      processedSources.add(skillSource);

      const localPath = getLocalSkillPath(skillSource);
      if (!localPath || !fs.existsSync(localPath)) continue;

      const mcpDirs = findMcpServersInDir(localPath);
      for (const mcpDir of mcpDirs) {
        const entryPoint = getEntryPoint(mcpDir);
        if (entryPoint) {
          const folderName = path.basename(mcpDir);
          const serverArgs = getServerArgs(mcpDir);
          try {
            const tools = await listToolsForServer(entryPoint, serverArgs);
            if (tools && tools.length > 0) {
              servers.push({ folderName, entryPoint, args: serverArgs, tools });
            }
          } catch (err: any) {
            console.error(`[Orchestrator] Failed to list tools for ${folderName}:`, err.message);
          }
        }
      }
    }
  }

  return servers;
}

export async function loadSkillsForAgent(intent: string): Promise<LoadedSkill[]> {
  const intentsToLoad = [intent];
  if (intent === "website_builder") {
    intentsToLoad.push("motion_animation", "coding");
  }

  const loadedSkills: LoadedSkill[] = [];
  const processedSources = new Set<string>();

  for (const currentIntent of intentsToLoad) {
    const config = AGENT_CONFIG[currentIntent];
    if (!config) continue;

    for (const skillSource of config.skills) {
      if (processedSources.has(skillSource)) continue;
      processedSources.add(skillSource);
      
      const skillName = skillSource.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "_") || "unknown_skill";
      const localPath = getLocalSkillPath(skillSource);

      let description = `Executes a task using the specialized skill from: ${skillSource}`;
      let loadedFromFile = false;

      if (localPath && fs.existsSync(localPath)) {
        const skillMdPath = path.join(localPath, "SKILL.md");
        const readmeMdPath = path.join(localPath, "README.md");
        if (fs.existsSync(skillMdPath)) {
          description = fs.readFileSync(skillMdPath, "utf-8");
          loadedFromFile = true;
        } else if (fs.existsSync(readmeMdPath)) {
          description = fs.readFileSync(readmeMdPath, "utf-8");
          loadedFromFile = true;
        }
      }

      loadedSkills.push({
        name: `execute_${skillName}`,
        description: description,
        inputSchema: {
          type: "object",
          properties: {
            taskDescription: {
              type: "string",
              description: "The description of the task to execute with this skill."
            }
          },
          required: ["taskDescription"]
        },
        execute: async (args: any) => {
          if (localPath && fs.existsSync(localPath)) {
            return `Successfully loaded and executed local skill '${skillName}' (Path: ${localPath}). Instructions/guidelines: \n\n${description}`;
          }
          return `Simulated execution of task '${args.taskDescription}' using ${skillSource}`;
        }
      });
    }
  }

  return loadedSkills;
}
