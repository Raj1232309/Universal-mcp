export interface AgentConfig {
  skills: string[];
}

export const AGENT_CONFIG: Record<string, AgentConfig> = {
  website_builder: {
    skills: [
      "npx skills add https://github.com/Dammyjay93/interface-design",
      "npx skills add https://github.com/Leonxlnx/taste-skill",
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
      "npx skills add https://github.com/anthropics/skills --skill canvas-design",
      "npx skills add https://github.com/0xdesign/design-plugin",
      "npx skills add https://github.com/pbakaus/impeccable",
      "npx skills add https://github.com/emilkowalski/design-eng",
      "npx skills add https://github.com/ckm/ui-ux-pro-max",
      "npx skillfish add secondsky/claude-skills aceternity-ui",
      "https://github.com/Ashutoshx7/VengenceUI.git",
      "https://github.com/imskyleen/animate-ui.git",
      "https://github.com/serafimcloud/21st.git",
      "npx shadcn@latest mcp init --client vscode"
    ]
  },
  motion_animation: {
    skills: [
      "npx skills add https://github.com/greensock/gsap-skills.git --all",
      "https://github.com/raphaelsalaja/skill", // Morphing Icons
      "https://github.com/raphaelsalaja/skill", // 12 Principles
      "https://github.com/cloudai-x/threejs-skills",
      "npx motion-ai"
    ]
  },
  video: {
    skills: [
      "npx create-video@latest",
      "npx skills add heygen-com/hyperframes",
      "https://github.com/doany-ai/skills",
      "https://github.com/remotion-dev/skills"
    ]
  },
  android: {
    skills: [
      "npx skills add https://github.com/android/skills.git --all"
    ]
  },
  research: {
    skills: [
      "npx skills add firecrawl/skills --all"
    ]
  },
  security: {
    skills: [
      "https://github.com/gadievron/raptor.git",
      "https://github.com/deonmenezes/mantishack.git"
      // Includes: code-understanding, exploitability-validation, etc.
    ]
  },
  coding: {
    skills: [
      "npx skills@latest add mattpocock/skills --all"
    ]
  },
  data_engineering: {
    skills: [
      "googlecloudplatform/skills"
    ]
  }
};
