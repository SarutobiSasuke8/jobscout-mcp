"""Small stdin/stdout bridge to the optional MIT-licensed python-jobspy package."""

from __future__ import annotations

import json
import sys


def main() -> None:
    request = json.load(sys.stdin)
    try:
        from jobspy import scrape_jobs
    except ImportError as exc:
        raise SystemExit("python-jobspy is not installed") from exc

    # The caller always supplies site_name (see src/providers/jobspy.ts). The fallback here is a
    # single, least contentious source rather than every board python-jobspy supports: enabling
    # this bridge sends automated requests from the operator's own machine, so the default must
    # be the conservative one and any wider set must be an explicit choice.
    kwargs = {
        "site_name": request.get("site_name", ["indeed"]),
        "search_term": request["search_term"],
        "location": request.get("location"),
        "results_wanted": min(int(request.get("results_wanted", 25)), 100),
        "is_remote": bool(request.get("is_remote", False)),
        "verbose": 0,
    }
    # No country default. Indeed is country-scoped, and hard-coding one publisher's country
    # silently pins every user's search to it. Absent an explicit JOBSPY_COUNTRY, defer to the
    # python-jobspy library default rather than inventing one here.
    if request.get("country_indeed") is not None:
        kwargs["country_indeed"] = request["country_indeed"]
    if request.get("hours_old") is not None:
        kwargs["hours_old"] = int(request["hours_old"])

    jobs = scrape_jobs(**kwargs)
    json.dump({"jobs": jobs.where(jobs.notna(), None).to_dict(orient="records")}, sys.stdout, default=str)


if __name__ == "__main__":
    main()
