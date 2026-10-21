# JobScout Discover listing assets

Review assets for issue [#41](https://github.com/SarutobiSasuke8/jobscout-mcp/issues/41). Nothing has been uploaded or submitted to the directory.

| Asset | Dimensions | Use |
|---|---|---|
| `icon.png` | 512 × 512 | Composer icon |
| `logo.png` | 512 × 512 | Primary listing icon, using the same square mark |
| `screenshot-sources.png` | 1600 × 1000 | Enabled providers returned by `jobscout_list_sources` |
| `screenshot-search.png` | 1600 × 1000 | 3 actual records returned by `jobscout_search_jobs` |
| `screenshot-briefing.png` | 1600 × 1000 | `jobscout_briefing` applied to those same records |

`jobscout-mark.svg` is the editable source for the PNG marks, drawn for this package with native SVG geometry. It contains a briefcase and search lens, with no external fonts or stock assets. Both PNGs retain transparent corners. The mark is proposed for review with this PR.

The [official submission guide](https://developers.openai.com/plugins/deploy/submission), checked on 21 October 2026, requires square icons and logos at least 48 px, raster dimensions no larger than 4096 px, and files no larger than 5 MiB. It accepts PNG and uses plugin-relative paths beginning with `./`. These exports satisfy those bounds. The guide does not prescribe one exact PNG size or screenshot aspect ratio; 512 px marks and 1600 × 1000 screenshots are package choices, not portal mandates.

## Capture evidence

The screenshots were captured in headless Chrome at device scale 1 from the checked-in HTML evidence views. They are labelled **Actual MCP output · local capture view**. They show a presentation of real tool responses, rather than a screenshot of ChatGPT, an approved directory listing or a deployed JobScout website.

- Server source: JobScout main commit `3bc1356` (21 October 2026).
- Capture time: `2026-10-21T09:31:59.420Z`.
- Transport: local stdio JSON-RPC, including MCP initialisation and actual `tools/call` requests.
- Enabled public sources: We Work Remotely RSS and RemoteOK JSON. No login, provider token, CV or personal search profile was used.
- Query: `engineer`, `remote_only: true`, `limit: 3`, `include_descriptions: false`, sources `weworkremotely` and `remoteok`.
- Both providers were queried, with 0 failures, 0 warnings and 0 rejected records. The 3 returned records in this capture came from We Work Remotely. The display does not imply that each title contains the query term or that every source contributed a result.
- The sources view displays only the 2 enabled source rows and says so. Search and briefing views display selected returned fields without rewriting their values. Full results and exact request arguments are retained below.
- Job text is third-party, untrusted data. Listings can expire. The links are attributed discovery pages, not verified employer routes; the briefing screenshot retains the returned `discovery` link type.

Raw requests and results: [2026-10-21-tool-capture.json](../../../docs/discover/evidence/2026-10-21-tool-capture.json).

Self-contained render sources: [sources](../../../docs/discover/evidence/2026-10-21-sources.html), [search](../../../docs/discover/evidence/2026-10-21-search.html), [briefing](../../../docs/discover/evidence/2026-10-21-briefing.html). Open a view in a browser at 1600 × 1000 and device scale 1 to recapture it. The views have no scripts, external resources, forms or network calls; text is HTML-escaped. Recapturing the stored views makes no provider requests. A fresh live capture may return different jobs.

Passing `npm run check:plugin` checks package structure. It does not clear the independent hosting, identity, legal or operator submission gaps in [the Discover checklist](../../../docs/discover/README.md).
