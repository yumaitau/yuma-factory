import bridge from "../scripts/bridge.mjs";
import ci from "../scripts/ci.mjs";
import output from "../scripts/output.mjs";
import resume from "../scripts/resume.mjs";
import workersAi from "../scripts/workers-ai.mjs";

// Install only before a new process starts. Running jobs keep their own version.
// Script-only deployments can then leave the container image and disk untouched.
export async function installScripts(sb: { writeFile(path: string, content: string): Promise<unknown> }) {
  for (const [name, source] of Object.entries({ bridge, ci, output, resume, "workers-ai": workersAi })) {
    await sb.writeFile(`/opt/factory/${name}.mjs`, source);
  }
}
