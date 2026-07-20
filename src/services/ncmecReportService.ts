import { GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from '../config';
import { db } from '../db/client';
import { r2, R2_BUCKET } from '../storage/r2';
import { sql } from 'drizzle-orm';

const XML_CONTENT_TYPE = 'text/xml; charset=utf-8';

class NcmecApiResponseError extends Error {
  constructor(message: string, readonly responseCode?: string) {
    super(message);
    this.name = 'NcmecApiResponseError';
  }
}

interface ReportableGeneration {
  id: string;
  user_id: string;
  prompt: string | null;
  r2_key: string;
  created_at: Date | string;
  ncmec_report_id: string | null;
  ncmec_file_id: string | null;
  ncmec_reported_at: Date | string | null;
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${config.ncmecEspUsername}:${config.ncmecEspPassword}`).toString('base64')}`;
}

async function apiRequest(path: string, init: RequestInit & { duplex?: 'half' }): Promise<string> {
  const response = await fetch(`${config.ncmecApiBaseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { Authorization: authHeader(), ...(init.headers ?? {}) },
  } as RequestInit);
  const body = await response.text();
  const responseCode = xmlTag(body, 'responseCode');
  if (!response.ok || (responseCode !== undefined && responseCode !== '0')) {
    throw new NcmecApiResponseError(
      `NCMEC ${path} failed (${response.status}, code=${responseCode ?? 'unknown'}): ${xmlTag(body, 'responseDescription') ?? 'unknown error'}`,
      responseCode,
    );
  }
  return body;
}

async function loadReportableGeneration(generationId: string): Promise<ReportableGeneration> {
  const result = await db.execute(sql`
    SELECT id, user_id, prompt, r2_key, created_at,
           ncmec_report_id, ncmec_file_id, ncmec_reported_at
    FROM generations
    WHERE id = ${generationId}::uuid AND status = 'quarantined' AND r2_key IS NOT NULL
  `);
  const row = result.rows?.[0] as unknown as ReportableGeneration | undefined;
  if (!row) throw new Error(`NCMEC report source generation not found: ${generationId}`);
  return row;
}

async function reserveNewReport(generationId: string): Promise<string | undefined> {
  const token = `pending:${randomUUID()}`;
  const result = await db.execute(sql`
    UPDATE generations
    SET ncmec_report_id = ${token}
    WHERE id = ${generationId}::uuid AND ncmec_report_id IS NULL
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0 ? token : undefined;
}

function reportXml(row: ReportableGeneration): string {
  const incidentDate = new Date(row.created_at).toISOString();
  const prompt = row.prompt?.slice(0, 2000) ?? '(no prompt stored)';
  return `<?xml version="1.0" encoding="UTF-8"?>
<report xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://report.cybertip.org/ispws/xsd">
  <incidentSummary>
    <incidentType>Child Pornography (possession, manufacture, and distribution)</incidentType>
    <platform>Fantasia AI</platform>
    <incidentDateTime>${escapeXml(incidentDate)}</incidentDateTime>
  </incidentSummary>
  <reporter><reportingPerson><email>${escapeXml(config.ncmecReporterEmail)}</email></reportingPerson></reporter>
  <additionalInfo>Automatically detected generative-AI output. Generation ID: ${escapeXml(row.id)}; account ID: ${escapeXml(row.user_id)}; prompt: ${escapeXml(prompt)}. No human reviewer viewed the media.</additionalInfo>
</report>`;
}

function fileDetailsXml(row: ReportableGeneration, reportId: string, fileId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<fileDetails xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://report.cybertip.org/ispws/xsd">
  <reportId>${escapeXml(reportId)}</reportId>
  <fileId>${escapeXml(fileId)}</fileId>
  <fileViewedByEsp>false</fileViewedByEsp>
  <publiclyAvailable>false</publiclyAvailable>
  <fileRelevance>Reported</fileRelevance>
  <fileAnnotations><generativeAi /></fileAnnotations>
  <details><nameValuePair><name>generation_id</name><value>${escapeXml(row.id)}</value></nameValuePair></details>
  <details><nameValuePair><name>account_id</name><value>${escapeXml(row.user_id)}</value></nameValuePair></details>
</fileDetails>`;
}

async function uploadFile(row: ReportableGeneration, reportId: string): Promise<string> {
  const object = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }));
  const objectBody = object.Body as AsyncIterable<Uint8Array> | undefined;
  if (!objectBody || typeof objectBody[Symbol.asyncIterator] !== 'function') {
    throw new Error(`R2 object body unavailable for NCMEC report ${row.id}`);
  }

  const boundary = `fantasia-ncmec-${randomUUID()}`;
  const fileName = row.r2_key.split('/').pop() || `${row.id}.bin`;
  async function* multipart(): AsyncGenerator<Buffer> {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${reportId}\r\n`);
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replaceAll('"', '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    for await (const chunk of objectBody!) yield Buffer.from(chunk);
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }

  const responseXml = await apiRequest('/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Readable.from(multipart()) as unknown as RequestInit['body'],
    duplex: 'half',
  });
  const fileId = xmlTag(responseXml, 'fileId');
  if (!fileId) throw new Error('NCMEC /upload response did not contain fileId');
  return fileId;
}

