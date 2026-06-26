import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_CONFIG } from "../src/config/agents.js";

const execAsync = promisify(exec);

// Determine directory names
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

function parseSkillSource(source: string): { url: string; folderName: string } | null {
  const cleanSource = source.trim();

  // 1. Direct Git URLs
  if (cleanSource.startsWith("http://") || cleanSource.startsWith("https://")) {
    const url = cleanSource;
    let folderName = url.split("/").pop()?.replace(/\.git$/, "") || "unknown";
    return { url, folderName };
  }

  // 2. npx commands with Git URLs
  if (cleanSource.includes("skills add") || cleanSource.includes("skills@latest add")) {
    const gitMatch = cleanSource.match(/https:\/\/github\.com\/[^\s]+/);
    if (gitMatch) {
      const url = gitMatch[0].replace(/--skill.*/, "").trim();
      let folderName = url.split("/").pop()?.replace(/\.git$/, "") || "unknown";
      return { url, folderName };
    }

    // Shorthand inside npx skills add, e.g., firecrawl/skills
    const parts = cleanSource.split(" ");
    const addIndex = parts.findIndex((p) => p === "add");
    if (addIndex !== -1 && parts[addIndex + 1]) {
      const repoPath = parts[addIndex + 1];
      if (repoPath.includes("/") && !repoPath.startsWith("http")) {
        const url = `https://github.com/${repoPath}.git`;
        const folderName = repoPath.replace("/", "-");
        return { url, folderName };
      }
    }
  }

  // 3. npx skillfish add secondsky/claude-skills aceternity-ui
  if (cleanSource.includes("skillfish add")) {
    const parts = cleanSource.split(" ");
    const addIndex = parts.findIndex((p) => p === "add");
    if (addIndex !== -1 && parts[addIndex + 1]) {
      const repoPath = parts[addIndex + 1];
      if (repoPath.includes("/")) {
        const url = `https://github.com/${repoPath}.git`;
        const folderName = repoPath.replace("/", "-");
        return { url, folderName };
      }
    }
  }

  // 4. Raw owner/repo shorthand like googlecloudplatform/skills
  if (cleanSource.includes("/") && !cleanSource.includes(" ") && !cleanSource.includes("@")) {
    const url = `https://github.com/${cleanSource}.git`;
    const folderName = cleanSource.replace("/", "-");
    return { url, folderName };
  }

  return null;
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

async function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const nodeBin = "C:\\Users\\Shriyans\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin";
    const env = { ...process.env };
    env.PATH = env.PATH ? `${nodeBin};${env.PATH}` : nodeBin;
    return await execAsync(command, { cwd, env });
  } catch (error: any) {
    return { stdout: error.stdout || "", stderr: error.stderr || error.message };
  }
}

