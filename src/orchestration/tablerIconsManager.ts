import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const TABLER_ICONS_DIR = path.resolve(process.cwd(), "skills", "tabler-icons", "icons");
const TABLER_TAGS_FILE = path.resolve(process.cwd(), "skills", "tabler-icons", "tags.json");

export const tablerIconsSearchSchema = z.object({
  query: z.string().describe("The search term (e.g., 'user', 'arrow', 'home').")
});

export const tablerIconsGetSchema = z.object({
  name: z.string().describe("The exact name of the icon (e.g., 'user', 'arrow-right').")
});

/**
 * Search Tabler Icons by filename
 */
export async function searchTablerIcons(query: string): Promise<string> {
  const q = query.toLowerCase().trim();
  if (!fs.existsSync(TABLER_ICONS_DIR)) {
    return "Error: Tabler Icons directory not found. Ensure the submodule is loaded.";
  }

  const allFiles = fs.readdirSync(TABLER_ICONS_DIR).filter(f => f.endsWith(".svg"));
  const matches = allFiles.filter(f => f.toLowerCase().includes(q));

  if (matches.length === 0) {
    return `No icons found matching "${query}". Try a simpler term.`;
  }

  const iconNames = matches.map(f => f.replace(".svg", ""));
  
  // Return at most 50 to avoid huge context usage
  const display = iconNames.slice(0, 50);
  let res = `Found ${matches.length} matching icons for "${query}":\n\n`;
  res += display.join(", ");
  if (matches.length > 50) {
    res += `\n\n...and ${matches.length - 50} more.`;
  }
  
  res += `\n\nTo use an icon in HTML/JSX, include the CDN in the head:\n<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />\n\nAnd use the class: <i class="ti ti-\${display[0]}"></i>`;
  
  return res;
}

/**
 * Get Tabler Icon SVG Source
 */
export async function getTablerIcon(name: string): Promise<string> {
  const exactName = name.replace(".svg", "");
  const filePath = path.join(TABLER_ICONS_DIR, `\${exactName}.svg`);
  
  if (!fs.existsSync(filePath)) {
    return `Error: Icon "\${exactName}" not found.`;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return content;
}