async function finishReport(reportId: string): Promise<void> {
  const form = new FormData();
  form.set('id', reportId);
  try {
    await apiRequest('/finish', { method: 'POST', body: form });
  } catch (error) {
    // A worker can crash after NCMEC finished the report but before our final DB write. Their
    // documented 5102 response is sufficient proof the same report is already final.
    if (error instanceof NcmecApiResponseError && error.responseCode === '5102') return;
    throw error;
  }
}

/** Submit or resume exactly one CyberTipline report for a quarantined generation. */
export async function reportGenerationToNcmec(generationId: string): Promise<string> {
  if (!config.ncmecEspUsername || !config.ncmecEspPassword || !config.ncmecReporterEmail) {
    throw new Error(
      'NCMEC credentials/reporter email are not configured; use the documented Hive-dashboard manual fallback',
    );
  }

  let row = await loadReportableGeneration(generationId);
  if (row.ncmec_reported_at && row.ncmec_report_id && !row.ncmec_report_id.startsWith('pending:')) {
    return row.ncmec_report_id;
  }

  let reportId = row.ncmec_report_id;
  if (!reportId) {
    const reservation = await reserveNewReport(generationId);
    if (!reservation) {
      row = await loadReportableGeneration(generationId);
      reportId = row.ncmec_report_id;
    } else {
      try {
        const submitted = await apiRequest('/submit', {
          method: 'POST',
          headers: { 'Content-Type': XML_CONTENT_TYPE },
          body: reportXml(row),
        });
        const submittedReportId = xmlTag(submitted, 'reportId');
        if (!submittedReportId) throw new Error('NCMEC /submit response did not contain reportId');
        reportId = submittedReportId;
        await db.execute(sql`
          UPDATE generations SET ncmec_report_id = ${reportId}
          WHERE id = ${generationId}::uuid AND ncmec_report_id = ${reservation}
        `);
      } catch (error) {
        // An explicit API rejection means no report was opened and a later worker may retry.
        // A network/parse ambiguity keeps the reservation: silently opening a second report is
        // worse than a loud manual-reconciliation alert.
        if (error instanceof NcmecApiResponseError) {
          await db.execute(sql`
            UPDATE generations SET ncmec_report_id = NULL
            WHERE id = ${generationId}::uuid AND ncmec_report_id = ${reservation}
          `);
        }
        throw error;
      }
    }
  }

  if (!reportId || reportId.startsWith('pending:')) {
    throw new Error(`NCMEC report ${generationId} has an ambiguous pending reservation; manual reconciliation required`);
  }

  row = await loadReportableGeneration(generationId);
  let fileId = row.ncmec_file_id;
  if (!fileId) {
    fileId = await uploadFile(row, reportId);
    // /fileinfo is accepted only once per uploaded file. Persist fileId only after its
    // generative-AI annotation succeeds: if this process dies earlier, the retry uploads a new
    // file within the SAME report instead of repeating /fileinfo against the old file ID.
    await apiRequest('/fileinfo', {
      method: 'POST',
      headers: { 'Content-Type': XML_CONTENT_TYPE },
      body: fileDetailsXml(row, reportId, fileId),
    });
    await db.execute(sql`
      UPDATE generations SET ncmec_file_id = ${fileId}
      WHERE id = ${generationId}::uuid AND ncmec_file_id IS NULL
    `);
  }
  await finishReport(reportId);
  await db.execute(sql`
    UPDATE generations SET ncmec_reported_at = now()
    WHERE id = ${generationId}::uuid AND ncmec_report_id = ${reportId}
  `);
  return reportId;
}
