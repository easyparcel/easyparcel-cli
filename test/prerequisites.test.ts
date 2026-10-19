import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATIONS, getOperation, prerequisitesOf, prerequisiteLines, mcpPrerequisiteText, targetScope } from "../src/operations";
import type { JSONSchema, Operation } from "../src/operations/types";
import { buildLongHelp } from "../src/cli/global";
import { describePrerequisites } from "../src/cli/describe";
import { toolDescription } from "../src/mcp/server";
import { matchPrerequisite, prerequisiteHint } from "../src/cli/hints";
import { collectItemErrors } from "../src/core/envelope";
import { buildContext } from "../src/core/context";
import { ExitCode, exitCodeForStatus } from "../src/core/errors";
import { friendlyError, ignoredTargetFlag, reportEnvelope } from "../src/cli/run";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-prereq-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  for (const k of ["EASYPARCEL_ACCOUNT_ID", "EASYPARCEL_ORGANIZATION_ID", "EASYPARCEL_ACCESS_TOKEN", "EASYPARCEL_TOKEN"]) delete process.env[k];
});
afterAll(() => {
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Resolve a dotted param path ("shipment[].sender.point_code") through a JSON schema. */
function schemaHas(schema: JSONSchema | undefined, param: string): boolean {
  let node: any = schema;
  for (const raw of param.split(".")) {
    const arrayHop = raw.endsWith("[]");
    const key = arrayHop ? raw.slice(0, -2) : raw;
    node = node?.properties?.[key];
    if (!node) return false;
    if (arrayHop) {
      if (node.type !== "array" || !node.items) return false;
      node = node.items;
    }
  }
  return true;
}

const ids = new Set(OPERATIONS.map((o) => o.id));

describe("prerequisite graph integrity", () => {
  it("operation ids are unique", () => {
    expect(ids.size).toBe(OPERATIONS.length);
  });

  for (const op of OPERATIONS) {
    it(`${op.id}: every edge points at a real operation, a real param and a provided field`, () => {
      for (const e of prerequisitesOf(op)) {
        expect(ids.has(e.from), `${op.id} ← ${e.from}`).toBe(true);
        expect(e.from, `${op.id} depends on itself`).not.toBe(op.id);
        if (e.param !== "account_id" && e.param !== "organization_id") {
          expect(schemaHas(op.schema, e.param), `${op.id}: '${e.param}' is not in its schema`).toBe(true);
        }
        if (e.field) {
          const from = getOperation(e.from)!;
          expect(from.provides ?? [], `${e.from} does not list '${e.field}' in provides`).toContain(e.field);
        }
      }
    });
  }

  it("every account-scoped operation gets the account_id ← account.list edge; listings get none", () => {
    for (const op of OPERATIONS) {
      const target = prerequisitesOf(op).filter((e) => e.param === "account_id");
      if (targetScope(op) === "account") expect(target, op.id).toHaveLength(1);
      else expect(target, op.id).toHaveLength(0);
    }
    expect(prerequisitesOf(getOperation("account.list")!)).toEqual([]);
  });

  it("carries the expected core edges", () => {
    const edge = (id: string, param: string) => prerequisitesOf(getOperation(id)!).filter((e) => e.param === param).map((e) => e.from);
    expect(edge("shipment.submit", "shipment[].service_id")).toEqual(["shipment.quote"]);
    expect(edge("shipment.track", "awb_numbers")).toEqual(["shipment.list", "shipment.submit", "shipment.details"]);
    expect(edge("shipment.cancel", "cancel_list[].shipment_number")).toEqual(["shipment.list", "shipment.submit"]);
    expect(edge("shipment.insurance-quote", "list[].courier_service_id")).toEqual(["shipment.quote"]);
    // API 2026-03 ignores a caller's insurance[]: EasyCover is requested with the feature flag
    expect(edge("shipment.submit", "shipment[].insurance[].insurance_service_id")).toEqual([]);
    expect(edge("shipment.submit", "shipment[].feature.add_on_easy_cover")).toEqual(["shipment.insurance-quote"]);
    expect(edge("shipment.details", "shipment_number")).toContain("shipment.list");
    expect(edge("ondemand.order", "metadata.quotationId")).toEqual(["ondemand.quote"]);
    expect(edge("ondemand.cancel", "booking_id")).toContain("ondemand.list");
    expect(edge("ondemand.details", "booking_id")).toContain("ondemand.list");
    expect(edge("shipment.bulk-awbs", "awb")).toContain("shipment.list");
    expect(edge("courier.dropoff-points", "courier_id")).toContain("courier.list");
  });
});

describe("prerequisites on every surface", () => {
  const submit = getOperation("shipment.submit")!;

  it("command help has a 'Before you call this' section, one line per edge", () => {
    const help = buildLongHelp(submit);
    expect(help).toContain("Before you call this");
    expect(help).toMatch(/shipment\[\]\.service_id\s+← ep shipment quote\s+\(\[\]\.quotations\[\]\.courier\.service_id\)/);
    expect(help).toMatch(/account_id\s+← ep account list/);
    expect(prerequisiteLines(submit)).toHaveLength(prerequisitesOf(submit).length);
    // an operation with no edges gets no section
    expect(buildLongHelp(getOperation("account.list")!)).not.toContain("Before you call this");
  });

  it("MCP tool descriptions end with the prerequisites sentence", () => {
    const text = toolDescription(submit);
    expect(text).toContain("Prerequisites: shipment[].service_id from ep_shipment_quote ([].quotations[].courier.service_id)");
    expect(text).toContain("account_id from ep_account_list ([].account_id) when the login covers all your accounts");
    expect(mcpPrerequisiteText(getOperation("organization.list")!)).toBeUndefined();
  });

  it("ep describe lists the edges with the source command and tool", () => {
    const d = describePrerequisites(submit);
    expect(d[0]).toMatchObject({ param: "shipment[].service_id", from: "shipment.quote", from_command: "ep shipment quote", from_mcp_tool: "ep_shipment_quote" });
  });
});

describe("error hints", () => {
  const env = (status: number, message: string, data: unknown = null) => ({ status_code: status, message, data });
  /** submit_orders 2026-03: HTTP 200, failures nested at data[0].shipments[] with the request echoed. */
  const submitFailure = (errors: string[]) => ({
    status_code: 200,
    message: "0 requests success, 1 request error.",
    data: [
      {
        order_details: { account_id: 187874 },
        pricing: { currency_code: "MYR", total_amount: "0.00", total_tax_amount: "0.00" },
        shipments: [
          {
            status: "error",
            collection_date: "2026-10-21",
            sender: { point_code: null, name: "Alice", address1: "1 Jln A", postcode: "11950", country_code: "MY" },
            receiver: { point_code: null, name: "Bob", address1: "2 Jln B", postcode: "55100", country_code: "MY" },
            errors,
          },
        ],
      },
    ],
  });
  const submit = getOperation("shipment.submit")!;

  it("names the source of a param the error mentions (validator writes field names with spaces)", () => {
    const e = submitFailure(["The service id field is required."]);
    expect(prerequisiteHint(submit, e)).toBe("hint: service_id comes from `ep shipment quote` — run that first.");
    expect(prerequisiteHint(submit, e, "mcp")).toContain("ep_shipment_quote");
    expect(prerequisiteHint(getOperation("shipment.details")!, env(400, "No Order with shipment_number ES-1 found from this account"))).toContain("ep shipment list");
    expect(prerequisiteHint(getOperation("shipment.bulk-awbs")!, env(400, "Awb not found"))).toContain("ep shipment list");
    expect(prerequisiteHint(getOperation("shipment.details")!, env(400, "Missing Required Param;", { shipment_number: ["The shipment number field is required."] }))).toContain(
      "ep shipment list",
    );
  });

  it("collects the nested submit errors as item errors", () => {
    const items = collectItemErrors(submitFailure(["Insufficient credit"]));
    expect(items).toEqual([expect.objectContaining({ index: 0, label: "0.shipments[0]", status: "error", errors: ["Insufficient credit"] })]);
  });

  it("never matches keys of an echoed request object", () => {
    // every failed shipment echoes sender.point_code / receiver: no drop-off or address hint
    expect(prerequisiteHint(submit, submitFailure(["Insufficient credit"]))).toBeUndefined();
  });

  it("skips hint:false and field-less edges", () => {
    expect(prerequisiteHint(submit, submitFailure(["The receiver name field is required."]))).toBeUndefined();
    const einvoice = getOperation("einvoice.submit")!;
    expect(prerequisiteHint(einvoice, env(400, "Invalid input Error", ["The tin no field is required."]))).toBeUndefined();
    expect(buildLongHelp(einvoice)).toMatch(/tin_no\s+← run ep einvoice verify-access first/);
    expect(toolDescription(einvoice)).toContain("tin_no: call ep_einvoice_verify_access first");
  });

  it("does not match a longer field name, other statuses, or the target params", () => {
    const order = getOperation("ondemand.order")!;
    expect(matchPrerequisite(order, env(400, "The ondemand_service_id field is required"))?.param).toBe("ondemand_service_id");
    expect(prerequisiteHint(submit, env(400, "The ondemand_service_id is bad"))).toBeUndefined();
    expect(prerequisiteHint(submit, env(500, "service_id broke"))).toBeUndefined();
    expect(prerequisiteHint(getOperation("account.wallet")!, env(400, "account_id required"))).toBeUndefined();
  });
});

describe("exit codes and friendly errors", () => {
  it("403 maps to FORBIDDEN (9), 401 stays AUTH (3)", () => {
    expect(ExitCode.FORBIDDEN).toBe(9);
    expect(exitCodeForStatus(403)).toBe(9);
    expect(exitCodeForStatus(401)).toBe(3);
  });

  it("formats one line with the server message, details and code", () => {
    expect(friendlyError({ status_code: 400, message: "Invalid input Error", data: ["a is required", "b is required"] })).toBe(
      "Invalid input Error: a is required; b is required (400)",
    );
    expect(friendlyError({ status_code: 403, code: "ACCOUNT_FORBIDDEN", message: "nope", data: null } as any)).toBe("nope (ACCOUNT_FORBIDDEN)");
    expect(friendlyError({ status_code: 400, message: "Missing Required Param;", data: { shipment_number: ["The shipment number field is required."] } })).toBe(
      "Missing Required Param: The shipment number field is required. (400)",
    );
  });

  function capture(fn: () => void): { out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c: any) => (out.push(String(c)), true));
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: any) => (err.push(String(c)), true));
    try {
      fn();
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    return { out: out.join(""), err: err.join("") };
  }

  it("on a terminal: friendly line + hint on stderr, nothing on stdout; with --format json: envelope on stdout", () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const prev = process.exitCode;
    try {
      const op = getOperation("shipment.submit")!;
      const failure = { status_code: 400, message: "Invalid input Error", data: ["The shipment 0 service_id field is required."] };
      const human = capture(() => reportEnvelope(buildContext({}), failure, undefined, op));
      expect(human.out).toBe("");
      expect(human.err).toContain("error: Invalid input Error: The shipment 0 service_id field is required. (400)\n");
      expect(human.err).toContain("hint: service_id comes from `ep shipment quote` — run that first.\n");
      expect(process.exitCode).toBe(ExitCode.VALIDATION);
      const machine = capture(() => reportEnvelope(buildContext({ format: "json" }), failure, undefined, op));
      expect(JSON.parse(machine.out)).toMatchObject({ status_code: 400 });
      // the chosen format is kept: ndjson stays one compact line
      const nd = capture(() => reportEnvelope(buildContext({ format: "ndjson" }), failure, undefined, op));
      expect(nd.out).toBe('"The shipment 0 service_id field is required."\n');
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as any).isTTY;
      process.exitCode = prev;
    }
  });
});

