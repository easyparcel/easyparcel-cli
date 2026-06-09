import { Command } from "commander";
import { getContext, type RuntimeContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { getOperation } from "../operations";
import { executeOperation, reportEnvelope, runOperation } from "./run";
import { CliError, ExitCode } from "../core/errors";

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Default to table output for shortcuts unless the user set --format explicitly. */
function humanCtx(ctx: RuntimeContext): RuntimeContext {
  return ctx.formatExplicit ? ctx : { ...ctx, format: "table" };
}

function buildAddress(prefix: "sender" | "receiver", o: Record<string, any>): Record<string, unknown> {
  return {
    name: o[`${prefix}Name`],
    phone_number_country_code: o[`${prefix}PhoneCc`] || "MY",
    phone_number: o[`${prefix}Phone`],
    email: o[`${prefix}Email`],
    address_1: o[`${prefix}Address`],
    city: o[`${prefix}City`],
    postcode: o[`${prefix}Postcode`],
    subdivision_code: o[`${prefix}State`],
    country_code: o[`${prefix}Country`] || "MY",
  };
}

async function ratesAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const op = getOperation("shipment.quote")!;
  if (!opts.from || !opts.to || num(opts.weight) === undefined) {
    throw new CliError("`+rates` requires --from <postcode> --to <postcode> --weight <kg>.", ExitCode.USAGE);
  }
  const body = {
    shipment: [
      {
        sender: {
          postcode: String(opts.from),
          country: opts.fromCountry || "MY",
          ...(opts.fromState ? { subdivision_code: opts.fromState } : {}),
        },
        receiver: {
          postcode: String(opts.to),
          country: opts.toCountry || "MY",
          ...(opts.toState ? { subdivision_code: opts.toState } : {}),
        },
        weight: num(opts.weight),
        ...(num(opts.width) !== undefined ? { width: num(opts.width) } : {}),
        ...(num(opts.height) !== undefined ? { height: num(opts.height) } : {}),
        ...(num(opts.length) !== undefined ? { length: num(opts.length) } : {}),
        ...(num(opts.value) !== undefined ? { parcel_value: num(opts.value) } : {}),
      },
    ],
  };
  const env = await executeOperation(ctx, op, { body });
  const first = Array.isArray(env.data) ? (env.data[0] as any) : undefined;
  const quotations = first?.quotations;
  if (!Array.isArray(quotations)) {
    reportEnvelope(ctx, env);
    return;
  }
  const rows = quotations.map((q: any) => ({
    service_id: q.courier?.service_id,
    courier: q.courier?.courier_name,
    service: q.courier?.service_name,
    price: q.pricing?.total_amount,
    currency: q.pricing?.currency,
    delivery: q.courier?.delivery_duration ?? "",
    pickup: q.courier?.is_pickup,
    dropoff: q.courier?.is_dropoff,
  }));
  reportEnvelope(humanCtx(ctx), { ...env, data: rows }, [
    "service_id",
    "courier",
    "service",
    "price",
    "currency",
    "delivery",
  ]);
}

async function trackAction(awb: string[], _opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const op = getOperation("shipment.track")!;
  if (!awb || awb.length === 0) {
    throw new CliError("`+track` requires at least one AWB number.", ExitCode.USAGE);
  }
  const env = await executeOperation(ctx, op, { body: { awb_numbers: awb } });
  const results = (env.data as any)?.results ?? env.data;
  if (!Array.isArray(results)) {
    reportEnvelope(ctx, env);
    return;
  }
  const rows = results.map((r: any) => ({
    awb: r.awb_number,
    status: r.status,
    code: r.latest_shipment_status_code ?? "",
    latest: r.latest_tracking_status ?? r.message ?? "",
    updated: r.latest_event_date ?? "",
  }));
  reportEnvelope(humanCtx(ctx), { ...env, data: rows }, ["awb", "status", "code", "latest", "updated"]);
}

async function shipAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const op = getOperation("shipment.submit")!;
  const missing = [
    ["serviceId", "--service-id"],
    ["collectionDate", "--collection-date"],
    ["senderName", "--sender-name"],
    ["senderPhone", "--sender-phone"],
    ["senderAddress", "--sender-address"],
    ["senderPostcode", "--sender-postcode"],
    ["senderCity", "--sender-city"],
    ["receiverName", "--receiver-name"],
    ["receiverPhone", "--receiver-phone"],
    ["receiverAddress", "--receiver-address"],
    ["receiverPostcode", "--receiver-postcode"],
    ["receiverCity", "--receiver-city"],
  ].filter(([k]) => !opts[k as string]);
  if (missing.length || num(opts.weight) === undefined) {
    const flags = missing.map(([, f]) => f);
    if (num(opts.weight) === undefined) flags.push("--weight");
    throw new CliError(`\`+ship\` is missing required flags: ${flags.join(", ")}.`, ExitCode.USAGE);
  }
  const h = num(opts.height) ?? 10;
  const l = num(opts.length) ?? 10;
  const w = num(opts.width) ?? 10;
  const currency = opts.currency || "MYR";
  const body = {
    shipment: [
      {
        reference: opts.reference,
        service_id: opts.serviceId,
        collection_date: opts.collectionDate,
        weight: num(opts.weight),
        height: h,
        length: l,
        width: w,
        item: [
          {
            content: opts.content || "Parcel",
            weight: num(opts.weight),
            height: h,
            length: l,
            width: w,
            currency_code: currency,
            value: num(opts.value) ?? 0,
            quantity: num(opts.quantity) ?? 1,
          },
        ],
        sender: buildAddress("sender", opts),
        receiver: buildAddress("receiver", opts),
        feature:
          num(opts.cod) !== undefined ? { cod: { cod_amount: num(opts.cod), cod_currency: currency } } : {},
        ...(opts.dropoffPoint ? { collection_method: "dropoff", dropoff_point_id: opts.dropoffPoint } : {}),
        ...(opts.insuranceServiceId ? { insurance_service_id: opts.insuranceServiceId } : {}),
      },
    ],
  };
  await runOperation(ctx, op, { body });
}

