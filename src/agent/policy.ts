import { join, isAbsolute, relative, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sessionDir } from "./storage";

export interface Policy {
  exec_allow?: string[];
  exec_deny?: string[];
  file_allow?: string[];
  file_deny?: string[];
  strict_workdir?: boolean;
}

export type PolicyDecision =
  | { kind: "auto_allow"; reason: string }
  | { kind: "auto_deny"; reason: string }
  | { kind: "ask" };

export const DEFAULT_POLICY: Policy = {
  exec_allow: [
    "^\\s*(ls|pwd|whoami|hostname|date|uname|env|echo|printenv)(\\s|$)",
    "^\\s*(cat|head|tail|less|more|file|stat)\\s+",
    "^\\s*(grep|rg|ag|egrep|fgrep)\\s+",
    "^\\s*find\\s+\\S+\\s+(-name|-type|-maxdepth|-path)",
    "^\\s*(wc|awk|sed -n)\\s+",
    "^\\s*(which|type|whereis|command -v)\\s+",
    "^\\s*(ps|df|du|free|top -b|iostat|vmstat)(\\s|$)",
    "^\\s*tree(\\s|$)",
    "^\\s*git\\s+(status|log|diff|show|branch|remote|config --(get|list)|rev-parse|describe|ls-files|ls-tree|cat-file|tag\\s+--list|stash list|reflog|fetch)(\\s|$)",
    "^\\s*(npm|yarn|pnpm|bun)\\s+(list|outdated|info|view|search|--version)(\\s|$)",
    "^\\s*(node|bun|python|python3|deno|go|cargo|rustc|java|javac)\\s+(--version|-V|version)(\\s|$)",
    "^\\s*pip\\s+(list|show|--version)(\\s|$)",
    "^\\s*cargo\\s+(check|tree|metadata)(\\s|$)",
    "^\\s*(tsc|tsc --noEmit)(\\s|$)",
    "^\\s*(eslint|prettier|stylelint|tslint)\\s+",
    "^\\s*(jest|vitest|mocha|pytest|bun test|cargo test)(\\s|$)",
    "^\\s*npm run (lint|test|build|typecheck|check)",
  ],
  exec_deny: [
    "\\bsudo\\b",
    "\\bsu\\s+-",
    "\\bdoas\\b",
    "\\brm\\s+-[rRf]+\\s+(/$|/\\s|/[^./])",
    "\\brm\\s+-[rRf]+\\s+\\$HOME(/?)?\\s",
    "\\brm\\s+-[rRf]+\\s+~(/?)?\\s",
    "\\bdd\\s+if=.*\\s+of=/dev/",
    "\\bmkfs\\.",
    "\\bshred\\b",
    "\\bdiskutil\\s+(erase|format)",
    "\\bcurl\\s+[^|]*\\|\\s*(sh|bash|zsh|fish)",
    "\\bwget\\s+[^|]*\\|\\s*(sh|bash|zsh|fish)",
    "\\bcurl\\s+.*-o\\s+/(usr|etc|bin|sbin|lib)/",
    ":\\(\\)\\s*\\{",
    "\\bchmod\\s+-R\\s+[0-7]+\\s+/",
    "\\bssh-keygen\\s+-t",
    "\\bsshpass\\b",
    "\\b(passwd|chpasswd)\\b",
    "\\bgit\\s+push\\s+.*--force",
  ],
  file_allow: [],
  file_deny: [
    "/\\.ssh/",
    "/\\.aws/",
    "/\\.gnupg/",
    "\\.env(\\.|$)",
    "/etc/(passwd|shadow|sudoers)",
    "/(usr|etc|bin|sbin)/",
  ],
  strict_workdir: false,
};

