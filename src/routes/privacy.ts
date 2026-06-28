// src/routes/privacy.ts
// GET /privacy — serves static HTML privacy policy.
// Required by Apple Guideline 5.1.2(i).
// Names Replicate and ByteDance as data processors per CONTEXT.md decision.
// Phase 7 will link this URL from the iOS Settings screen.

import { Router, Request, Response } from 'express';

export const privacyRouter = Router();

const DMCA_AGENT_NAME = 'Andrew Huang';
const DMCA_AGENT_EMAIL = 'baaa00033@gmail.com';
const DMCA_AGENT_ADDRESS = '1109 Riggins Mill Road, Cary, NC 27519';
const DMCA_AGENT_PHONE = '9199953829';

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Fantasia AI</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 2em; } h2 { font-size: 1.4em; margin-top: 2em; }
    a { color: #007aff; } p { margin: 0.8em 0; }
  </style>
</head>
<body>
<h1>Privacy Policy</h1>
<p><strong>Last Updated:</strong> June 27, 2026</p>
<p>Fantasia AI ("we," "our," or "us") operates the Fantasia AI mobile application. This Privacy Policy describes how we collect, use, and share information about you when you use our app.</p>

<h2>1. Information We Collect</h2>
<ul>
  <li><strong>Account information:</strong> Email address and display name when you create an account.</li>
  <li><strong>Content you generate:</strong> Text prompts, image/video references, and AI-generated videos.</li>
  <li><strong>Usage data:</strong> Generation history, credit balance, subscription status, and in-app activity.</li>
  <li><strong>Device token:</strong> Apple Push Notification token to deliver generation completion notifications.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<ul>
  <li>Process AI video generation requests via our inference providers.</li>
  <li>Manage your credit balance and subscription.</li>
  <li>Send push notifications when your generations complete.</li>
  <li>Enforce our Content Policy and comply with applicable law.</li>
</ul>

<h2>3. Data Processors and Third-Party Services</h2>
<p>We share your data with the following third-party service providers who process data on our behalf:</p>
<ul>
  <li><strong>Replicate, Inc.</strong> (replicate.com) — AI inference platform. Your text prompts and any uploaded reference images or videos are transmitted to Replicate for processing by the ByteDance Seedance 2.0 model.</li>
  <li><strong>ByteDance Ltd.</strong> — Provider of the Seedance 2.0 AI video generation model, operated through Replicate's infrastructure. Your prompts and reference media are processed by ByteDance's model to generate your video.</li>
  <li><strong>Cloudflare, Inc.</strong> — Your generated videos are stored in Cloudflare R2 object storage.</li>
  <li><strong>Google Firebase</strong> — Account authentication (Sign in with Apple, email/password).</li>
  <li><strong>RevenueCat</strong> — Subscription and in-app purchase management.</li>
  <li><strong>Hive Moderation (The Hive AI, Inc.)</strong> — Every completed video generation is automatically scanned for Child Sexual Abuse Material (CSAM) using Hive's Visual Moderation API before being delivered to your device. Hive processes the video and deletes the media after analysis; only anonymized embeddings are retained.</li>
  <li><strong>OpenAI, Inc.</strong> — Text prompts are screened through OpenAI's Moderation API to detect policy-violating content before any video is generated.</li>
</ul>

<h2>4. Content Moderation</h2>
<ul>
  <li><strong>Prompt filtering:</strong> All generation prompts are screened against a keyword blocklist and through OpenAI's Moderation API before dispatch to the AI model.</li>
  <li><strong>CSAM scanning:</strong> All generated videos are automatically scanned for Child Sexual Abuse Material (CSAM) by Hive Moderation before delivery to your device. Detected CSAM is quarantined, not delivered, and flagged for review and reporting to the NCMEC CyberTipline as required by 18 U.S.C. § 2258A and the REPORT Act (2024). We retain metadata about flagged content for at least one year after any report is filed.</li>
</ul>

<h2>5. User Reporting</h2>
<p>You can report a generated video that you believe violates our Content Policy using the Report button in the app. We review reports and may remove content, suspend accounts, or refer matters to law enforcement as appropriate.</p>

<h2>6. Data Retention</h2>
<p>We retain your generated videos in cloud storage until you delete them from the app. Account data is retained while your account is active. We retain metadata related to CSAM reports for at least one year as required by law.</p>

<h2>7. Your Rights</h2>
<p>Depending on your jurisdiction, you may have rights to access, correct, or delete your personal data. To exercise these rights, contact us at the address below.</p>

<h2>8. DMCA Takedown Policy</h2>
<p>If you believe that content generated through Fantasia AI infringes your copyright, you may submit a DMCA takedown notice to our designated agent:</p>
<p>
  <strong>DMCA Agent:</strong> ${DMCA_AGENT_NAME}<br>
  <strong>Email:</strong> <a href="mailto:${DMCA_AGENT_EMAIL}">${DMCA_AGENT_EMAIL}</a><br>
  <strong>Mailing Address:</strong> ${DMCA_AGENT_ADDRESS}<br>
  <strong>Phone:</strong> ${DMCA_AGENT_PHONE}
</p>
<p>Your notice must include: identification of the copyrighted work, identification of the infringing material, your contact information, a statement of good faith belief, and your signature.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes via the app or email.</p>

<h2>10. Contact Us</h2>
<p>Questions about this Privacy Policy? Contact us at: <a href="mailto:${DMCA_AGENT_EMAIL}">${DMCA_AGENT_EMAIL}</a></p>
</body>
</html>`;

privacyRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(PRIVACY_HTML);
});
