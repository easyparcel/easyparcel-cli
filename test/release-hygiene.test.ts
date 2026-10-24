import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { CLI_VERSION } from "../src/core/version";

const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const MANIFESTS = ["deploy/k8s/deployment.yaml", "deploy/k8s/chatgpt-deployment.yaml", "deploy/k8s/claude-deployment.yaml"];

function semver(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return m.slice(1).map(Number);
}

function compare(a: string, b: string): number {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

describe("release hygiene", () => {
  it("CLI_VERSION matches package.json and both package-lock root entries", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version: string }> };
    expect(pkg.version).toBe(CLI_VERSION);
    expect(lock.version).toBe(CLI_VERSION);
    expect(lock.packages[""]?.version).toBe(CLI_VERSION);
  });

  // This tree logs the EP_MCP_ALLOWED_OPERATIONS startup warning, which deploy/README.md says
  // ships in a later image than the one already in ACR, so the tree must not keep the old label.
  it("CLI_VERSION is at least the image the deploy docs say carries the startup warning", () => {
    const since = /strands all-accounts sign-ins shows up in the pod log \(image (\d+\.\d+\.\d+) and later\)/.exec(read("deploy/README.md"))?.[1];
    expect(since).toBeDefined();
    expect(compare(CLI_VERSION, since!)).toBeGreaterThanOrEqual(0);
  });

  // The manifests follow a tag only after it is pushed and rolled out, so they may lag the
  // source version but never lead it, and all three brokers plus the kustomization agree.
  it("every broker manifest pins the kustomization tag, never ahead of CLI_VERSION", () => {
    const newTag = /newTag:\s*"([^"]+)"/.exec(read("deploy/k8s/kustomization.yaml"))?.[1];
    expect(newTag).toBeDefined();
    for (const file of MANIFESTS) {
      const tag = /image:\s*\S+\/easyparcel-mcp:(\S+)/.exec(read(file))?.[1];
      expect(tag, file).toBe(newTag);
    }
    expect(compare(newTag!, CLI_VERSION)).toBeLessThanOrEqual(0);
  });

  it("build docs never name a fixed image tag, and manifest headers send live changes to set env / set image", () => {
    for (const file of ["Dockerfile", "deploy/README.md"]) {
      const dockerLines = read(file).split("\n").filter((l) => /docker (build|push|run)\b/.test(l));
      expect(dockerLines.length, file).toBeGreaterThan(0);
      for (const line of dockerLines) expect(line, file).not.toMatch(/easyparcel-mcp:\d/);
    }
    expect(read("deploy/README.md")).toMatch(/^## Changing a live deployment$/m);
    for (const file of ["deploy/k8s/chatgpt-deployment.yaml", "deploy/k8s/claude-deployment.yaml"]) {
      const lines = read(file).split("\n");
      const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("#"))).join("\n");
      expect(header, file).toMatch(/First deploy only:/);
      expect(header, file).toMatch(/"Changing a live deployment"/);
      expect(header, file).not.toMatch(/Apply with:/);
    }
  });
});
