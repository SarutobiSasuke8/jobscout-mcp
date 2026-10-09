import { companyFromToken, isoDate, salaryInterval } from "./ats.js";
import { booleanValue, numberValue, plainText, record, textValue } from "./helpers.js";

import type { AtsBoard, AtsVendor, BoardParseResult } from "./ats.js";
import type { UnknownRecord } from "./helpers.js";

export const defaultAshbyApiBase = "https://api.ashbyhq.com/posting-api/job-board";

const employmentTypes = new Map([
  ["FullTime", "full-time"],
  ["PartTime", "part-time"],
  ["Intern", "internship"],
  ["Contract", "contract"],
  ["Temporary", "temporary"],
]);

/**
 * Ashby states a workplace type and, separately, whether any of the posting's locations is
 * remote. A hybrid role with a remote secondary location is open to remote applicants, so
 * either signal marks it remote; an explicit on-site with no remote location does not.
 */
function remote(posting: UnknownRecord): boolean | undefined {
  const workplace = textValue(posting, ["workplaceType"]);
  const isRemote = booleanValue(posting, ["isRemote"]);
  if (workplace === "Remote" || isRemote === true) return true;
  if (isRemote === false || workplace === "OnSite" || workplace === "Hybrid") return false;
  return undefined;
}

function location(posting: UnknownRecord): string | undefined {
  const primary = textValue(posting, ["location"]);
  const secondary = Array.isArray(posting.secondaryLocations)
    ? posting.secondaryLocations.map(record).map((item) => (item ? textValue(item, ["location"]) : undefined))
    : [];
  const all = [...new Set([primary, ...secondary].filter((item): item is string => Boolean(item)))];
  return all.length ? all.join("; ") : undefined;
}

/** Salary from the summary components; equity and other component types are not pay ranges. */
function salary(posting: UnknownRecord): UnknownRecord {
  const components = record(posting.compensation)?.summaryComponents;
  if (!Array.isArray(components)) return {};
  for (const entry of components) {
    const component = record(entry);
    if (!component || textValue(component, ["compensationType"]) !== "Salary") continue;
    const min = numberValue(component, ["minValue"]);
    const max = numberValue(component, ["maxValue"]);
    if (min === undefined && max === undefined) continue;
    const currency = textValue(component, ["currencyCode"]);
    const interval = salaryInterval(component.interval);
    return {
      ...(min !== undefined ? { salary_min: min } : {}),
      ...(max !== undefined ? { salary_max: max } : {}),
      ...(currency ? { salary_currency: currency } : {}),
      ...(interval ? { salary_interval: interval } : {}),
    };
  }
  return {};
}

function toSourceRecord(posting: UnknownRecord, board: AtsBoard): UnknownRecord | undefined {
  const title = textValue(posting, ["title"]);
  const url = textValue(posting, ["jobUrl"]);
  const id = textValue(posting, ["id"]);
  if (!title || !url || !id) return undefined;

  const where = location(posting);
  const text = textValue(posting, ["descriptionPlain"]) ?? plainText(textValue(posting, ["descriptionHtml"]) ?? "");
  const type = textValue(posting, ["employmentType"]);
  const isRemote = remote(posting);
  const posted = isoDate(posting.publishedAt);
  return {
    title: plainText(title),
    // The posting API does not name the employer; the operator's label or the board name stands in.
    company: board.company ?? companyFromToken(board.token),
    location: where ? plainText(where) : "Unknown",
    ...(isRemote === undefined ? {} : { is_remote: isRemote }),
    url,
    canonical_url: url,
    id,
    ...(text ? { description: text } : {}),
    ...(posted ? { date_posted: posted } : {}),
    ...(type ? { employment_type: employmentTypes.get(type) ?? type } : {}),
    tags: [textValue(posting, ["department"]), textValue(posting, ["team"])].filter((tag): tag is string => Boolean(tag)),
    ...salary(posting),
  };
}

/**
 * Parse `GET /posting-api/job-board/{board}?includeCompensation=true`. Postings marked
 * `isListed: false` are deliberately hidden by the employer and are skipped, not counted as
 * rejections: that counter exists to signal shape drift.
 */
export function parseAshbyBoard(payload: unknown, board: AtsBoard): BoardParseResult {
  const jobs = record(payload)?.jobs;
  if (!Array.isArray(jobs)) throw new Error(`Ashby board "${board.token}" returned an unexpected payload shape; expected { jobs: [...] }.`);
  const records: UnknownRecord[] = [];
  let rejected = 0;
  for (const entry of jobs) {
    const posting = record(entry);
    if (posting && posting.isListed === false) continue;
    const source = posting ? toSourceRecord(posting, board) : undefined;
    if (source) records.push(source);
    else rejected += 1;
  }
  return { records, rejected };
}

export const ashbyVendor: AtsVendor = {
  id: "ashby",
  label: "Ashby",
  enableVariable: "JOBSCOUT_ENABLE_ASHBY",
  boardsVariable: "ASHBY_BOARDS",
  baseVariable: "ASHBY_API_BASE",
  termsUrl: "https://developers.ashbyhq.com/docs/public-job-posting-api",
  boardUrl: (base, token) => `${base.replace(/\/+$/u, "")}/${encodeURIComponent(token)}?includeCompensation=true`,
  parseBoard: parseAshbyBoard,
};