/** Layer 1 — shortcuts with smart defaults, human + AI friendly. */
export function registerShortcuts(program: Command): void {
  const rates = program
    .command("+rates")
    .alias("+quote")
    .description("Quick rate check for a single parcel (shortcut)")
    .option("--from <postcode>", "Sender postcode")
    .option("--to <postcode>", "Receiver postcode")
    .option("--weight <kg>", "Parcel weight (kg)")
    .option("--from-country <iso2>", "Sender country (default MY)")
    .option("--to-country <iso2>", "Receiver country (default MY)")
    .option("--from-state <code>", "Sender state, ISO 3166-2 (e.g. MY-07)")
    .option("--to-state <code>", "Receiver state, ISO 3166-2")
    .option("--length <cm>", "Length (cm)")
    .option("--width <cm>", "Width (cm)")
    .option("--height <cm>", "Height (cm)")
    .option("--value <amount>", "Declared parcel value");
  addGlobalOptions(rates);
  rates.action(ratesAction);

  const track = program
    .command("+track")
    .argument("<awb...>", "One or more AWB numbers")
    .description("Quick tracking for one or more AWBs (shortcut)");
  addGlobalOptions(track);
  track.action(trackAction);

  const ship = program
    .command("+ship")
    .description("Create a single domestic/simple parcel order (shortcut). Use --dry-run to preview.")
    .option("--service-id <id>", "Courier service id from a quotation")
    .option("--collection-date <date>", "Collection date YYYY-MM-DD")
    .option("--weight <kg>", "Parcel weight (kg)")
    .option("--length <cm>", "Length (cm, default 10)")
    .option("--width <cm>", "Width (cm, default 10)")
    .option("--height <cm>", "Height (cm, default 10)")
    .option("--content <text>", "Item description (default 'Parcel')")
    .option("--value <amount>", "Item value (default 0)")
    .option("--quantity <n>", "Item quantity (default 1)")
    .option("--currency <code>", "Currency (default MYR)")
    .option("--reference <ref>", "Your reference")
    .option("--cod <amount>", "Enable COD for this amount")
    .option("--dropoff-point <id>", "Drop off instead of pickup (point id)")
    .option("--insurance-service-id <id>", "Insurance service id")
    .option("--sender-name <name>")
    .option("--sender-phone <number>")
    .option("--sender-phone-cc <iso2>", "Sender phone country (default MY)")
    .option("--sender-email <email>")
    .option("--sender-address <address>")
    .option("--sender-city <city>")
    .option("--sender-postcode <postcode>")
    .option("--sender-state <code>", "ISO 3166-2 e.g. MY-07")
    .option("--sender-country <iso2>", "Sender country (default MY)")
    .option("--receiver-name <name>")
    .option("--receiver-phone <number>")
    .option("--receiver-phone-cc <iso2>", "Receiver phone country (default MY)")
    .option("--receiver-email <email>")
    .option("--receiver-address <address>")
    .option("--receiver-city <city>")
    .option("--receiver-postcode <postcode>")
    .option("--receiver-state <code>", "ISO 3166-2")
    .option("--receiver-country <iso2>", "Receiver country (default MY)");
  addGlobalOptions(ship);
  ship.action(shipAction);

  const address = program
    .command("+address")
    .argument("[query...]", "Search keyword (omit to list recent)")
    .description("Search your saved address book (shortcut)")
    .option("--limit <n>", "Max results");
  addGlobalOptions(address);
  address.action(async (query: string[], opts: Record<string, any>) => {
    const ctx = getContext();
    const op = getOperation("address.search")!;
    const text = (query || []).join(" ").trim();
    const body: Record<string, unknown> = {};
    if (text) body.search = text;
    if (num(opts.limit) !== undefined) body.limit = num(opts.limit);
    const env = await executeOperation(ctx, op, { body: Object.keys(body).length ? body : undefined });
    const list = Array.isArray(env.data) ? (env.data as any[]) : [];
    const rows = list.map((a) => ({
      id: a.id,
      name: a.name,
      company: a.company_name,
      phone: a.phone_number,
      city: a.city,
      postcode: a.postcode,
      country: a.country_code,
    }));
    reportEnvelope(humanCtx(ctx), { ...env, data: rows }, ["id", "name", "company", "phone", "city", "postcode", "country"]);
  });
}
