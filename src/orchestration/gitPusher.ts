/**
 * Git Pusher
 *
 * Handles automated git add → commit → push after task completion.
 * Uses the local git binary. Supports:
 *  - Smart commit messages (task-aware)
 *  - Branch detection (pushes to current branch)
 *  - Dry-run mode for safety preview
 *  - Conflict detection
 */

import { execSync, ExecSyncOptionsWithBufferEncoding } from "child_process";
import * as path from "path";

export interface GitPushOptions {
  workingDir: string;
  commitMessage: string;
  dryRun?: boolean;
  branch?: string; // defaults to current branch
}

export interface GitPushResult {
  success: boolean;
  commitHash?: string;
  branch: string;
  remote: string;
  filesChanged: string[];
  output: string;
  error?: string;
}

/**
 * Stages all changes, commits with the given message, and pushes to origin.
 */
export async function gitAddCommitPush(options: GitPushOptions): Promise<GitPushResult> {
  const { workingDir, commitMessage, dryRun = false } = options;

  const execOptions: ExecSyncOptionsWithBufferEncoding = {
    cwd: workingDir,
    encoding: "buffer",
    timeout: 30000
  };

  const run = (cmd: string): string => {
    try {
      const buf = execSync(cmd, execOptions);
      return buf.toString("utf8").trim();
    } catch (err: any) {
      const msg = err.stdout?.toString("utf8") || err.message;
      throw new Error(`Command failed: ${cmd}\n${msg}`);
    }
  };

  try {
    // 1. Detect current branch
    const branch = options.branch || run("git rev-parse --abbrev-ref HEAD");

    // 2. Detect remote
    const remote = run("git remote get-url origin");

    // 3. Get list of changed files
    const statusOutput = run("git status --short");
    const filesChanged = statusOutput
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[MADRCU?! ]{1,2} /, ""));

    if (filesChanged.length === 0) {
      return {
        success: true,
        branch,
        remote,
        filesChanged: [],
        output: "Nothing to commit — working tree is clean."
      };
    }

    // 4. Dry run: show what would happen
    if (dryRun) {
      return {
        success: true,
        branch,
        remote,
        filesChanged,
        output: [
          `DRY RUN — no changes made`,
          `Would commit ${filesChanged.length} file(s) to branch '${branch}' on remote '${remote}'`,
          `Commit message: "${commitMessage}"`,
          `Files:`,
          ...filesChanged.map(f => `  - ${f}`)
        ].join("\n")
      };
    }

    // 5. Stage all changes (excluding skills/ and node_modules/ to avoid massive commits)
    run("git add -A -- . ':!skills/' ':!node_modules/'");

    // 6. Check if there's actually anything staged
    const stagedOutput = run("git diff --cached --name-only");
    if (!stagedOutput) {
      return {
        success: true,
        branch,
        remote,
        filesChanged: [],
        output: "Nothing staged after exclusions. If skills/ files changed intentionally, commit them manually."
      };
    }

    const stagedFiles = stagedOutput.split("\n").filter(f => f.trim());

    // 7. Commit
    const sanitizedMessage = commitMessage.replace(/"/g, "'");
    run(`git commit -m "${sanitizedMessage}"`);

    // 8. Get commit hash
    const commitHash = run("git rev-parse HEAD").slice(0, 8);

    // 9. Push
    run(`git push origin ${branch}`);

    return {
      success: true,
      commitHash,
      branch,
      remote,
      filesChanged: stagedFiles,
      output: [
        `✅ Successfully pushed to GitHub`,
        `Branch: ${branch}`,
        `Remote: ${remote}`,
        `Commit: ${commitHash}`,
        `Files committed (${stagedFiles.length}):`,
        ...stagedFiles.map(f => `  ✓ ${f}`)
      ].join("\n")
    };
  } catch (err: any) {
    // Detect common issues
    let errorMsg = err.message || String(err);
    let guidance = "";

    if (errorMsg.includes("nothing to commit")) {
      return {
        success: true,
        branch: options.branch || "main",
        remote: "origin",
        filesChanged: [],
        output: "Nothing to commit — working tree is already clean."
      };
    }
    if (errorMsg.includes("rejected") || errorMsg.includes("non-fast-forward")) {
      guidance = "\n💡 Tip: Run 'git pull --rebase origin <branch>' first to resolve diverged history.";
    }
    if (errorMsg.includes("Authentication failed") || errorMsg.includes("could not read Username")) {
      guidance = "\n💡 Tip: Set up a GitHub Personal Access Token or SSH key for authentication.";
    }
    if (errorMsg.includes("does not have a commit checked out") || errorMsg.includes("not a git repository")) {
      guidance = "\n💡 Tip: Run 'git init && git remote add origin <url>' in the project root first.";
    }

    return {
      success: false,
      branch: options.branch || "unknown",
      remote: "origin",
      filesChanged: [],
      output: `❌ Git push failed: ${errorMsg}${guidance}`,
      error: errorMsg
    };
  }
}

/**
 * Generates a smart commit message based on the task type and description.
 */
export function buildCommitMessage(taskDescription: string, agentType: string, filesChanged: string[]): string {
  const prefix = getConventionalPrefix(agentType);
  const scope = guessScope(filesChanged);
  const summary = taskDescription.split(/[.\n]/)[0].trim().slice(0, 72);

  // Conventional Commits format: type(scope): summary
  const header = scope
    ? `${prefix}(${scope}): ${summary}`
    : `${prefix}: ${summary}`;

  const body = filesChanged.length > 0
    ? `\n\nChanged files:\n${filesChanged.slice(0, 10).map(f => `- ${f}`).join("\n")}${filesChanged.length > 10 ? `\n  ... and ${filesChanged.length - 10} more` : ""}`
    : "";

  return header + body;
}

function getConventionalPrefix(agentType: string): string {
  const prefixMap: Record<string, string> = {
    website_builder: "feat",
    motion_animation: "feat",
    coding: "feat",
    research: "docs",
    debugging: "fix",
    refactor: "refactor",
    default: "chore"
  };
  return prefixMap[agentType] || prefixMap.default;
}

function guessScope(files: string[]): string {
  if (files.length === 0) return "";
  // Find common directory prefix
  const dirs = files.map(f => f.split("/")[0]).filter(d => d && !d.includes("."));
  const uniqueDirs = [...new Set(dirs)];
  if (uniqueDirs.length === 1) return uniqueDirs[0];
  if (uniqueDirs.length <= 3) return uniqueDirs.join(",");
  return ""; // too diverse to scope
}
