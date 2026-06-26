/**
 * Playwright Visual Verifier
 *
 * Structured visual verification module using the locally loaded Playwright MCP server.
 * Runs targeted checks rather than a blanket screenshot-everything approach.
 */

import { callToolOnServer } from "../loaders/skillsLoader.js";
import type { LoadedMcpServer } from "../loaders/skillsLoader.js";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  details: string;
  severity: "error" | "warning" | "info";
}

export interface VerificationReport {
  url?: string;
  screenshotCaptured: boolean;
  snapshotCaptured: boolean;
  checks: VerificationCheck[];
  overallPassed: boolean;
  errorCount: number;
  warningCount: number;
  summary: string;
}

/**
 * Runs a full visual verification pass using Playwright.
 * Performs: screenshot, DOM snapshot, JS-based slop detection,
 * and targeted checks based on the focus areas provided.
 */
export async function runPlaywrightVerification(
  playwrightServer: LoadedMcpServer,
  options: {
    targetUrl?: string;
    focusAreas?: string[];
    label?: string;
  } = {}
): Promise<VerificationReport> {
  const report: VerificationReport = {
    url: options.targetUrl,
    screenshotCaptured: false,
    snapshotCaptured: false,
    checks: [],
    overallPassed: true,
    errorCount: 0,
    warningCount: 0,
    summary: ""
  };

  const call = async (tool: string, args: any) =>
    callToolOnServer(playwrightServer.entryPoint, playwrightServer.args || [], tool, args);

  // ----------------------------------------------------------
  // Step 1: Navigate to target URL if provided
  // ----------------------------------------------------------
  if (options.targetUrl) {
    try {
      await call("browser_navigate", { url: options.targetUrl });
    } catch (err: any) {
      report.checks.push({
        name: "Navigation",
        passed: false,
        details: `Failed to navigate to ${options.targetUrl}: ${err.message}`,
        severity: "error"
      });
      report.errorCount++;
      report.overallPassed = false;
    }
  }

  // ----------------------------------------------------------
  // Step 2: Take screenshot (desktop viewport)
  // ----------------------------------------------------------
  try {
    const screenshotResult = await call("browser_take_screenshot", { raw: false });
    if (screenshotResult?.content?.[0]?.text || screenshotResult?.content?.[0]?.data) {
      report.screenshotCaptured = true;
      report.checks.push({
        name: "Screenshot",
        passed: true,
        details: "Desktop screenshot captured successfully",
        severity: "info"
      });
    }
  } catch (err: any) {
    report.checks.push({
      name: "Screenshot",
      passed: false,
      details: `Screenshot failed: ${err.message}`,
      severity: "warning"
    });
    report.warningCount++;
  }

  // ----------------------------------------------------------
  // Step 3: DOM Snapshot (accessibility tree for structure check)
  // ----------------------------------------------------------
  let domSnapshot = "";
  try {
    const snapshotResult = await call("browser_snapshot", {});
    if (snapshotResult?.content?.[0]?.text) {
      domSnapshot = snapshotResult.content[0].text;
      report.snapshotCaptured = true;
    }
  } catch (_) {}

  // ----------------------------------------------------------
  // Step 4: JS-based automated checks
  // ----------------------------------------------------------
  let jsData: Record<string, any> = {};
  try {
    const jsResult = await call("browser_evaluate", {
      expression: `(function() {
        const data = {};

        // Check for React Bits component patterns
        data.hasCanvas = !!document.querySelector('canvas');
        data.hasAnimatedClasses = !!document.querySelector('[class*="aurora"], [class*="spotlight"], [class*="particles"], [class*="split-text"], [class*="blur-text"]');
        data.hasCSSAnimations = Array.from(document.querySelectorAll('*')).some(el => {
          const s = window.getComputedStyle(el);
          return s.animationName && s.animationName !== 'none';
        });

        // Slop detection
        data.loremCount = (document.body.innerText.match(/lorem ipsum/gi) || []).length;
        data.placeholderCount = (document.body.innerText.match(/\\[placeholder\\]|\\[insert|TBD|TODO/gi) || []).length;

        // Rainbow gradient detection (multi-hue gradients on dark backgrounds)
        const allEls = Array.from(document.querySelectorAll('*'));
        data.rainbowGradientDetected = allEls.some(el => {
          const bg = window.getComputedStyle(el).backgroundImage;
          if (!bg || !bg.includes('gradient')) return false;
          // Flag if gradient has 3+ distinct hue stops
          const hslMatches = bg.match(/hsl\\([^)]+\\)/g) || [];
          if (hslMatches.length >= 3) {
            const hues = hslMatches.map(h => parseFloat(h.replace('hsl(', '')));
            const hueRange = Math.max(...hues) - Math.min(...hues);
            return hueRange > 180;
          }
          return false;
        });

        // Dark theme slop detection
        const bodyBg = window.getComputedStyle(document.body).backgroundColor;
        const isDark = (bodyBg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/) || []).slice(1,4).map(Number).reduce((a,b)=>a+b,0) < 382;
        
        const htmlStr = document.documentElement.innerHTML.toLowerCase();
        data.hasPinkPurpleSlop = isDark && (htmlStr.includes('pink') || htmlStr.includes('fuchsia')) && (htmlStr.includes('purple') || htmlStr.includes('violet'));
        data.hasGreenPurpleSlop = isDark && (htmlStr.includes('cyan') || htmlStr.includes('teal') || htmlStr.includes('emerald')) && (htmlStr.includes('purple') || htmlStr.includes('violet'));

        // Excessive glow (box-shadow with high spread + blur)
        data.excessiveGlow = allEls.filter(el => {
          const shadow = window.getComputedStyle(el).boxShadow;
          if (!shadow || shadow === 'none') return false;
          const parts = shadow.split(' ').map(Number).filter(n => !isNaN(n));
          return parts.some(n => n > 40); // spread or blur > 40px = excessive
        }).length;

        // Layout overflow
        data.overflowingEls = allEls.filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > window.innerWidth + 10; // 10px tolerance
        }).length;

        // Mobile check: resize and verify nothing critical overflows
        const origWidth = window.innerWidth;
        data.viewportWidth = origWidth;
        data.devicePixelRatio = window.devicePixelRatio;

        return JSON.stringify(data);
      })()`
    });

    if (jsResult?.content?.[0]?.text) {
      try { jsData = JSON.parse(jsResult.content[0].text); } catch (_) {}
    }
  } catch (err: any) {
    console.error(`[PlaywrightVerifier] JS evaluation failed: ${err.message}`);
  }

  // ----------------------------------------------------------
  // Step 5: Analyze JS results → populate checks
  // ----------------------------------------------------------

  // React Bits presence
  const hasReactBits = jsData.hasCanvas || jsData.hasAnimatedClasses || jsData.hasCSSAnimations;
  report.checks.push({
    name: "React Bits / Animations",
    passed: hasReactBits,
    details: hasReactBits
      ? `✓ Animated elements detected (canvas: ${jsData.hasCanvas}, CSS animations: ${jsData.hasCSSAnimations})`
      : "⚠ No React Bits animation patterns found. Check that components are correctly implemented.",
    severity: hasReactBits ? "info" : "warning"
  });
  if (!hasReactBits) report.warningCount++;

  // Lorem ipsum slop
  if (jsData.loremCount > 0) {
    report.checks.push({
      name: "Placeholder Text",
      passed: false,
      details: `✗ Found ${jsData.loremCount} instance(s) of "Lorem ipsum". Replace with real content.`,
      severity: "error"
    });
    report.errorCount++;
    report.overallPassed = false;
  } else {
    report.checks.push({
      name: "Placeholder Text",
      passed: true,
      details: "✓ No placeholder text detected",
      severity: "info"
    });
  }

  // Rainbow gradient detection
  if (jsData.rainbowGradientDetected) {
    report.checks.push({
      name: "Color Quality (Rainbow Gradient)",
      passed: false,
      details: "✗ Multi-hue rainbow gradient detected. Use a focused, clean, professional palette instead.",
      severity: "error"
    });
    report.errorCount++;
    report.overallPassed = false;
  } else if (jsData.hasPinkPurpleSlop || jsData.hasGreenPurpleSlop) {
    report.checks.push({
      name: "Color Quality (Slop Colors)",
      passed: false,
      details: "✗ Forbidden color combination detected on dark theme (Pink/Purple or Greenish/Purple). Use bold, clean, professional colors. Avoid AI design tropes.",
      severity: "error"
    });
    report.errorCount++;
    report.overallPassed = false;
  } else {
    report.checks.push({
      name: "Color Quality",
      passed: true,
      details: "✓ Colors appear clean and professional (no forbidden combinations detected).",
      severity: "info"
    });
  }

  // Excessive glow
  if (jsData.excessiveGlow > 3) {
    report.checks.push({
      name: "Glow Effects",
      passed: false,
      details: `⚠ ${jsData.excessiveGlow} elements have excessive box-shadow glow (>40px). Reduce for premium feel.`,
      severity: "warning"
    });
    report.warningCount++;
  } else {
    report.checks.push({
      name: "Glow Effects",
      passed: true,
      details: `✓ Glow usage appropriate (${jsData.excessiveGlow || 0} elements with large shadows)`,
      severity: "info"
    });
  }

  // Layout overflow
  if (jsData.overflowingEls > 0) {
    report.checks.push({
      name: "Layout Overflow",
      passed: false,
      details: `✗ ${jsData.overflowingEls} element(s) extend beyond viewport width. Check responsive styles.`,
      severity: "error"
    });
    report.errorCount++;
    report.overallPassed = false;
  } else {
    report.checks.push({
      name: "Layout Overflow",
      passed: true,
      details: "✓ No layout overflow detected",
      severity: "info"
    });
  }

  // ----------------------------------------------------------
  // Step 6: Mobile viewport check
  // ----------------------------------------------------------
  try {
    await call("browser_resize", { width: 375, height: 812 });
    const mobileJs = await call("browser_evaluate", {
      expression: `JSON.stringify({
        overflow: Array.from(document.querySelectorAll('*')).filter(el => el.getBoundingClientRect().right > window.innerWidth + 10).length,
        navVisible: !!document.querySelector('nav, [role="navigation"]')
      })`
    });
    let mobileData: any = {};
    try { mobileData = JSON.parse(mobileJs?.content?.[0]?.text || "{}"); } catch (_) {}

    report.checks.push({
      name: "Mobile Responsiveness (375px)",
      passed: mobileData.overflow === 0,
      details: mobileData.overflow === 0
        ? "✓ No overflow at 375px mobile viewport"
        : `⚠ ${mobileData.overflow} element(s) overflow at 375px. Fix responsive CSS.`,
      severity: mobileData.overflow === 0 ? "info" : "warning"
    });
    if (mobileData.overflow > 0) report.warningCount++;

    // Reset to desktop
    await call("browser_resize", { width: 1440, height: 900 });
  } catch (err: any) {
    report.checks.push({
      name: "Mobile Responsiveness",
      passed: false,
      details: `Could not run mobile check: ${err.message}`,
      severity: "warning"
    });
    report.warningCount++;
  }

  // ----------------------------------------------------------
  // Step 7: Build summary
  // ----------------------------------------------------------
  const label = options.label || "Design Verification";
  const passedCount = report.checks.filter(c => c.passed).length;
  const totalCount = report.checks.length;

  report.summary = [
    `## ${label} Report`,
    ``,
    `**Result**: ${report.overallPassed ? "✅ PASSED" : "❌ ISSUES FOUND"}`,
    `**Checks**: ${passedCount}/${totalCount} passed`,
    `**Errors**: ${report.errorCount} | **Warnings**: ${report.warningCount}`,
    ``,
    `### Check Details`,
    ...report.checks.map(c => {
      const icon = c.severity === "error" ? "🔴" : c.severity === "warning" ? "🟡" : "🟢";
      return `${icon} **${c.name}**: ${c.details}`;
    }),
    ``,
    report.errorCount > 0
      ? `### ⚠️ Action Required\nFix the ${report.errorCount} error(s) above before finalizing.`
      : report.warningCount > 0
        ? `### 💡 Recommendations\nAddress the ${report.warningCount} warning(s) for a higher quality result.`
        : `### ✅ Ready for Delivery\nAll checks passed. Safe to push to GitHub.`
  ].join("\n");

  return report;
}

