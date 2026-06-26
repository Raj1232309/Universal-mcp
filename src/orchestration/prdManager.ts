/**
 * PRD / Implementation Plan Manager
 *
 * Before doing any significant work, the orchestrator should:
 *  1. Generate a structured PRD (Product Requirements Document) or
 *     Implementation Plan based on the user's request.
 *  2. Present it to the user for confirmation.
 *  3. Only proceed once the user confirms or requests changes.
 *
 * This prevents wasted tokens on work the user didn't actually want.
 */

export interface PrdSection {
  title: string;
  content: string;
}

export interface Prd {
  id: string;
  title: string;
  taskDescription: string;
  agentType: string;
  createdAt: number;
  status: "pending_review" | "confirmed" | "rejected" | "revised";
  sections: PrdSection[];
  userFeedback?: string;
}

// In-memory PRD store (keyed by PRD ID)
const prdStore = new Map<string, Prd>();

/**
 * Generates a structured PRD / implementation plan from a task description.
 * The plan is tailored by agent type (website_builder, coding, research, etc.)
 */
export function generatePrd(taskDescription: string, agentType: string): Prd {
  const id = `prd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const sections: PrdSection[] = buildSections(taskDescription, agentType);

  const prd: Prd = {
    id,
    title: deriveTitle(taskDescription),
    taskDescription,
    agentType,
    createdAt: Date.now(),
    status: "pending_review",
    sections
  };

  prdStore.set(id, prd);
  return prd;
}

/**
 * Marks a PRD as confirmed by the user (optionally with feedback).
 */
export function confirmPrd(prdId: string, feedback?: string): Prd | null {
  const prd = prdStore.get(prdId);
  if (!prd) return null;
  prd.status = "confirmed";
  if (feedback) prd.userFeedback = feedback;
  prdStore.set(prdId, prd);
  return prd;
}

/**
 * Marks a PRD as rejected or needing revision, attaches user feedback.
 */
export function rejectPrd(prdId: string, feedback: string): Prd | null {
  const prd = prdStore.get(prdId);
  if (!prd) return null;
  prd.status = "rejected";
  prd.userFeedback = feedback;
  prdStore.set(prdId, prd);
  return prd;
}

/**
 * Revises an existing PRD with updated details, resets to pending_review.
 */
export function revisePrd(prdId: string, updatedTaskDescription: string): Prd | null {
  const prd = prdStore.get(prdId);
  if (!prd) return null;
  prd.taskDescription = updatedTaskDescription;
  prd.sections = buildSections(updatedTaskDescription, prd.agentType);
  prd.status = "pending_review";
  prd.userFeedback = undefined;
  prdStore.set(prdId, prd);
  return prd;
}

/**
 * Retrieves a PRD by ID.
 */
export function getPrd(prdId: string): Prd | null {
  return prdStore.get(prdId) || null;
}

/**
 * Checks whether a PRD has been confirmed by the user.
 */
export function isPrdConfirmed(prdId: string): boolean {
  const prd = prdStore.get(prdId);
  return prd?.status === "confirmed";
}

/**
 * Formats a PRD into a human-readable markdown string for user review.
 */
export function formatPrdForReview(prd: Prd): string {
  const lines: string[] = [
    `# 📋 Implementation Plan — ${prd.title}`,
    ``,
    `> **PRD ID**: \`${prd.id}\``,
    `> **Agent**: ${prd.agentType}`,
    `> **Status**: ${prd.status === "pending_review" ? "⏳ Awaiting your confirmation" : prd.status}`,
    ``,
    `---`,
    ``
  ];

  for (const section of prd.sections) {
    lines.push(`## ${section.title}`);
    lines.push(section.content);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`**To proceed**: Call \`confirm_prd\` with prdId \`"${prd.id}"\``);
  lines.push(`**To request changes**: Call \`confirm_prd\` with prdId \`"${prd.id}"\` and a \`feedback\` string describing changes you want.`);
  lines.push(`**To reject**: Call \`reject_prd\` with prdId \`"${prd.id}"\` and your feedback.`);

  return lines.join("\n");
}

// -------------------------------------------------------
// Internal helpers
// -------------------------------------------------------

function deriveTitle(taskDescription: string): string {
  // Take first sentence or first 60 chars, whichever is shorter
  const firstSentence = taskDescription.split(/[.\n]/)[0].trim();
  return firstSentence.length > 80
    ? firstSentence.slice(0, 77) + "..."
    : firstSentence;
}

function buildSections(task: string, agentType: string): PrdSection[] {
  const common: PrdSection[] = [
    {
      title: "🎯 Objective",
      content: `> ${task}\n\nThis plan outlines what will be built, how, and in what order.`
    },
    {
      title: "📌 Scope",
      content: buildScope(task, agentType)
    },
    {
      title: "⚙️ Execution Phases",
      content: buildPhases(agentType)
    },
    {
      title: "🧪 Verification Strategy",
      content: buildVerification(agentType)
    },
    {
      title: "📦 Deliverables",
      content: buildDeliverables(agentType)
    },
    {
      title: "⚠️ Constraints & Assumptions",
      content: buildConstraints(agentType)
    },
    {
      title: "❓ Open Questions",
      content: buildOpenQuestions(task, agentType)
    }
  ];

  return common;
}

