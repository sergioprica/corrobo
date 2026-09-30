# Security

corrobo is a pre-1.0 open-source library published on npm.

## Reporting a vulnerability

Please report security issues **privately** through GitHub: [Report a vulnerability](https://github.com/vidithsalla/corrobo/security/advisories/new). Don't open a public issue for them.

In scope: anything in corrobo's own code that could cause a duplicate external effect, let a stored operation identity or intent be tampered with or silently reused for a different intent, bypass same-identity coordination, or persist data corrobo shouldn't (see below). Please include the sequence of events and the corrobo version; a minimal contract + fake that reproduces it helps most.

There's no bug bounty. You'll get an acknowledgement as soon as the maintainer sees the report, and a fix or an explanation before anything is made public. Please don't test against any production system's credentials — `examples/stripe-refund/live-smoke.ts` is deliberately restricted to Stripe test-mode keys (`sk_test_...`) and refuses anything else.

## Data handling

corrobo has no telemetry and no corrobo-operated backend — it does not send application data anywhere on its own. `PostgresStore` persists reliability state (intent, transport evidence, observations, reason metadata) only in the database you configure, and requires an explicit `{ acknowledgePersistence: true }` acknowledgement to construct. As of this version, raw thrown error objects are excluded from what `PostgresStore` persists (only `error.message`, a string, is kept) specifically because HTTP-client-style errors commonly carry request headers and response bodies that can include credentials or customer data.

**Accidental sensitive-data persistence is a security concern, not just a privacy one**, and it is one this library cannot fully protect you from: `intent`, observation data, and reason metadata are generic by design, and corrobo has no way to distinguish an ordinary value from a secret. If you find a case where corrobo's own code (not your application's `execute()`/`observe()`/`reconcile()`) causes something unexpected to be persisted, that's a legitimate report under this policy. Please still avoid putting credentials, tokens, or unnecessary personal data into intents, observations, reason metadata, or thrown error messages — corrobo persists what you give it.

See README's [Privacy and data handling](README.md#privacy-and-data-handling) section for the full picture.