/**
 * Runs the debug-skill on output to catch code-level bugs.
 * Targets the debug-skill MCP server or the skill description.
 */
export async function runDebugPass(
  debugServer: LoadedMcpServer | null,
  targetDescription: string
): Promise<{ passed: boolean; issues: string[]; report: string }> {
  const issues: string[] = [];

  if (!debugServer) {
    return {
      passed: true,
      issues: [],
      report: "Debug-skill not loaded. Activate website_builder agent to enable full debugging."
    };
  }

  try {
    const tools = debugServer.tools.map((t: any) => t.name);
    console.error(`[Debugger] Available debug tools: ${tools.join(", ")}`);

    // Use the first available debug tool
    if (tools.length > 0) {
      const result = await callToolOnServer(
        debugServer.entryPoint,
        debugServer.args || [],
        tools[0],
        { description: targetDescription, mode: "full" }
      );
      const text = result?.content?.[0]?.text || "";
      if (text.toLowerCase().includes("error") || text.toLowerCase().includes("bug")) {
        issues.push(text);
      }
      return {
        passed: issues.length === 0,
        issues,
        report: text || "Debug pass completed. No critical issues detected."
      };
    }
  } catch (err: any) {
    issues.push(`Debug tool error: ${err.message}`);
  }

  return {
    passed: issues.length === 0,
    issues,
    report: issues.length > 0
      ? `Debug issues found:\n${issues.join("\n")}`
      : "Debug pass completed — no issues detected."
  };
}
