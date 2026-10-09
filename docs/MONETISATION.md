# Monetisation path

Status: design only. Nothing here is implemented, because it needs a live domain, an identity provider and a billing product that do not exist yet.

## Model

Own-site freemium.

- **Free tier.** The core discovery tools work without an account: search, deduplicate, classify, brief and source yield. This is what the plugin ships and what reviewers test.
- **Paid plans.** Sold only on the operator's own website, with the operator's own checkout. Candidate features are higher request limits and additional enabled sources. The plan list and prices are [PLACEHOLDER]; none are decided.
- **Employer sources as a separate tool.** This part is in the code. The official employer ATS sources (Greenhouse, Ashby, Lever) are searched only by `jobscout_search_employers`, never by the free `jobscout_search_jobs`. A gateway that gates whole tools by name can therefore offer them as a Pro-only tool through its existing per-tool allow list, with no gateway change. The tool carries the same provenance, disclosure fields and untrusted-content notice as the free search. See [providers](PROVIDERS.md#search-tool-jobscout_search_employers).
- **Plans page.** The plugin may link to an informational plans page on the operator's site. It is a plain link. It carries no checkout, no upsell prompt and no price inside the conversation.

## Rules the plugin follows

1. No in-chat checkout and no purchase of digital goods inside ChatGPT, Codex or Claude. OpenAI's monetisation guidance steers developers to sell digital products on their own site, and the plugin does not try to work around that.
2. Existing-account sign-in only. A user who already has an account and a plan on the operator's site can connect it through OAuth so the plan's limits apply. The plugin never creates accounts, never collects a password or card number in a tool call, and does not require sign-in for the free tier.
3. No OpenAI revenue share is assumed anywhere in the plan. No indie plugin revenue share is documented, so the model must stand on own-site subscriptions or not at all.
4. No gating of the safety behaviour. Provenance, untrusted-content notices and disclosure fields are the same on every tier.

## What must exist before this works

| Needed | Why | State |
|---|---|---|
| Public domain with HTTPS | Directory submission, OAuth redirect and domain verification | Gap |
| OAuth 2.1 authorisation server and a registered client | Existing-account sign-in from the assistant | Gap |
| Entitlement lookup (plan to limits) | Applying free versus paid limits per request | Gap, not built |
| Own-site checkout and plans page | Selling plans outside the assistant | Gap |
| Rate limiting by plan | Enforcing limits | Gap, not built |

The hosted server currently has no per-user identity. Its only access control is an optional single shared bearer token for private deployments (see [deployment](DEPLOYMENT.md)), which is not an entitlement system.

## What this document does not promise

No revenue figure, no conversion rate and no pricing. Those depend on a plan the operator has not yet chosen.
