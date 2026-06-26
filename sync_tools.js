const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetDir = "C:\\Users\\Shriyans\\.gemini\\antigravity\\mcp\\universal-orchestrator";
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const child = spawn(process.execPath, ['dist/index.js']);
let buffer = '';

child.stdout.on('data', (data) => {
  buffer += data.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result && msg.result.tools) {
        console.log(`Found ${msg.result.tools.length} tools.`);
        for (const tool of msg.result.tools) {
          const schema = {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          };
          const filePath = path.join(targetDir, `${tool.name}.json`);
          fs.writeFileSync(filePath, JSON.stringify(schema, null, 2));
          console.log(`Wrote ${tool.name}.json`);
        }
        child.kill();
        process.exit(0);
      }
    } catch (e) {
      // ignore parse errors
    }
  }
});

child.stderr.on('data', (data) => {
  console.error("STDERR:", data.toString());
});

// Initialize
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sync", version: "1.0" } }
}) + '\n');

// Wait for init then list tools
setTimeout(() => {
  // Send initialized notification
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }) + '\n');
  
  // List tools
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }) + '\n');
}, 500);

setTimeout(() => {
  console.log("Timeout waiting for tools");
  child.kill();
  process.exit(1);
}, 3000);
