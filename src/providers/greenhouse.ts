import { companyFromToken, isoDate } from "./ats.js";
import { decodeEntities, plainText, record, textValue } from "./helpers.js";

import type { AtsBoard, AtsVendor, BoardParseResult } from "./ats.js";
import type { UnknownRecord } from "./helpers.js";

export const defaultGreenhouseApiBase = "https://boards-api.greenhouse.io/v1/boards";

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .map((item) => (item ? textValue(item, ["name"]) : undefined))
    .filter((name): name is string => Boolean(name));
}

/**
 * Greenhouse ships `content` as entity-escaped HTML (`&lt;p&gt;...`). The escaping is transport,
 * not prose, so it is undone once to recover the markup, and `plainText` then strips tags before
 * decoding what remains, as it does for every other source.
 */
function description(content: string | undefined): string | undefined {
  if (!content) return undefined;
  return plainText(decodeEntities(content)) || undefined;
}

function toSourceRecord(job: UnknownRecord, board: AtsBoard): UnknownRecord | undefined {
  const title = textValue(job, ["title"]);
  const url = textValue(job, ["absolute_url"]);
  const id = job.id;
  if (!title || !url || (typeof id !== "number" && typeof id !== "string")) return undefined;

  const location = textValue(record(job.location) ?? {}, ["name"]);
  const text = description(textValue(job, ["content"]));
  const posted = isoDate(job.first_published) ?? isoDate(job.updated_at);
  return {
    title: plainText(title),
    company: board.company ?? textValue(job, ["company_name"]) ?? companyFromToken(board.token),
    location: location ? plainText(location) : "Unknown",
    // Greenhouse has no workplace field. A location naming "remote" is the only signal; anything
    // else is left unknown rather than asserted on-site.
    ...(location && /\bremote\b/iu.test(location) ? { is_remote: true } : {}),
    url,
    canonical_url: url,
    id: String(id),
    ...(text ? { description: text } : {}),
    ...(posted ? { date_posted: posted } : {}),
    tags: names(job.departments),
  };
}

/**
 * Parse `GET /v1/boards/{token}/jobs?content=true`. The response is `{ jobs: [...], meta }`;
 * anything else is shape drift and fails the board rather than reporting an empty employer.
 */
export function parseGreenhouseBoard(payload: unknown, board: AtsBoard): BoardParseResult {
  const jobs = record(payload)?.jobs;
  if (!Array.isArray(jobs)) throw new Error(`Greenhouse board "${board.token}" returned an unexpected payload shape; expected { jobs: [...] }.`);
  const records: UnknownRecord[] = [];
  let rejected = 0;
  for (const entry of jobs) {
    const job = record(entry);
    const source = job ? toSourceRecord(job, board) : undefined;
    if (source) records.push(source);
    else rejected += 1;
  }
  return { records, rejected };
}

export const greenhouseVendor: AtsVendor = {
  id: "greenhouse",
  label: "Greenhouse",
  enableVariable: "JOBSCOUT_ENABLE_GREENHOUSE",
  boardsVariable: "GREENHOUSE_BOARDS",
  baseVariable: "GREENHOUSE_API_BASE",
  termsUrl: "https://developers.greenhouse.io/job-board.html",
  boardUrl: (base, token) => `${base.replace(/\/+$/u, "")}/${encodeURIComponent(token)}/jobs?content=true`,
  parseBoard: parseGreenhouseBoard,
};
