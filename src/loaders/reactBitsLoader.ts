import fs from "fs";
import path from "path";

const REACT_BITS_ROOT = path.resolve(process.cwd(), "skills", "react-bits");
const CONTENT_ROOT = path.join(REACT_BITS_ROOT, "src", "content");

export type ReactBitsVariant = "JS-CSS" | "JS-TW" | "TS-CSS" | "TS-TW";

export interface ReactBitsComponent {
  name: string;
  category: "Animations" | "Backgrounds" | "Components" | "TextAnimations";
  description: string;
  docsUrl: string;
  installCommand: string;
  variants: ReactBitsVariant[];
}

export interface ReactBitsSource {
  componentName: string;
  category: string;
  variant: ReactBitsVariant;
  files: Array<{ fileName: string; content: string }>;
}

// Map from directory structure to human-readable category
const CATEGORIES = ["Animations", "Backgrounds", "Components", "TextAnimations"] as const;

/**
 * Scans the local react-bits content directory and returns all available components.
 */
export function listReactBitsComponents(): ReactBitsComponent[] {
  const components: ReactBitsComponent[] = [];

  if (!fs.existsSync(CONTENT_ROOT)) {
    console.error("[ReactBits] Content root not found:", CONTENT_ROOT);
    return components;
  }

  for (const category of CATEGORIES) {
    const categoryPath = path.join(CONTENT_ROOT, category);
    if (!fs.existsSync(categoryPath)) continue;

    const componentDirs = fs.readdirSync(categoryPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const componentName of componentDirs) {
      const availableVariants: ReactBitsVariant[] = [];

      // Check which variants exist
      const jscssDirExists = fs.existsSync(path.join(REACT_BITS_ROOT, "src", "content", category, componentName));
      const jstvDirExists = fs.existsSync(path.join(REACT_BITS_ROOT, "src", "tailwind", category, componentName));
      const tscssDirExists = fs.existsSync(path.join(REACT_BITS_ROOT, "src", "ts-default", category, componentName));
      const tstwDirExists = fs.existsSync(path.join(REACT_BITS_ROOT, "src", "ts-tailwind", category, componentName));

      if (jscssDirExists) availableVariants.push("JS-CSS");
      if (jstvDirExists) availableVariants.push("JS-TW");
      if (tscssDirExists) availableVariants.push("TS-CSS");
      if (tstwDirExists) availableVariants.push("TS-TW");

      // Convert component name to kebab-case for the install command
      const kebabName = componentName.replace(/([A-Z])/g, (m, l, i) => (i > 0 ? "-" : "") + l.toLowerCase());
      const docsSlug = kebabName;

      components.push({
        name: componentName,
        category: category as ReactBitsComponent["category"],
        description: getComponentDescription(category, componentName),
        docsUrl: `https://reactbits.dev/${category.toLowerCase()}/${docsSlug}`,
        installCommand: `npx jsrepo add @react-bits/${componentName}`,
        variants: availableVariants.length > 0 ? availableVariants : ["JS-CSS"]
      });
    }
  }

  return components;
}

/**
 * Retrieves the source code for a specific React Bits component and variant.
 */
export function getReactBitsSource(
  componentName: string,
  variant: ReactBitsVariant = "TS-CSS"
): ReactBitsSource | null {
  // Determine base path for this variant
  let basePath: string;
  switch (variant) {
    case "JS-CSS": basePath = path.join(REACT_BITS_ROOT, "src", "content"); break;
    case "JS-TW": basePath = path.join(REACT_BITS_ROOT, "src", "tailwind"); break;
    case "TS-CSS": basePath = path.join(REACT_BITS_ROOT, "src", "ts-default"); break;
    case "TS-TW": basePath = path.join(REACT_BITS_ROOT, "src", "ts-tailwind"); break;
    default: basePath = path.join(REACT_BITS_ROOT, "src", "content");
  }

  // Find which category contains this component
  for (const category of CATEGORIES) {
    const componentDir = path.join(basePath, category, componentName);
    if (fs.existsSync(componentDir)) {
      const files = fs.readdirSync(componentDir)
        .filter(f => !f.startsWith("."))
        .map(fileName => {
          const filePath = path.join(componentDir, fileName);
          let content = "";
          try { content = fs.readFileSync(filePath, "utf-8"); } catch (_) {}
          return { fileName, content };
        });

      return { componentName, category, variant, files };
    }
  }

  // Fallback: try JS-CSS content directory
  if (variant !== "JS-CSS") {
    return getReactBitsSource(componentName, "JS-CSS");
  }

  return null;
}

/**
 * Searches React Bits components by name or category keyword.
 */
export function searchReactBitsComponents(query: string): ReactBitsComponent[] {
  const all = listReactBitsComponents();
  const q = query.toLowerCase();
  return all.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.category.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q)
  );
}

/**
 * Gets a summary of all available React Bits components formatted for LLM consumption.
 */