function buildScope(task: string, agentType: string): string {
  const scopeMap: Record<string, string> = {
    website_builder: `**In scope:**\n- Full HTML/React page(s) with React Bits components\n- Animated backgrounds, text animations, interactive components\n- Playwright visual verification\n- Debug pass via debug-skill\n- Git commit and push\n\n**Out of scope (unless stated):**\n- Backend/API development\n- Database schema\n- Authentication systems`,
    motion_animation: `**In scope:**\n- GSAP / CSS / Three.js animations\n- Timing, easing, and sequencing\n- Playwright screenshot verification\n\n**Out of scope:**\n- Backend integration`,
    coding: `**In scope:**\n- Implementation of the described feature/fix\n- Unit tests where applicable\n- Debugging pass via debug-skill\n- Git commit and push\n\n**Out of scope:**\n- UI/visual design`,
    research: `**In scope:**\n- Web research via Firecrawl\n- Source validation\n- Summarization and structured output\n\n**Out of scope:**\n- Implementation of findings`,
    default: `**In scope:**\n- Implementation of the described task\n- Verification and debugging\n\n**Out of scope:**\n- Items not mentioned in the task description`
  };

  return scopeMap[agentType] || scopeMap.default;
}

function buildPhases(agentType: string): string {
  const phaseMap: Record<string, string> = {
    website_builder: [
      "1. **PRD Confirmation** — Present this plan, await user approval ✅",
      "2. **Design Foundation** — Initialize design system using open-design + design_agent prompt",
      "3. **React Bits Components** — Retrieve source code for relevant components (react_bits_get_source)",
      "4. **Build** — Construct the HTML/React page with all components, animations, and content",
      "5. **Debug Pass** — Run debug-skill to catch runtime errors, logic bugs, and CSS conflicts",
      "6. **Playwright Verification** — Screenshot the output; check layout, colors, animations, mobile breakpoints",
      "7. **Polish** — Apply impeccable + taste-skill feedback; fix any issues from verification",
      "8. **Git Push** — Commit all changes with a descriptive message and push to GitHub",
    ].join("\n"),
    coding: [
      "1. **PRD Confirmation** — Present this plan, await user approval ✅",
      "2. **Architecture Design** — Plan the code structure",
      "3. **Implementation** — Write the code",
      "4. **Debug Pass** — Run debug-skill to verify correctness",
      "5. **Testing** — Run tests if applicable",
      "6. **Git Push** — Commit and push to GitHub",
    ].join("\n"),
    default: [
      "1. **PRD Confirmation** — Present this plan, await user approval ✅",
      "2. **Execution** — Carry out the task",
      "3. **Verification** — Check output quality",
      "4. **Git Push** — Commit and push results",
    ].join("\n")
  };

  return phaseMap[agentType] || phaseMap.default;
}

function buildVerification(agentType: string): string {
  if (agentType === "website_builder") {
    return [
      "- **Debug-skill**: Scans for JS runtime errors, CSS conflicts, and broken imports",
      "- **Playwright**: Takes screenshots at desktop (1440px) and mobile (375px), checks:",
      "  - ✓ No layout overflow or hidden content",
      "  - ✓ Dark backgrounds free of rainbow gradients",
      "  - ✓ Glow effects minimal",
      "  - ✓ React Bits components render (canvas, animated classes)",
      "  - ✓ Animations trigger on scroll",
      "  - ✓ No Lorem ipsum placeholder text",
      "- **Self-critique**: Final review of output quality before delivery"
    ].join("\n");
  }
  if (agentType === "coding") {
    return [
      "- **Debug-skill**: Full static + runtime analysis",
      "- **Unit tests**: Run existing test suite",
      "- **Logic validation**: Manual review of edge cases"
    ].join("\n");
  }
  return "- Light review of output quality\n- Source validation for research tasks";
}

function buildDeliverables(agentType: string): string {
  const map: Record<string, string> = {
    website_builder: "- Complete HTML/React file(s)\n- All React Bits component files copied to project\n- Playwright screenshot report\n- Debug report\n- Git commit pushed to GitHub",
    coding: "- Working code implementation\n- Debug report\n- Git commit pushed to GitHub",
    research: "- Structured research report (Markdown)\n- Source citations\n- Key findings summary",
    default: "- Task output\n- Verification report\n- Git commit"
  };
  return map[agentType] || map.default;
}

function buildConstraints(agentType: string): string {
  const base = [
    "- Sub-agents run with token budgets — only activated when strictly needed",
    "- Parallel execution used wherever tasks are independent",
    "- No redundant tool calls for the same capability",
    "- Memory (Graphify) consulted before planning to avoid re-doing prior work"
  ];
  if (agentType === "website_builder") {
    base.push("- Dark mode: NO rainbow gradients, NO excessive glow");
    base.push("- React Bits components MUST be used for all UI elements");
    base.push("- Animations required on all components (entrance, hover, scroll-triggered)");
  }
  return base.join("\n");
}

function buildOpenQuestions(task: string, agentType: string): string {
  if (agentType === "website_builder") {
    return [
      "These questions can be answered via `confirm_prd` feedback or left as defaults:",
      "",
      "- **Color mode**: Dark or light background? (Default: dark, premium palette)",
      "- **Framework**: Vanilla HTML+CSS or React+Babel? (Default: React+Babel inline)",
      "- **Breakpoints**: Mobile-first or desktop-first? (Default: desktop-first, mobile-responsive)",
      "- **Typography**: Any preferred typefaces? (Default: curated pair from Google Fonts)",
      "- **Content**: Is real content provided or should it be generated? (Default: generated)",
    ].join("\n");
  }
  if (agentType === "coding") {
    return [
      "- **Language/runtime**: Any specific constraints?",
      "- **Testing framework**: Preferred test runner?",
      "- **PR or direct push**: Should changes go to a branch or directly to main?",
    ].join("\n");
  }
  return "_None at this time. Confirm to proceed or add feedback._";
}
