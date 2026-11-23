// `npm run dev:ui`: the UI playground in one command. Starts the dev Worker (fake FreeAgent and test data, port 8788)
// and Vite (hot-reloading UI, port 5173, which proxies the API to the Worker), labels their output, and stops both
// on Ctrl-C or when either one exits.
import { spawn } from "node:child_process";

const procs = [
  { name: "worker", color: 35, cmd: "npm", args: ["run", "dev:worker"], cwd: "." },
  { name: "ui", color: 36, cmd: "npx", args: ["vite", "--port", "5173", "--strictPort"], cwd: "ui" },
];

let stopping = false;
const children = procs.map((p) => {
  // detached: each gets its own process group, so stopping it also stops what it started (npm -> wrangler -> workerd)
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        process.stdout.write(tag + line + "\n");
        // eslint-disable-next-line no-control-regex -- strip Vite's colours before looking for its "Local:" line
        if (p.name === "ui" && line.replace(/\x1b\[[0-9;]*m/g, "").includes("Local:")) process.stdout.write(`\n  Open http://localhost:5173\n\n`);
      }
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      process.stdout.write(`${tag}exited${code ? ` with code ${code}` : ""}; stopping the other one\n`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM"); // the whole group
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