export function getReactBitsCatalogSummary(): string {
  const all = listReactBitsComponents();

  const byCategory: Record<string, ReactBitsComponent[]> = {};
  for (const c of all) {
    if (!byCategory[c.category]) byCategory[c.category] = [];
    byCategory[c.category].push(c);
  }

  const lines: string[] = [
    "# React Bits Component Library",
    "",
    "React Bits is a collection of animated, interactive & fully customizable React components.",
    "Install any component with: `npx jsrepo add @react-bits/<ComponentName>`",
    "Variants available: JS-CSS (default), JS-TW (Tailwind), TS-CSS (TypeScript), TS-TW (TypeScript + Tailwind)",
    "",
  ];

  for (const [category, components] of Object.entries(byCategory)) {
    lines.push(`## ${category} (${components.length} components)`);
    for (const c of components) {
      lines.push(`- **${c.name}**: ${c.description}`);
    }
    lines.push("");
  }

  lines.push("## Usage Mandate");
  lines.push("ALWAYS prefer React Bits components over hand-written alternatives.");
  lines.push("Use the `react_bits_get_source` tool to retrieve any component's source code.");
  lines.push("Copy components directly — they are self-contained files, not npm packages.");

  return lines.join("\n");
}

/**
 * Reads description from the Information.js metadata file if available.
 * Falls back to a generic description.
 */
