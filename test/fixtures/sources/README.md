# Source fixtures

Recorded-shape responses for every JobScout source adapter, used by `test/source-fixtures.test.ts` and `test/dedupe-edge-cases.test.ts`.

Every company, job, id and description here is invented. The response shapes follow each adapter's parsing code and the source's public API format, so a parser change that stops reading the real shape breaks these tests too. No real people, email addresses or employers appear, and the tests never fetch anything: these files are served through a stubbed fetcher, and `test/network-guard.ts` fails any test that tries a real network call.

Some records describe the same vacancy on purpose, so the deduplication tests can collapse them across sources:

| Vacancy | Sources |
|---|---|
| Northwind Analytics, Senior Data Engineer | Greenhouse (requisition 4100001), RemoteOK (apply link to the same requisition, in another URL form), Himalayas (text only) |
| Larkspur Robotics, Senior Product Manager, Growth | Lenny's Job Board and JobSpy (the same careers URL with tracking parameters and with a trailing slash) |
| Kestrel Ledger, Smart Contract Auditor | Lever and We Work Remotely (location spelled differently and no employer link, so it stays separate) |

Each source file also carries at least one record its adapter must reject or skip, so the `records_rejected` drift signal is pinned as well.
