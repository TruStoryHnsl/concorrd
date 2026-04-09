# Concord Native Mobile Monetization Proposal

**Status:** Resolved 2026-04-08 · Task INS-021 / OPT-002 · Donation-only model
**Scope:** Native mobile frontend apps (iOS + Android) ONLY. The browser-accessible web UI is the canonical free interface and stays free-forever, no ads, forever.
**Framing:** "Pay what you want, or don't." Not a paywall. Not a feature lockout. Not a tier. The app is free on every store and every feature is always available; donations are an optional thank-you that the user chooses freely.

---

## Executive Summary

**Everything in Concord is free.** Free on the web, free on iOS, free on Android, free to install, free to use, free to remove ads, free forever. There is no paid tier and there never will be.

The native mobile apps ship with **house ads on by default** — privacy-respecting, first-party house ads that promote Concord places, features, and community events. No AdMob. No tracking. No data collection. When a user first opens the app (and any time in settings thereafter), they see a **three-way choice**:

1. **"Pay what you want"** — one-tap donation to Concord development. The default highlighted amount is **$2.99**, and the user can pick any amount from $0.50 to $49.99 via a small ladder of consumable IAP SKUs. Donating removes ads as a thank-you, but removal is not what the user is paying for — they could have had it for free.
2. **"Remove ads for free"** — no payment required. The user clicks, ads disappear, nothing else changes. This path is explicitly encouraged. It is not hidden, delayed, nagged, or fine-printed. If a user wants ads off and can't pay, that's fine.
3. **"Keep ads on"** — the user explicitly chooses to support Concord development by leaving the house ads running. Because house ads promote Concord itself (places to discover, features to try, upcoming events), this path is framed as "keep the community surface visible" rather than "watch ads for the money." Thank-you framing only.

All three choices lead to the full Concord feature set. Every message, every voice/video call, every file exchange, every place, every server, every forum is available in every path.

**The commitment threaded through every section below:** Concord is free. If the donation model generates nothing, Concord is still free. If the user chooses the free-ads-off path en masse, Concord is still free. If nobody donates, Concord is still free. The donation model is a **yes or no question** — not a pressure funnel.

---

## 1. The Three-Way Choice (first launch + settings)

### 1.1 When it appears

- **On first launch** of the native mobile app, after login, as a dedicated screen the user must interact with (one tap) before reaching the main UI.
- **Always available from Settings → Support Concord**, so a user who skipped or dismissed it can come back at any time and change their mind.
- **After every successful donation**, a compact thank-you confirmation that also re-exposes the other two choices (so the user knows they can still toggle the ad-free flag or resume ads if they want to see community promotions again).

### 1.2 What the user sees

```
Welcome to Concord.

This app is free. It will always be free.
Every feature works without paying anything.

How would you like to use it?

┌────────────────────────────────────────────┐
│  💛  Pay what you want                      │
│                                              │
│  Support Concord development with a         │
│  one-time donation. Any amount.              │
│                                              │
│  Suggested: $2.99   [Choose amount →]       │
│                                              │
│  Removes ads as a thank-you.                │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  🎁  Remove ads for free                    │
│                                              │
│  No payment. Ads are gone.                  │
│  Use Concord however you like.              │
│                                              │
│                          [Remove ads →]     │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│  📣  Keep ads on                            │
│                                              │
│  Ads are in-house (no tracking).            │
│  They promote Concord places and features. │
│  Thank you for the visibility.              │
│                                              │
│                          [Keep ads on →]    │
└────────────────────────────────────────────┘

You can change this any time in Settings.
```

### 1.3 Defaults before the user chooses

- **Ads render by default** (house ads, no tracking). The user must actively click one of the three options to stop the default.
- The choice screen is **not dismissable by swipe-away or tap-outside** — the user must choose. Choosing is one tap, so this is not friction, but the choice is deliberate.
- If the user quits the app before choosing, the choice screen re-appears on next launch.

---

## 2. Ad System (unchanged from prior draft)

### 2.1 House ads

Ads in the free default tier are **in-house**, first-party, and non-tracking. Each ad slot renders one of:

- A Concord place to discover (curated or algorithmically surfaced from public places via the INS-025 federation allowlist)
- A Concord feature announcement ("Try the new visual forum map")
- A community event ("Concord development livestream tonight")
- A friendly promotion of the Support Concord flow ("Love Concord? Consider a donation or just disable these ads — we don't mind.")

**No third-party SDKs. No tracking. No ATT prompt on iOS. No advertising ID. No analytics beyond opt-in crash reporting.**

### 2.2 No AdMob