function getComponentDescription(category: string, componentName: string): string {
  // Static descriptions extracted from Information.js for key components
  const descriptions: Record<string, string> = {
    // Animations
    "AnimatedContent": "Wrapper that animates any children on scroll or mount with configurable direction, distance, duration, easing and disappear options.",
    "BlobCursor": "Organic blob cursor that smoothly follows the pointer with inertia and elastic morphing.",
    "ClickSpark": "Creates particle spark bursts at click position.",
    "Crosshair": "Custom crosshair cursor with tracking, and link hover effects.",
    "Cubes": "3D rotating cube cluster. Supports auto-rotation or hover interaction.",
    "ElectricBorder": "Jittery electric energy border with animated arcs, glow and adjustable intensity.",
    "FadeContent": "Simple directional fade / slide entrance / exit wrapper with threshold-based activation.",
    "GlareHover": "Adds a realistic moving glare highlight on hover over any element.",
    "GradualBlur": "Progressively un-blurs content based on scroll or trigger creating a cinematic reveal.",
    "GhostCursor": "Semi-transparent ghost cursor that smoothly follows the real cursor with a trailing effect.",
    "ImageTrail": "Cursor-based image trail with several built-in variants.",
    "LaserFlow": "Flowing laser light streams that follow or radiate from a cursor.",
    "LogoLoop": "Seamlessly looping logo/image marquee strip.",
    "MagicRings": "Concentric animated rings that pulse and react to pointer.",
    "Magnet": "Magnetic repulsion / attraction effect for UI elements near the cursor.",
    "MagnetLines": "Directional field lines that orient toward the cursor.",
    "MetaBalls": "Liquid metaball blobs that merge and split on hover.",
    "MetallicPaint": "Shimmering metallic paint effect controlled by cursor.",
    "Noise": "Animated Perlin noise canvas overlay or background.",
    "OrbitImages": "Images that orbit a central point with configurable speed and radius.",
    "PixelTrail": "Pixelated cursor trail that paints and fades.",
    "PixelTransition": "Pixel-dissolve page or element transition.",
    "Ribbons": "Flowing ribbon strands that react to pointer movement.",
    "ShapeBlur": "Geometric shapes that blur and morph behind content.",
    "SplashCursor": "Fluid ink-splash effect following the cursor.",
    "StarBorder": "Rotating star / sparkle border around any element.",
    "StickerPeel": "Corner-peel sticker lift effect on hover.",
    "Strands": "Fine strand / hair lines that flow from cursor.",
    "TargetCursor": "Animated target reticle cursor.",
    "Antigravity": "Elements that float and bounce as if in zero-gravity.",
    // Backgrounds
    "Aurora": "Smooth northern-lights aurora background with animated color bands.",
    "Balatro": "Card-game inspired animated background.",
    "Ballpit": "Bouncing physics balls background.",
    "Beams": "Animated light beam rays background.",
    "ColorBends": "Flowing color-bend gradient animation.",
    "DarkVeil": "Dark animated veil / fog overlay.",
    "Dither": "Retro dithered animated background pattern.",
    "DotField": "Animated floating dot field background.",
    "DotGrid": "Interactive dot grid that reacts to cursor proximity.",
    "EvilEye": "Creepy animated eye background.",
    "FaultyTerminal": "Glitching CRT terminal screen background.",
    "Ferrofluid": "Magnetic ferrofluid simulation background.",
    "FloatingLines": "Slowly drifting line segments background.",
    "Galaxy": "3D particle galaxy background.",
    "GradientBlinds": "Venetian blinds opening to reveal a gradient.",
    "Grainient": "Gradient with film grain overlay.",
    "GridDistortion": "Grid that warps and distorts near cursor.",
    "GridMotion": "Smooth grid of tiles with motion blur.",
    "GridScan": "Scanning grid-line animation.",
    "Hyperspeed": "Warp-speed star streak background.",
    "Iridescence": "Iridescent oil-slick shimmer background.",
    "LetterGlitch": "Random characters glitching across background.",
    "LightPillar": "Vertical light pillar beam background.",
    "LightRays": "Crepuscular light ray background.",
    "Lightfall": "Falling light particles background.",
    "Lightning": "Animated lightning bolt background.",
    "LineWaves": "Oscillating wave line background.",
    "LiquidChrome": "Liquid chrome / mercury simulation.",
    "LiquidEther": "Flowing ether liquid background.",
    "Orb": "Glowing orb with animated energy halo.",
    "Particles": "Configurable particle system background.",
    "PixelBlast": "Exploding pixel blast animation.",
    "PixelSnow": "Falling pixel snow background.",
    "Plasma": "Animated plasma / lava-lamp background.",
    "PlasmaWave": "Plasma wave flowing background.",
    "Prism": "Prism light dispersion background.",
    "PrismaticBurst": "Burst of prismatic light rays.",
    "Radar": "Rotating radar sweep background.",
    "RippleGrid": "Grid that ripples outward from cursor.",
    "ShapeGrid": "Animated grid of rotating geometric shapes.",
    "SideRays": "Side-emitting light rays.",
    "Silk": "Flowing silk fabric simulation.",
    "SoftAurora": "Soft pastel aurora background.",
    "Threads": "Interwoven animated thread background.",
    "Waves": "Ocean wave animated background.",
    // Components
    "AnimatedList": "List where items animate in staggered sequence.",
    "BorderGlow": "Glowing animated border around any element.",
    "BounceCards": "Cards that bounce elastically on interaction.",
    "BubbleMenu": "Floating bubble-style menu.",
    "CardNav": "Card-based navigation component.",
    "CardSwap": "Swappable card stack with gesture support.",
    "Carousel": "Touch/drag carousel component.",
    "ChromaGrid": "Grid with chroma-key color effects.",
    "CircularGallery": "Gallery arranged in a rotating circle.",
    "Counter": "Animated number counter.",
    "DecayCard": "Card with physics decay on release.",
    "Dock": "macOS-style magnifying dock.",
    "DomeGallery": "Gallery arranged on a dome shape.",
    "ElasticSlider": "Slider with elastic snap behavior.",
    "FlowingMenu": "Menu with fluid flowing hover effects.",
    "FluidGlass": "Glassmorphism component with fluid distortion.",
    "FlyingPosters": "Posters that fly in from off-screen.",
    "Folder": "Animated folder open/close component.",
    "GlassIcons": "Glassmorphic icon set.",
    "GlassSurface": "Frosted glass surface component.",
    "GooeyNav": "Navigation with gooey blob morphing effect.",
    "InfiniteMenu": "Infinitely scrolling circular menu.",
    "Lanyard": "3D lanyard physics simulation.",
    "MagicBento": "Bento-grid layout with magic hover effects.",
    "Masonry": "Masonry layout grid.",
    "ModelViewer": "3D model viewer with controls.",
    "PillNav": "Pill-shaped sliding navigation.",
    "PixelCard": "Card with pixel art or pixelation effect.",
    "ProfileCard": "Animated social profile card.",
    "ReflectiveCard": "Card with reflective surface on hover.",
    "ScrollStack": "Cards that stack as you scroll.",
    "SpotlightCard": "Card with mouse-tracking spotlight highlight.",
    "Stack": "Stacked card pile with fan animation.",
    "StaggeredMenu": "Menu with staggered entrance animation.",
    "Stepper": "Animated multi-step progress component.",
    "TiltedCard": "Card with tilt parallax on mouse move.",
    // TextAnimations
    "ASCIIText": "Text rendered as ASCII art.",
    "BlurText": "Text with animated blur reveal.",
    "CircularText": "Text arranged in a circle.",
    "CountUp": "Count-up number animation.",
    "CurvedLoop": "Text looping along a curved path.",
    "DecryptedText": "Text that decrypts character by character.",
    "FallingText": "Characters that fall with physics.",
    "FuzzyText": "Text with fuzzy static noise effect.",
    "GlitchText": "Text with digital glitch effect.",
    "GradientText": "Text with animated gradient fill.",
    "RotatingText": "Text that rotates through multiple strings.",
    "ScrambledText": "Text that scrambles and unscrambles.",
    "ScrollFloat": "Text that floats on scroll.",
    "ScrollReveal": "Text that reveals on scroll.",
    "ScrollVelocity": "Text speed affected by scroll velocity.",
    "ShinyText": "Shimmering shine effect on text.",
    "Shuffle": "Text characters shuffle into place.",
    "SplitText": "Text split into animated individual characters.",
    "TextCursor": "Typewriter with blinking cursor.",
    "TextPressure": "Text that responds to mouse pressure/proximity.",
    "TextType": "Typewriter text animation.",
    "TrueFocus": "Text with animated focus ring scanning effect.",
    "VariableProximity": "Variable font weight driven by cursor distance.",
  };

  return descriptions[componentName] || `${category} component: ${componentName}`;
}
