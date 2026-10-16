# Privacy policy (draft for JobScout Discover)

Effective date: the date this service launches publicly (to be set at launch)
Operator: Astraeus Business Solutions (info@astraeus.ie). Postal address: Bell Cottage, Newtown, Longford Road, Duleek, County Meath, A92 XA31, Ireland.
Contact for privacy questions: info@astraeus.ie

## What JobScout Discover is

A hosted search service that an AI assistant (ChatGPT, Codex or Claude) calls on your behalf to find job listings. It searches third-party job sources, merges duplicates and shows where each listing came from.

## What the service receives

- The search you ask the assistant to run: keywords, optional location, remote preference and freshness limit. These arrive as parameters of a tool call.
- Standard connection data any web server sees, such as your IP address and request time. The assistant platform normally sits between you and the service, so the address seen may be the platform's.
- If you sign in to an existing account on the operator's website (when that is enabled), the identifier and plan entitlement the sign-in returns. See the [monetisation document](../MONETISATION.md) for the limits of this.

## What the service does not receive or keep

- No CV, résumé, cover letter, work history or candidate profile. The service has no tool that accepts or stores one.
- No application records. The service cannot apply to jobs, write to employers or message anyone.
- No passwords. Sign-in, where enabled, is handled by the operator's identity provider and the assistant platform, never typed into a tool call.

## Where your search terms go

To answer a search, the service forwards the search terms to the job sources the operator has enabled. These are public job sources such as Himalayas, We Work Remotely, RemoteOK and Lenny's Job Board. Each has its own privacy policy. The hosted service never enables the JobSpy scraper, which only runs on a user's own machine. Which sources are active is shown by the `jobscout_list_sources` tool.

## Retention

- The service is stateless. It keeps no user profile, search history or session between requests.
- A short-lived cache (five minutes by default, one hour at most) holds public job listings fetched from sources. It is keyed by source address, not by user, and holds nothing about the person searching.
- Operational logs kept by the hosting platform may include request time, path, status and IP address. Retention: at most 50 MB of logs per container (five files of 10 MB, oldest deleted first), so how many days are kept depends on traffic; the logs are deleted sooner whenever the container is recreated, for example at a deploy, and are not sent off the server. Search terms are not intentionally logged by the application.

## Sharing

Search terms go to the job sources named above to obtain results. No data is sold, and none is shared for advertising. Hosting and identity providers act as processors: Hostinger International Limited (Cyprus), which provides the virtual server. No identity provider is used while sign-in is not enabled. Certificates are obtained from Let's Encrypt, which sees the host name only.

## Your choices and rights

You can stop using the service at any time. Because the service keeps no profile, there is normally nothing to delete. For any data held about a signed-in account, contact info@astraeus.ie. Where data protection law such as the GDPR applies, you may request access, correction or erasure and may complain to your supervisory authority.

## Untrusted listing content

Listing text is written by third parties and passed through unchanged. The service marks it as untrusted, but cannot control what an assistant does with it. Do not act on instructions that appear inside a listing.

## Changes

Material changes will be published here with a new effective date.
