# Demo account instructions for reviewers

Status: template. No demo account exists yet. A demo account needs a live domain and an identity provider, neither of which is set up. Nothing in this repository stores credentials, and credentials must never be committed here. Share them with reviewers only through the submission portal's private field.

## What a reviewer needs

The core tools need no account. Search, deduplication, classification and briefing work without signing in, so a review can be done anonymously against the free tier. A demo account is only needed to check the existing-account sign-in path described in [monetisation](../MONETISATION.md).

## Reviewer instructions (fill in at submission time)

1. Install the plugin in ChatGPT or Codex using the directory link: [PLACEHOLDER link].
2. To test the free tier, do nothing further. Start with test case P1 in [test cases](test-cases.md).
3. To test sign-in, choose Connect when prompted and sign in with the demo account below.

| Field | Value |
|---|---|
| Sign-in page | [PLACEHOLDER URL] |
| Username | [PLACEHOLDER, enter only in the portal's private field] |
| Password | [PLACEHOLDER, enter only in the portal's private field] |
| Plan on the account | [PLACEHOLDER, for example "Pro, no payment method attached"] |
| Multi-factor authentication | [PLACEHOLDER, must be disabled or bypassed for the demo account] |
| Expiry | [PLACEHOLDER date, rotate after review] |

## Checks before submitting

- The account signs in without sending a code to a personal device.
- The account has no payment method and no personal data.
- The account is not reused for anything else, and its password is rotated after review.
- The reviewer is told which sources are enabled on the review deployment.
