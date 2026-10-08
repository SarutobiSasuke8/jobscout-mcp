import { companyFromToken, isoDate, salaryInterval } from "./ats.js";
import { numberValue, plainText, record, stringArrayValue, textValue } from "./helpers.js";

import type { AtsBoard, AtsVendor, BoardParseResult } from "./ats.js";
import type { UnknownRecord } from "./helpers.js";

/** Lever hosts EU customers separately; set LEVER_API_BASE to https://api.eu.lever.co/v0/postings for those. */
export const defaultLeverApiBase = "https://api.lever.co/v0/postings";

/** `workplaceType` is the only first-party remote signal. Hybrid is not remote. */
function remote(value: string | undefined): boolean | undefined {
  if (value === "remote") return true;
  if (value === "onsite" || value === "hybrid") return false;
  return undefined;
}

function location(categories: UnknownRecord): string | undefined {
  const all = stringArrayValue(categories, ["allLocations"]);
  if (all.length) return all.join("; ");
  return textValue(categories, ["location"]);
}

function salary(posting: UnknownRecord): UnknownRecord {
  const range = record(posting.salaryRange);
  if (!range) return {};
  const min = numberValue(range, ["min"]);
  const max = numberValue(range, ["max"]);
  const currency = textValue(range, ["currency"]);
  const interval = salaryInterval(range.interval);
  return {
    ...(min !== undefined ? { salary_min: min } : {}),
    ...(max !== undefined ? { salary_max: max } : {}),
    ...(currency ? { salary_currency: currency } : {}),
    ...(interval ? { salary_interval: interval } : {}),
  };
}

function toSourceRecord(posting: UnknownRecord, board: AtsBoard): UnknownRecord | undefined {
  const title = textValue(posting, ["text"]);
  const url = textValue(posting, ["hostedUrl"]);
  const id = textValue(posting, ["id"]);
  if (!title || !url || !id) return undefined;

  const categories = record(posting.categories) ?? {};
  const where = location(categories);
  const text = textValue(posting, ["descriptionPlain"]) ?? plainText(textValue(posting, ["description"]) ?? "");
  const commitment = textValue(categories, ["commitment"]);
  const isRemote = remote(textValue(posting, ["workplaceType"]));
  const posted = isoDate(posting.createdAt);
  return {
    title: plainText(title),
    // Lever postings do not name the employer; the operator's label or the site token stands in.
    company: board.company ?? companyFromToken(board.token),
    location: where ? plainText(where) : "Unknown",
    ...(isRemote === undefined ? {} : { is_remote: isRemote }),
    url,
    canonical_url: url,
    id,
    ...(text ? { description: text } : {}),
    ...(posted ? { date_posted: posted } : {}),
    ...(commitment ? { employment_type: commitment } : {}),
    tags: [textValue(categories, ["team"]), textValue(categories, ["department"])].filter((tag): tag is string => Boolean(tag)),
    ...salary(posting),
  };
}

/**
 * Parse `GET /v0/postings/{site}?mode=json`, which returns a bare array of postings. Lever
 * answers an unknown site with `{ ok: false, error }` and a 404, which never reaches here.
 */
export function parseLeverBoard(payload: unknown, board: AtsBoard): BoardParseResult {
  if (!Array.isArray(payload)) throw new Error(`Lever site "${board.token}" returned an unexpected payload shape; expected an array of postings.`);
  const records: UnknownRecord[] = [];
  let rejected = 0;
  for (const entry of payload) {
    const posting = record(entry);
    const source = posting ? toSourceRecord(posting, board) : undefined;
    if (source) records.push(source);
    else rejected += 1;
  }
  return { records, rejected };
}

export const leverVendor: AtsVendor = {
  id: "lever",
  label: "Lever",
  enableVariable: "JOBSCOUT_ENABLE_LEVER",
  boardsVariable: "LEVER_SITES",
  baseVariable: "LEVER_API_BASE",
  termsUrl: "https://github.com/lever/postings-api",
  boardUrl: (base, token) => `${base.replace(/\/+$/u, "")}/${encodeURIComponent(token)}?mode=json`,
  parseBoard: parseLeverBoard,
};
