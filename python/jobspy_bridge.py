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

    kwargs = {
        "site_name": request.get("site_name", ["indeed", "linkedin", "glassdoor", "google"]),
        "search_term": request["search_term"],
        "location": request.get("location"),
        "results_wanted": min(int(request.get("results_wanted", 25)), 100),
        "is_remote": bool(request.get("is_remote", False)),
        "country_indeed": request.get("country_indeed", "Ireland"),
        "verbose": 0,
    }
    if request.get("hours_old") is not None:
        kwargs["hours_old"] = int(request["hours_old"])

    jobs = scrape_jobs(**kwargs)
    json.dump({"jobs": jobs.where(jobs.notna(), None).to_dict(orient="records")}, sys.stdout, default=str)


if __name__ == "__main__":
    main()