describe("ignored target flags", () => {
  it("--organization on an account-scoped call is not sent and names the account that answered", () => {
    const ctx = buildContext({ quiet: true, account: "123456", organization: "ABCDEF" });
    const { ctx: callCtx, warn } = ignoredTargetFlag(ctx, getOperation("account.wallet")!);
    expect(callCtx.organizationId).toBeUndefined();
    expect(callCtx.accountId).toBe("123456");
    expect(warn!({ status_code: 200, data: {} })).toBe(
      "--organization ABCDEF is ignored by `ep account wallet` (it acts on a shipping account); answered by account 123456.",
    );
    expect(warn!({ status_code: 400, data: null })).toContain("it was not sent");
  });

  it("--account on an organization-scoped call is not sent", () => {
    const orgOp: Operation = { ...getOperation("account.wallet")!, id: "x.org", scope: "organization" };
    const ctx = buildContext({ quiet: true, account: "123456", organization: "ABCDEF" });
    const { ctx: callCtx, warn } = ignoredTargetFlag(ctx, orgOp);
    expect(callCtx.accountId).toBeUndefined();
    expect(warn!({ status_code: 200, data: {} })).toContain("answered by organization ABCDEF");
  });

  it("leaves profile / env targets and matching flags alone", () => {
    const ctx = buildContext({ quiet: true, account: "123456" });
    expect(ignoredTargetFlag(ctx, getOperation("account.wallet")!).warn).toBeUndefined();
  });
});