AdMob, Google Ads, Facebook Audience Network, and any other tracking-based ad network are explicitly **excluded**. The cost of importing a tracking SDK is not the $0.30 per 1000 impressions — it's the contradiction with Concord's privacy narrative. The three-way-choice UX depends on the user trusting that ads are a community surface, not a surveillance surface. Importing AdMob breaks that trust in a way no revenue increment makes up for.

### 2.3 Fallback inventory (phase 2, optional)

If house ad inventory is insufficient (the user sees the same place promoted back-to-back), integrate **EthicalAds** as a backfill. EthicalAds serves non-tracking text ads to privacy-conscious surfaces like Python docs and Read the Docs. Optional, phase 2, and clearly labeled as "supporting Concord via a partner" if it ever ships.

---

## 3. Donation Ladder (pay-what-you-want implementation)

App Store and Play Store both require IAP products to have **fixed prices**. "Pay what you want" is implemented as a ladder of **consumable** IAPs at different price points:

| SKU | Price (USD) | Label in UI |
|---|---|---|
| `com.concord.donate.050` | $0.50 | "A little something" |
| `com.concord.donate.099` | $0.99 | "Pocket change" |
| `com.concord.donate.199` | $1.99 | "Coffee tip" |
| `com.concord.donate.299` | **$2.99** | **"Default suggested"** |
| `com.concord.donate.499` | $4.99 | "Nice tip" |
| `com.concord.donate.999` | $9.99 | "Generous" |
| `com.concord.donate.1999` | $19.99 | "Very generous" |
| `com.concord.donate.4999` | $49.99 | "Big fan" |

### 3.1 Why consumable, not non-consumable

A donation is not an unlock. The user is not buying anything. Consumable IAPs:
- Can be purchased any number of times (a user who loves Concord can donate monthly without a subscription)
- Don't pollute the restore-purchases flow with permanent entitlements
- Don't require the server to track "who owns what" — the donation happened, the money moved, no further state

The **ad-free flag is set locally regardless** of whether the user donated. Donations flip the flag as a thank-you; the "Remove ads for free" button flips the same flag without payment. Both paths produce the same flag value.

### 3.2 Why $2.99 is the default highlight

- Below the psychological "not worth thinking about" threshold for most users in major markets.
- Above Apple's Tier 2 ($1.99) where the 30% cut eats most of the revenue.
- The user's stated preference ("default pay-what-you-want buttons should start at 2.99").
- Users who want to donate less can pick $0.50 / $0.99 / $1.99 from the same ladder; the default is a suggestion, not a floor.

### 3.3 Regional pricing

**Doesn't apply.** Pay-what-you-want at the store IAP level means regional pricing is handled automatically by Apple and Google on a per-SKU basis — $2.99 USD becomes ₹249 INR, R$16 BRL, ¥320 JPY, etc. via the store's own localized pricing matrices. Because donations are optional, regional pricing pressure is much lower than the prior draft's per-region-override scheme required. Users who find the default SKUs too expensive pick the $0.50 option, which the stores localize on their own.

---

## 4. Refund Policy

**Policy statement (shown at donation confirmation):**

> Thank you for supporting Concord development. This was a donation — it bought you nothing except our gratitude (and the ad-free flag, which you could have flipped for free). If you change your mind, request a refund through your device's app store within the standard store window (Apple: 90 days at Apple's discretion; Google: 48 hours self-service, beyond that case-by-case). **We will not contest any refund request.**
>
> Concord still works, in your browser, free, forever — and in this native app, ad-free if you want, even after the refund.

**No-contest rationale:** The transaction is a donation. Contesting a refund request on a donation is hostile and undermines the framing the user's answer explicitly demanded ("They give me money or they do not. No pressure or way to trap them."). The cost of an accepted refund is $2.99. The cost of contesting is trust erosion. No math makes contesting worth it.

**Abuse guardrails:** None. At $0.50 minimum and $49.99 maximum, abuse is not material.

---

## 5. Store Listing Strategy

### 5.1 Common to both stores

- **App name:** "Concord — Decentralized Chat"
- **Short description:** "Private, decentralized group chat. Free on every platform. Donations are optional."
- **Long description lead paragraph:**

  > "Concord is a decentralized, privacy-respecting group chat platform. Every feature — messaging, voice, video, file sharing, servers, rooms, forums — works for free in any web browser, on any desktop, on any phone, forever. This app is free too. On first launch, you'll pick how you'd like to use Concord: donate to support development, skip the donation and turn off the in-house ads for free, or keep the community-promotion ads running. All three are fine."

- **Privacy manifest (iOS) / Data Safety form (Android):** Declare ZERO data collection. House ads do not track users. No advertising ID use. No analytics SDKs beyond opt-in crash reporting.
- **Content rating:** Teen / 13+ (user-generated content requires moderation tools, which Concord already has).
- **Age gate:** 13+ on both stores. COPPA compliance — under-13 accounts are not permitted. Registration flow includes an age self-declaration and the privacy policy states the 13+ minimum.

