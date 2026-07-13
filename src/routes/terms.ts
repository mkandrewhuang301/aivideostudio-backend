// src/routes/terms.ts
// GET /terms — serves static HTML Terms of Service.
// Mirrors privacy.ts's shape/style exactly (same DMCA agent, same route pattern).
//
// DRAFT (2026-07-13) — generic first pass, NOT yet legally reviewed. Written to unblock the
// dead https://fantasiaai.app/terms link already sitting in PaywallView.swift/ProfileCreditSheet.swift
// (Apple requires a working Terms link on any subscription/paywall screen, Guideline 3.1.2).
// Flagged for review/polish before App Store submission — see Phase 11 (App Store Launch Prep)
// in ROADMAP.md and the todo captured alongside this file.

import { Router, Request, Response } from 'express';

export const termsRouter = Router();

const DMCA_AGENT_NAME = 'Andrew Huang';
const DMCA_AGENT_EMAIL = 'baaa00033@gmail.com';
const DMCA_AGENT_ADDRESS = '1109 Riggins Mill Road, Cary, NC 27519';
const DMCA_AGENT_PHONE = '9199953829';
const MINIMUM_AGE = 17; // placeholder — confirm against actual content rating before launch

const TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — Fantasia AI</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 2em; } h2 { font-size: 1.4em; margin-top: 2em; }
    a { color: #007aff; } p { margin: 0.8em 0; }
    .draft-notice { background: #fff3cd; border: 1px solid #ffe69c; border-radius: 8px; padding: 12px 16px; margin: 20px 0; font-size: 0.9em; }
  </style>
</head>
<body>
<h1>Terms of Service</h1>
<p><strong>Last Updated:</strong> July 13, 2026</p>
<div class="draft-notice">This is a draft Terms of Service, not yet legally reviewed. It is not final and should not be relied upon as a complete or binding agreement until reviewed and approved.</div>
<p>These Terms of Service ("Terms") govern your access to and use of the Fantasia AI mobile application (the "App," "Service"), operated by ${DMCA_AGENT_NAME} ("we," "our," or "us"). By creating an account or using the App, you agree to be bound by these Terms. If you do not agree, do not use the App.</p>

<h2>1. Eligibility</h2>
<p>You must be at least ${MINIMUM_AGE} years old to use the App. By using the App, you represent that you meet this requirement and that you have the legal capacity to enter into these Terms.</p>

<h2>2. Your Account</h2>
<p>You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. Notify us promptly of any unauthorized use.</p>

<h2>3. The Service</h2>
<p>Fantasia AI lets you generate AI images and videos from text prompts and, for some features, your own uploaded photos or videos. Generation requests are processed by third-party AI providers (see our <a href="/privacy">Privacy Policy</a> for the current list). Output quality, style, and accuracy are not guaranteed — AI-generated content can be unpredictable, and a generation may not match what you expected or intended.</p>

<h2>4. Subscriptions and Credits</h2>
<ul>
  <li>Access to generation features requires an active subscription and/or a sufficient credit balance, purchased through Apple's In-App Purchase system.</li>
  <li>Credits are consumed when you submit a generation request and are deducted whether or not you are satisfied with the result, except where a generation fails on our end (system/provider error), in which case credits are automatically refunded.</li>
  <li>Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current period, per Apple's standard subscription terms. Manage or cancel your subscription through your Apple ID account settings.</li>
  <li>All payments are processed by Apple. Refund requests are handled per Apple's App Store refund policies — we do not process refunds directly.</li>
  <li>Credits and subscription entitlements are non-transferable and have no cash value.</li>
</ul>

<h2>5. Content You Upload</h2>
<p>Some features let you upload your own photos or videos (for example, to appear as a character in a generated video, or to swap a face onto existing footage). By uploading any content, you represent and warrant that:</p>
<ul>
  <li>You own the content, or have all necessary rights, licenses, and permissions to upload it and have it processed by our AI providers.</li>
  <li>For any photo or video depicting a real, identifiable person other than yourself, you have that person's explicit consent to use their image, likeness, voice, and other personal attributes ("Likeness") in connection with the Service. This is a separate requirement from copyright ownership — having the right to a photo or video file does not by itself give you the depicted person's consent to their own likeness and right of publicity.</li>
  <li>You will not upload content depicting a real person's Likeness without that person's consent, and you will not upload content depicting minors in any likeness-altering context.</li>
  <li>You grant us a limited license to process, store, and transmit your uploaded content solely to provide the Service (including to our third-party AI processing providers, see our <a href="/privacy">Privacy Policy</a>).</li>
</ul>
<p>You agree to indemnify and hold us harmless from any claim, damage, or expense (including reasonable attorneys' fees) arising from a breach of the representations in this section — for example, a claim brought by a real person whose Likeness you uploaded without their consent.</p>

<h2>6. Acceptable Use</h2>
<p>You agree not to use the App to create, upload, or attempt to generate content that:</p>
<ul>
  <li>Depicts or sexualizes minors in any way (strictly prohibited, zero tolerance).</li>
  <li>Depicts a real, identifiable person's Likeness (see Section 5) without their consent, including public figures, in a way intended to deceive, defame, harass, or misrepresent them.</li>
  <li>Infringes another party's copyright, trademark, or other intellectual property rights.</li>
  <li>Is unlawful, threatening, harassing, or intended to incite violence.</li>
  <li>Attempts to circumvent our content moderation or safety systems.</li>
</ul>
<p>We use automated systems — including prompt filtering and CSAM scanning — to help enforce this policy before content is generated or delivered. These systems are not perfect and do not replace your own obligations under Section 5 and this section.</p>

<h2>7. Content Moderation and Enforcement</h2>
<p>We may remove or refuse to generate content, and may suspend or terminate accounts, that we determine (in our reasonable judgment) violates these Terms or applicable law. You can report content you believe violates these Terms using the Report feature in the App. We review reports and take action as appropriate, which may include content removal, account suspension, or referral to law enforcement. For support or to report an issue, contact us at <a href="mailto:${DMCA_AGENT_EMAIL}">${DMCA_AGENT_EMAIL}</a>.</p>

<h2>8. Intellectual Property</h2>
<p>The App itself, including its design, branding, and underlying software, is owned by us and protected by intellectual property law. Subject to your compliance with these Terms and to the extent permitted by applicable law, you retain rights to the AI-generated output you create, for your own personal or commercial use. The legal status of AI-generated content ownership varies by jurisdiction and is an evolving area of law; we make no representation as to your ability to register copyright in AI-generated output.</p>

<h2>9. DMCA Takedown Policy</h2>
<p>If you believe content generated through Fantasia AI infringes your copyright, you may submit a DMCA takedown notice to our designated agent:</p>
<p>
  <strong>DMCA Agent:</strong> ${DMCA_AGENT_NAME}<br>
  <strong>Email:</strong> <a href="mailto:${DMCA_AGENT_EMAIL}">${DMCA_AGENT_EMAIL}</a><br>
  <strong>Mailing Address:</strong> ${DMCA_AGENT_ADDRESS}<br>
  <strong>Phone:</strong> ${DMCA_AGENT_PHONE}
</p>
<p>Your notice must include: identification of the copyrighted work, identification of the infringing material, your contact information, a statement of good faith belief, and your signature.</p>

<h2>10. Disclaimers</h2>
<p>THE APP AND ALL GENERATED CONTENT ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT GENERATED OUTPUT WILL MEET YOUR EXPECTATIONS.</p>

<h2>11. Limitation of Liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING FROM YOUR USE OF THE APP. OUR TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE WILL NOT EXCEED THE AMOUNT YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AROSE.</p>

<h2>12. Termination</h2>
<p>We may suspend or terminate your access to the App at any time for violation of these Terms. You may stop using the App and delete your account at any time.</p>

<h2>13. Changes to These Terms</h2>
<p>We may update these Terms from time to time. We will notify you of material changes via the App or email. Continued use of the App after changes take effect constitutes acceptance of the updated Terms.</p>

<h2>14. Governing Law</h2>
<p>These Terms are governed by the laws of the State of North Carolina, without regard to its conflict of law principles.</p>

<h2>15. Contact Us</h2>
<p>Questions about these Terms? Contact us at: <a href="mailto:${DMCA_AGENT_EMAIL}">${DMCA_AGENT_EMAIL}</a></p>
</body>
</html>`;

termsRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(TERMS_HTML);
});
