import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { providerSkillsService } from "@/modules/providers/services/skills.service.js";
import { parseFrontMatter } from "@/shared/frontmatter.js";
import { resolveProjectFileForRead } from "@/shared/project-file-containment.js";

export type LiveGjcCommandNamespace = "builtin" | "user" | "project" | "skill";

export interface LiveGjcCommand {
  /** Slash invocation, e.g. `/omg:easy` or `/my-skill`. */
  name: string;
  description: string;
  namespace: LiveGjcCommandNamespace;
  scope: string;
  sourcePath?: string;
}

// Bound the scan so a pathological command tree can't stall the request.
const MAX_COMMANDS = 500;

/**
 * gjc TUI built-in slash commands, captured from the live `/` menu of the
 * installed gjc (v0.11.11). They are implemented inside the gjc binary — no
 * on-disk markdown exists to scan — so the deck lists them statically for
 * parity with a native tmux keyboard. The relay only types the command into
 * the verified pane like any other message; gjc remains the sole executor.
 */
export const GJC_BUILTIN_COMMANDS: readonly LiveGjcCommand[] = [
  { name: "/help", description: "Learn commands and beginner workflows" },
  { name: "/clear", description: "Clear context while preserving this session ID" },
  { name: "/new", description: "Start a new session" },
  { name: "/resume", description: "Resume a previous session" },
  { name: "/sessions", description: "Show all persisted sessions (read-only)" },
  { name: "/session", description: "Show session info or delete the current session transcript" },
  { name: "/goal", description: "Plan and track an autonomous goal" },
  { name: "/compact", description: "Compact context and continue this session" },
  { name: "/handoff", description: "Generate a handoff and continue in a new session" },
  { name: "/retry", description: "Retry or continue the last interrupted turn" },
  { name: "/copy", description: "Copy the last response for review or sharing" },
  { name: "/dump", description: "Dump the full transcript for review or sharing" },
  { name: "/export", description: "Export this session to an HTML file" },
  { name: "/settings", description: "Open settings and preferences" },
  { name: "/notify", description: "Notification status, health, test, and recovery" },
  { name: "/theme", description: "Open theme selector" },
  { name: "/pet", description: "Gajae pet living beside the composer" },
  { name: "/model", description: "Select model (opens selector UI)" },
  { name: "/effort", description: "Show or set model reasoning effort" },
  { name: "/fast", description: "Toggle priority service tier (OpenAI service_tier=priority)" },
  { name: "/jobs", description: "Show async background jobs status" },
  { name: "/transcript", description: "Browse the current session transcript" },
  { name: "/context", description: "Show active context token usage breakdown" },
  { name: "/usage", description: "Show provider usage and limits" },
  { name: "/changelog", description: "Show release notes and changelog entries" },
  { name: "/hotkeys", description: "Show all keyboard shortcuts" },
  { name: "/tools", description: "Show tools currently visible to the agent" },
  { name: "/monitors", description: "Open the monitor/cron jobs overlay" },
  { name: "/tree", description: "Navigate session tree (switch branches)" },
  { name: "/provider", description: "Set up API-compatible providers or login providers" },
  { name: "/login", description: "Login with OAuth provider" },
  { name: "/logout", description: "Logout from OAuth provider" },
  { name: "/ssh", description: "Manage SSH hosts (add, list, remove)" },
  { name: "/drop", description: "Delete the current session and start a new one" },
  { name: "/contribute-pr", description: "Dump redacted session context and spawn a contribution session" },
  { name: "/btw", description: "Start an ephemeral multi-turn side chat using the current context" },
  { name: "/background", description: "Detach UI and continue running in background" },
  { name: "/debug", description: "Open debug tools selector" },
  { name: "/memory", description: "Inspect and operate memory maintenance" },
  { name: "/rename", description: "Rename the current session" },
  { name: "/move", description: "Move session to a different working directory" },
  { name: "/exit", description: "Exit the application" },
  { name: "/init", description: "Generate AGENTS.md for current codebase" },
].map((command) => ({ ...command, namespace: "builtin" as const, scope: "builtin" }));

