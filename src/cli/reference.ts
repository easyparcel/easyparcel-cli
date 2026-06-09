import { Command } from "commander";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { printEnvelope } from "../core/output";
import { printJson } from "../core/output";
import {
  MY_STATES,
  TRACKING_STATUS,
  WEBHOOK_STATUS,
  WEBHOOK_TOPICS,
  ID_PREFIXES,
  SUPPORTED_COURIER_COUNTRIES,
} from "../reference";
import type { Envelope } from "../core/types";

const TOPICS = ["states", "tracking-status", "webhook-status", "webhook-topics", "ids", "countries"] as const;

export function registerReference(program: Command): void {
  const ref = program
    .command("reference")
    .alias("ref")
    .argument("[topic]", `One of: ${TOPICS.join(", ")} (default: all)`)
    .description("Print reference data (state codes, status codes, ID prefixes)");

  addGlobalOptions(ref);

  ref.action((topic?: string) => {
    const ctx = getContext();
    const all = {
      states: MY_STATES,
      "tracking-status": TRACKING_STATUS,
      "webhook-status": WEBHOOK_STATUS,
      "webhook-topics": WEBHOOK_TOPICS,
      ids: ID_PREFIXES,
      countries: { supported_courier_countries: SUPPORTED_COURIER_COUNTRIES },
    } as const;

    if (!topic) {
      printJson(all);
      return;
    }
    const key = topic as (typeof TOPICS)[number];
    const data = (all as Record<string, unknown>)[key];
    if (data === undefined) {
      printJson({ error: `unknown topic '${topic}'`, topics: TOPICS });
      return;
    }
    // For 'states', a table reads nicely.
    if (key === "states") {
      const env: Envelope = { status_code: 200, data: MY_STATES };
      printEnvelope(env, { ...ctx, format: ctx.formatExplicit ? ctx.format : "table" });
      return;
    }
    printJson(data);
  });
}
