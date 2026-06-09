import { type Operation, str, num, arr, obj } from "./types";

export const einvoiceOperations: Operation[] = [
  {
    id: "einvoice.verify-access",
    group: "einvoice",
    command: "verify-access",
    summary: "Verify MyInvois (LHDN) access before submitting e-invoices",
    description: "Malaysia e-Invoice. Must be enabled in the Developer Hub.",
    method: "POST",
    path: "einvoice/malaysia/verify_access",
    body: "json",
    bodyRequired: true,
    schema: obj(
      { tin_no: str(), id_no: str("BRN/NRIC/Passport/Army no."), id_type: str("NRIC | PASSPORT | BRN | ARMY") },
      ["tin_no", "id_no", "id_type"],
    ),
    example: { tin_no: "C1234567890", id_no: "201901000001", id_type: "BRN" },
  },
  {
    id: "einvoice.submit",
    group: "einvoice",
    command: "submit",
    summary: "Submit one or more Malaysia e-invoices to LHDN MyInvois (bulk)",
    description:
      "Times must be UTC; currency must be MYR. state_code is a 2-digit NUMERIC code (e.g. 07 for Penang) — different from the ISO 3166-2 codes used elsewhere.",
    method: "POST",
    path: "einvoice/malaysia/submit",
    mutating: true,
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        tin_no: str(),
        id_no: str(),
        id_type: str("NRIC | PASSPORT | BRN | ARMY"),
        sst_no: str(),
        company_name: str(),
        company_phone: str(),
        msic_code: str(),
        business_nature: str(),
        address_line_1: str(),
        city: str(),
        postcode: str(),
        state_code: str('2-digit numeric, e.g. "07"'),
        bulk: arr(
          obj(
            {
              invoice_no: str(),
              invoice_issue_date: str("YYYY-MM-DD (UTC)"),
              invoice_issue_time: str("HH:mm:ss (UTC)"),
              order_currency: str('Must be "MYR"'),
              total_discount_value: num(),
              items: arr(
                obj({ description: str(), quantity: num(), amount: num("pre-tax"), tax_amount: num() }, [
                  "description",
                  "quantity",
                  "amount",
                  "tax_amount",
                ]),
              ),
            },
            ["invoice_no", "invoice_issue_date", "invoice_issue_time", "order_currency", "items"],
          ),
        ),
      },
      ["tin_no", "id_no", "id_type", "company_name", "company_phone", "msic_code", "business_nature", "address_line_1", "city", "postcode", "state_code", "bulk"],
    ),
  },
];