async function main() {
  console.log(`Starting to download skills and MCP servers...`);
  console.log(`Project root: ${PROJECT_ROOT}`);
  console.log(`Skills destination: ${SKILLS_DIR}`);

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    console.log(`Created skills/ directory.`);
  }

  // Gather all unique skills from AGENT_CONFIG
  const uniqueSources = new Set<string>();
  for (const agentName of Object.keys(AGENT_CONFIG)) {
    const config = AGENT_CONFIG[agentName];
    if (config && config.skills) {
      for (const skillSource of config.skills) {
        uniqueSources.add(skillSource);
      }
    }
  }

  console.log(`Found ${uniqueSources.size} total skill configurations.`);

  const targets: { url: string; folderName: string; original: string }[] = [];
  const skipped: string[] = [];

  for (const source of uniqueSources) {
    const parsed = parseSkillSource(source);
    if (parsed) {
      // Prevent duplicates in folderNames
      if (!targets.some((t) => t.folderName === parsed.folderName)) {
        targets.push({ ...parsed, original: source });
      }
    } else {
      skipped.push(source);
    }
  }

  console.log(`Resolved ${targets.length} unique git repositories to clone.`);
  if (skipped.length > 0) {
    console.log(`Skipped/Non-Git sources (${skipped.length}):`);
    skipped.forEach((s) => console.log(` - ${s}`));
  }

  for (const target of targets) {
    const targetPath = path.join(SKILLS_DIR, target.folderName);
    console.log(`\n--------------------------------------------------`);
    console.log(`Processing: ${target.folderName}`);
    console.log(`Repository: ${target.url}`);
    console.log(`Path: ${targetPath}`);

    if (fs.existsSync(targetPath)) {
      console.log(`Folder already exists. Performing git pull to update...`);
      const { stdout, stderr } = await runCommand(`git pull`, targetPath);
      if (stderr && !stderr.includes("Already up-to-date") && !stderr.includes("Already up to date")) {
        console.warn(`[Warning] git pull returned warning/error: ${stderr.trim()}`);
      } else {
        console.log(`Updated successfully.`);
      }
    } else {
      console.log(`Cloning repository (depth 1)...`);
      const { stdout, stderr } = await runCommand(`git clone --depth 1 "${target.url}" "${target.folderName}"`, SKILLS_DIR);
      if (stderr && !stderr.includes("Cloning into")) {
        console.error(`[Error] Failed to clone ${target.url}: ${stderr.trim()}`);
        continue;
      }
      console.log(`Cloned successfully.`);
    }

    // Recursively find all MCP server folders inside the repository
    const mcpDirs = findMcpServersInDir(targetPath);
    if (mcpDirs.length > 0) {
      const isMonorepo = fs.existsSync(path.join(targetPath, "pnpm-workspace.yaml")) || fs.existsSync(path.join(targetPath, "lerna.json"));
      if (isMonorepo) {
        console.log(`Found monorepo workspace in ${target.folderName}. Installing dependencies at root...`);
        const installRes = await runCommand(`pnpm install`, targetPath);
        if (installRes.stderr && installRes.stderr.includes("ERR!")) {
          console.error(`[Error] pnpm install failed: ${installRes.stderr.trim()}`);
        } else {
          console.log(`Workspace dependencies installed.`);
        }
        for (const mcpDir of mcpDirs) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(mcpDir, "package.json"), "utf-8"));
            if (pkg.scripts && pkg.scripts.build) {
              console.log(`Building workspace sub-project ${pkg.name}...`);
              const buildRes = await runCommand(`pnpm --filter ${pkg.name} build`, targetPath);
              if (buildRes.stderr && buildRes.stderr.includes("ERR!")) {
                console.error(`[Error] Build failed for ${pkg.name}: ${buildRes.stderr.trim()}`);
              } else {
                console.log(`Build completed for ${pkg.name}.`);
              }
            }
          } catch (e) {}
        }
      } else {
        // Run install and build inside each sub-project individually
        for (const mcpDir of mcpDirs) {
          console.log(`Found MCP server folder in: ${mcpDir}. Installing dependencies...`);
          const installRes = await runCommand(`pnpm install`, mcpDir);
          if (installRes.stderr && installRes.stderr.includes("ERR!")) {
            console.error(`[Error] pnpm install failed: ${installRes.stderr.trim()}`);
          } else {
            console.log(`Dependencies installed.`);
          }

          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(mcpDir, "package.json"), "utf-8"));
            if (pkg.scripts && pkg.scripts.build) {
              console.log(`Found build script. Compiling project in ${mcpDir}...`);
              const buildRes = await runCommand(`pnpm run build`, mcpDir);
              if (buildRes.stderr && buildRes.stderr.includes("ERR!")) {
                console.error(`[Error] Build failed: ${buildRes.stderr.trim()}`);
              } else {
                console.log(`Build completed.`);
              }
            }
          } catch (e) {}
        }
      }
    } else {
      console.log(`Not an MCP server repository (no MCP SDK found recursively). Skipping install/build.`);
    }
  }

  console.log(`\n==================================================`);
  console.log(`All skill downloads and setup completed.`);
  console.log(`==================================================`);
}

main().catch((err) => {
  console.error(`Fatal error in download script:`, err);
  process.exit(1);
});
