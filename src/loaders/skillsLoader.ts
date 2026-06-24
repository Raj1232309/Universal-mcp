import { exec } from "child_process";
import { promisify } from "util";
import { AGENT_CONFIG } from "../config/agents.js";

const execAsync = promisify(exec);

export interface LoadedSkill {
  name: string;
  description: string;
  inputSchema: any;
  execute: (args: any) => Promise<any>;
}

/**
 * Dynamically loads skills for a given agent intent.
 * In a real-world scenario, this would execute `npx skills add` commands,
 * parse the resulting MCP schemas, and map them to executable functions.
 */
export async function loadSkillsForAgent(intent: string): Promise<LoadedSkill[]> {
  const intentsToLoad = [intent];

  // Broad Loading Policy: If a website is mentioned/activated, load all UI, front-end, motion, and coding skills.
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
      
      // Create a mock skill representing the source
      const skillName = skillSource.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "_") || "unknown_skill";
      
      loadedSkills.push({
        name: `execute_${skillName}`,
        description: `Executes a task using the specialized skill from: ${skillSource}`,
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
          return `Simulated execution of task '${args.taskDescription}' using ${skillSource}`;
        }
      });
    }
  }

  return loadedSkills;
}