export function unwrapShellCommand(cmd: string): string {
  if (!cmd) return "";
  const m = cmd.match(/^(?:\S*sh|\S*bash|\S*zsh)(?:\s+-\w+)*\s+["'](.*)["']\s*$/s);
  return m ? m[1] : cmd;
}

export function pathInWorkdir(path: string, workdir: string): boolean {
  if (!path) return false;
  const abs = isAbsolute(path) ? resolve(path) : resolve(workdir, path);
  const base = resolve(workdir);
  const rel = relative(base, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function evaluatePolicy(policy: Policy, method: string, params: any, workdir: string): PolicyDecision {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const cmdRaw = String(params?.command ?? "");
    const cmd = unwrapShellCommand(cmdRaw);
    for (const pat of policy.exec_deny ?? []) {
      try { if (new RegExp(pat).test(cmd)) return { kind: "auto_deny", reason: `policy deny: /${pat}/` }; }
      catch { /* skip */ }
    }
    for (const pat of policy.exec_allow ?? []) {
      try { if (new RegExp(pat).test(cmd)) return { kind: "auto_allow", reason: `policy allow: /${pat}/` }; }
      catch { /* skip */ }
    }
    return { kind: "ask" };
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const paths = collectChangedPaths(params);
    for (const p of paths) {
      for (const pat of policy.file_deny ?? []) {
        try { if (new RegExp(pat).test(p)) return { kind: "auto_deny", reason: `file deny: ${p} matches /${pat}/` }; }
        catch { /* skip */ }
      }
    }
    if (policy.strict_workdir) {
      for (const p of paths) {
        if (!pathInWorkdir(p, workdir)) return { kind: "auto_deny", reason: `file outside workdir: ${p}` };
      }
    }
    let allMatched = paths.length > 0;
    for (const p of paths) {
      let hit = false;
      for (const pat of policy.file_allow ?? []) {
        try { if (new RegExp(pat).test(p)) { hit = true; break; } }
        catch { /* skip */ }
      }
      if (!hit) { allMatched = false; break; }
    }
    if (allMatched) return { kind: "auto_allow", reason: "all paths matched file_allow" };
    if (!policy.strict_workdir && paths.length > 0 && paths.every((p) => pathInWorkdir(p, workdir))) {
      return { kind: "auto_allow", reason: "all paths inside workdir (non-strict)" };
    }
    return { kind: "ask" };
  }

  return { kind: "ask" };
}

function collectChangedPaths(params: any): string[] {
  const out: string[] = [];
  const pushIfStr = (x: unknown) => { if (typeof x === "string" && x.length > 0 && x.length < 1024) out.push(x); };
  pushIfStr(params?.path);
  if (Array.isArray(params?.changes)) { for (const c of params.changes) { pushIfStr(c?.path); pushIfStr(c?.target); } }
  if (Array.isArray(params?.files)) { for (const f of params.files) pushIfStr(f?.path ?? f); }
  if (typeof params?.patch === "string") {
    for (const line of params.patch.split("\n")) {
      const m = line.match(/^\+\+\+\s+b\/(.*)$/);
      if (m) out.push(m[1]);
    }
  }
  return Array.from(new Set(out));
}

const GLOBAL_POLICY_PATH = join(homedir(), ".tako", "agent-policy.json");

function policyPath(sid: string): string {
  return join(sessionDir(sid), "policy.json");
}

async function readJsonSafe(path: string): Promise<Policy | null> {
  try { return JSON.parse(await readFile(path, "utf-8")) as Policy; }
  catch { return null; }
}

export async function loadPolicy(sid: string): Promise<Policy> {
  const global_ = await readJsonSafe(GLOBAL_POLICY_PATH);
  const session = await readJsonSafe(policyPath(sid));
  return mergePolicy(mergePolicy(DEFAULT_POLICY, global_), session);
}

function mergePolicy(base: Policy, over: Policy | null): Policy {
  if (!over) return base;
  return {
    exec_allow: [...(base.exec_allow ?? []), ...(over.exec_allow ?? [])],
    exec_deny: [...(base.exec_deny ?? []), ...(over.exec_deny ?? [])],
    file_allow: [...(base.file_allow ?? []), ...(over.file_allow ?? [])],
    file_deny: [...(base.file_deny ?? []), ...(over.file_deny ?? [])],
    strict_workdir: over.strict_workdir ?? base.strict_workdir,
  };
}

export async function readSessionPolicyOverride(sid: string): Promise<Policy> {
  return (await readJsonSafe(policyPath(sid))) ?? {};
}

export async function writeSessionPolicyOverride(sid: string, p: Policy): Promise<void> {
  await writeFile(policyPath(sid), JSON.stringify(p, null, 2), "utf-8");
}

export async function appendSessionExecAllow(sid: string, regex: string): Promise<void> {
  const p = await readSessionPolicyOverride(sid);
  const list = p.exec_allow ?? [];
  if (!list.includes(regex)) list.push(regex);
  p.exec_allow = list;
  await writeSessionPolicyOverride(sid, p);
}