async function scanInto(
  dir: string,
  baseDir: string,
  namespace: "user" | "project",
  out: LiveGjcCommand[],
): Promise<void> {
  if (out.length >= MAX_COMMANDS) {
    return;
  }

  // Missing / unreadable dir (no native or project commands) is not an error.
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => null);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS) {
      return;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await scanInto(fullPath, baseDir, namespace, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const content = await fs.readFile(fullPath, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }

    const { data: frontmatter, content: body } = parseFrontMatter(content);
    const relativePath = path.relative(baseDir, fullPath);
    // The command name IS the file's relative path (native install writes the
    // command filename verbatim, e.g. `omg:easy.md` -> `/omg:easy`).
    const name = `/${relativePath.replace(/\.md$/i, "").replace(/\\/g, "/")}`;

    let description =
      frontmatter && typeof frontmatter.description === "string"
        ? frontmatter.description
        : "";
    if (!description) {
      const firstLine = body.trim().split("\n")[0] ?? "";
      description = firstLine.replace(/^#+\s*/, "").trim();
    }

    out.push({
      name,
      description,
      namespace,
      scope: namespace,
      sourcePath: fullPath,
    });
  }
}

/**
 * Recursively enumerates markdown command files under `rootDir`, mapping each
 * file's path (relative to `rootDir`) to a `/slash` command name. The command
 * root must resolve inside `containmentRoot`, so symlinked roots cannot escape
 * the configured workspace or home directory. Missing/unreadable directories
 * yield `[]` rather than throwing.
 */
export async function scanGjcCommandDirectory(
  rootDir: string,
  namespace: "user" | "project",
  containmentRoot = rootDir,
): Promise<LiveGjcCommand[]> {
  const canonicalRoot = await resolveProjectFileForRead(
    containmentRoot,
    rootDir,
  ).catch(() => null);
  if (!canonicalRoot) {
    return [];
  }

  const out: LiveGjcCommand[] = [];
  await scanInto(canonicalRoot, canonicalRoot, namespace, out);
  return out;
}

/** Keeps the first occurrence of each command name (native > project > skill). */
export function dedupeCommandsByName(
  commands: LiveGjcCommand[],
): LiveGjcCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.name)) {
      return false;
    }
    seen.add(command.name);
    return true;
  });
}

/**
 * Enumerates the slash commands a live tmux gjc session can execute:
 * user-global native commands (`~/.gjc/agent/commands`), project commands
 * (`<workspace>/.gjc/commands`), and installed skills (native + plugin, via
 * the gjc skills provider). Read-only; a failure in any source degrades to a
 * partial list rather than failing the whole request.
 */
export async function listLiveGjcCommands(
  workspacePath?: string,
): Promise<LiveGjcCommand[]> {
  // Builtins first: dedupe keeps the first occurrence, so a user markdown
  // command can never shadow a native TUI command (matching TUI behavior).
  const commands: LiveGjcCommand[] = [...GJC_BUILTIN_COMMANDS];

  const homeDir = os.homedir();
  const userCommandsDir = path.join(homeDir, ".gjc", "agent", "commands");
  commands.push(
    ...(await scanGjcCommandDirectory(userCommandsDir, "user", homeDir)),
  );

  if (workspacePath) {
    const projectCommandsDir = path.join(workspacePath, ".gjc", "commands");
    commands.push(
      ...(await scanGjcCommandDirectory(
        projectCommandsDir,
        "project",
        workspacePath,
      )),
    );
  }

  try {
    const skills = await providerSkillsService.listProviderSkills("gjc", {
      workspacePath,
    });
    for (const skill of skills) {
      commands.push({
        name: skill.command,
        description: skill.description ?? "",
        namespace: "skill",
        scope: skill.scope,
        sourcePath: skill.sourcePath,
      });
    }
  } catch {
    // Skills enumeration failure must not hide the file-based commands.
  }

  return dedupeCommandsByName(commands);
}
