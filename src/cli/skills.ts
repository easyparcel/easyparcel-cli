import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SKILL_FILES } from "../generated/skills";
import { printJson } from "../core/output";
import { log } from "../core/logger";

/** `ep skills install|list` — manage the bundled AI Agent Skills. */
export function registerSkills(program: Command): void {
  const skills = program.command("skills").description("Manage the EasyParcel AI Agent Skills (for Claude Code, Cursor, …)");

  skills
    .command("list")
    .description("List the bundled skills")
    .action(() => {
      printJson({ skills: SKILL_FILES.map((f) => f.path) });
    });

  skills
    .command("install")
    .description("Install the AI Agent Skills into a .claude/skills directory")
    .option("--user", "Install to ~/.claude/skills (default: ./.claude/skills in the current project)")
    .option("--dir <path>", "Install to a custom directory")
    .option("--force", "Overwrite existing skill files")
    .action((opts: Record<string, any>) => {
      const base = opts.dir
        ? path.resolve(String(opts.dir))
        : opts.user
          ? path.join(os.homedir(), ".claude", "skills")
          : path.join(process.cwd(), ".claude", "skills");

      let written = 0;
      let skipped = 0;
      for (const f of SKILL_FILES) {
        const dest = path.join(base, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && !opts.force) {
          skipped++;
          continue;
        }
        fs.writeFileSync(dest, f.content);
        written++;
      }
      log.info(
        `Installed ${written} skill file(s) to ${base}` +
          (skipped ? ` (${skipped} already existed; use --force to overwrite)` : "") +
          ". Restart your AI assistant to pick them up.",
      );
      printJson({ status: "ok", target: base, written, skipped, skills: SKILL_FILES.map((f) => f.path) });
    });
}