### 5.2 iOS App Store specifics

- **Screenshots:** 6 screenshots including one of the three-way-choice screen with a caption: "This app is free. Donate if you want. Remove ads if you don't. Or leave them on and support the community."
- **App preview (video):** 15-second loop showing a voice call → map view → chat, captioned "Decentralized. Free. Yours."
- **Keywords:** "decentralized chat, privacy, voice chat, video chat, group chat, forum, mesh, peer to peer, free messenger, open source."
- **Privacy label:** "Data Not Collected" across all categories. House ads declared as "first-party, no tracking, no third-party SDK."
- **App Review reviewer notes:** explain that Local Network + Bluetooth are required for mesh-transport peer discovery, not for tracking. Call out the three-way-choice screen explicitly and link to Apple's [App Store Review Guideline 3.1.1](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase) — consumable donation IAPs for non-physical non-subscription-non-unlock support are permitted.

### 5.3 Google Play Store specifics

- **Screenshots:** 8 screenshots including the three-way-choice screen.
- **Feature graphic:** Concord logo + tagline "Decentralized. Free. Yours."
- **Data Safety form:** Declare no data collection, no data shared with third parties. House ads declared as "first-party ads, no tracking."
- **Target API level:** Android API 35 (Android 15) or the latest required by Play Console at submission time.
- **Permissions:** Microphone, Camera, Local Network, Bluetooth, Foreground Service (for embedded servitude running in background per INS-022). Foreground service type: `mediaPlayback | microphone` (lets voice calls run in the background without triggering "always-on background service" policy hammers).
- **IAP policy**: Google Play allows consumable IAPs for donations provided the app also offers the underlying functionality for free. Concord meets that bar trivially — everything is free.

---

## 6. In-App Purchase Integration

### 6.1 iOS: StoreKit 2

- **Tauri v2 StoreKit plugin** or a thin Objective-C bridge via Tauri's mobile plugin API.
- **Product configuration:** 8 consumable IAP products under the prefix `com.concord.donate.*`. Each has a short localized display name from §3's table.
- **Purchase flow:** User picks an amount → StoreKit sheet → confirmation → **transaction is finished immediately** (consumable) → local "ad-free" flag set → a lightweight `{amount, timestamp}` entry written to the Matrix account's private account data at `com.concord.donations` (a list of donation events, local/private — not federated, not public). The ledger is purely for the user's own records and for a "you've supported Concord N times, thank you" settings affordance.
- **No server-side validation** required for consumables at these price points. Phase 2 can add receipt validation if fraud becomes material, but the cost of fraud is "someone gets ads removed," which they could have done for free anyway, so the attack surface is empty.

### 6.2 Android: Google Play Billing Library

- **Tauri v2 Play Billing plugin** or a thin Kotlin bridge.
- **Product configuration:** 8 consumable in-app products mirroring iOS, under `com.concord.donate.*`.
- **Purchase flow:** `BillingClient.launchBillingFlow()` → onPurchaseUpdated callback → `consumeAsync()` immediately (consumable must be consumed to be purchasable again) → set ad-free flag + append to the private donation ledger.
- **Acknowledgment:** REQUIRED within 3 days or Play refunds automatically. Handled in the consume callback.

### 6.3 "Remove ads for free" flow (no IAP)

- Button tap → set local `ad-free` flag in store → sync to Matrix account data at `com.concord.ad_free: true` (private, not federated beyond the user's own devices) → optional toast "Ads off. Enjoy Concord."
- **No confirmation dialog, no "are you sure," no delay.** The user asked for ads off, ads are off.

### 6.4 "Keep ads on" flow

- Button tap → set `ad-free` flag to `false` (default anyway) → optional toast "Thanks for supporting Concord." → dismiss the three-way-choice screen.
- Ads are rendered from the first launch afterward.

### 6.5 Cross-platform state sync

The `ad-free` flag is synced via private Matrix account data (`com.concord.ad_free`), which means:
- Flipping ad-free on iOS also removes ads on the web UI (currently a no-op because the web UI has no ads, and never will).
- Signing into the same Matrix account on Android after choosing ad-free on iOS restores the flag automatically.
- If the user donates on BOTH iOS and Android, the local donation ledgers on each device are independent (the ledger is private per-device account data). A future unification can consolidate them via shared account data, but it is not blocking.

---

## 7. Implementation Phases

1. **Phase 0 (current)** — no ads, no donations, no choice screen. Native apps launch without monetization scaffolding.
2. **Phase 1** — three-way-choice screen + house ads in free default tier. No donation flow yet. Ship the choice UX first so the ads have meaning (they're opt-in by the user's explicit action, not a surprise).
3. **Phase 2** — donation ladder lands. StoreKit + Play Billing integration. The "Pay what you want" button in the three-way-choice screen becomes functional.
4. **Phase 3 (optional)** — EthicalAds backfill if house inventory proves insufficient. Optional.
5. **Phase 4 (optional)** — settings-side "donation history" view showing the user their own donations from the private ledger, with a gentle prompt to re-donate if they feel like it. Opt-in, never nagged.

---

## Appendix A — Commitments We Will NOT Break

1. **The web UI has no ads. Ever.** Not "no ads until we change our mind." No ads, forever.
2. **No feature gating behind payment.** Every feature in the native app is in the web app and both are free. Donations do not unlock anything that isn't already available.
3. **The "Remove ads for free" path is not hidden.** It is a first-class option in the three-way-choice screen and in Settings. It is not delayed behind a timer, a nag modal, or a dark-patterned "are you sure." One tap, done.
4. **No data collection by the ad system.** House ads are first-party. If an EthicalAds backfill ships, the Data Safety declaration remains "no data collected."
5. **Refunds are honored, no questions asked.** Donation framing means refunds are honored at face value.
6. **Concord is open-source.** The project is FoSS. Making the native apps donation-capable does not close-source any part of the codebase.
7. **The three-way choice is genuine.** The "Keep ads on" path is not a trick to upsell donations. "Remove ads for free" is not greyed out or second-class. The three options are equally blessed and equally final.

---

## Appendix B — Settled Questions

The previous draft had six open questions. Under the donation-only model, they either resolve automatically or become non-applicable:

1. ~~**House ad content curation**~~ → **Resolved by scope**: house ads promote Concord places (auto-surfaced from the federation allowlist + public rooms shipping via INS-025), Concord features (hardcoded list per release), and community events (admin-curated via a simple `client/house_ads_manifest.json` checked into the repo). Algorithmic or community-voted is phase 3+, not part of the MVP.
2. ~~**Tip jar opt-in**~~ → **Resolved by model collapse**: the donation ladder IS the tip jar. No separate phase-3 tip jar. Users tip via the same IAP flow that is shown on first launch and in settings.
3. **Crash reporting** → **Still open — low priority**. Opt-in Sentry remains the cleanest approach for a donation-funded project, but the user has not confirmed. Alternative: rely purely on `BugReportModal` (existing) + structured console logs streamed to stdout for Tauri debug builds. Defer decision until Phase 1 ships.
4. ~~**Cross-platform restore UX**~~ → **Doesn't apply**: there is nothing to "restore" because donations don't unlock anything. The ad-free flag is synced via Matrix account data automatically.
5. **Ad placement** → **Resolved for MVP**: (a) a banner at the top of the server list on the home screen, (b) a native card between every 50 messages in the message list (NOT every 5). No interstitials. No full-screen ads. No mid-video pauses. Phase-1 conservative.
6. ~~**Promotion of ad-free in the ad rotation**~~ → **Doesn't apply in the original sense**: the three-way-choice screen makes ad-free a first-class option from day one, not a hidden upgrade path. House ads may occasionally rotate a "Change your choice in Settings" card as a reminder that the three-way choice is always available — friendly, not salesy.

---

## Appendix C — Cross-References

- **Scope:** Concord is `.scope=commercial` (rigor), but the project is FoSS (source open) with donation-only mobile monetization. Commercial rigor + FoSS distribution + donation support are all consistent.
- **v3 Scope Boundary:** this proposal is the narrow exception to the v3 commerce deferral — native mobile apps only, web UI stays free-forever, and even the native apps have no paid tier.
- **INS-020 (OPT-001):** native mobile frontend apps. This proposal depends on INS-020 shipping — no native app, no ad surface, no choice screen, no donation ladder.
- **INS-025:** the public rooms browser (already shipped on `feat/resolve-skipped-followups`) supplies the Concord-place inventory that house ads rotate through.
- **Apple Developer Program:** user enrolled 2026-04-07, awaiting ID verification (up to 48h). Proceed as if enrolled.
- **PLAN.md "From 2026-04-22 Routing — Resolved" items 1, 2, 3, 7** are the resolutions this proposal implements.
- **Previous draft:** superseded 2026-04-08 by user decision. The prior two-tier "$2.99 one-time unlock" model was correct about ad-freeness and wrong about the payment being required. The three-way choice reframes ad removal as an always-free feature and donations as a first-class supported-but-optional act.

---

*Proposal resolved 2026-04-08 via user directive. The only remaining open item is crash reporting (Appendix B #3), which is deferred until Phase 1 ships. Everything else is settled and ready for Phase 1 implementation when the INS-020 native mobile shell exists.*
