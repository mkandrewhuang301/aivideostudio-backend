const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({ db: { execute: mockExecute } }));

const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({
  r2: { send: mockR2Send },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('../../config', () => ({
  config: {
    ncmecEspUsername: 'esp-user',
    ncmecEspPassword: 'esp-password',
    ncmecReporterEmail: 'reporter@example.com',
    ncmecApiBaseUrl: 'https://exttest.cybertip.org/ispws',
  },
}));

import { Readable } from 'node:stream';
import { reportGenerationToNcmec } from '../../services/ncmecReportService';

const GENERATION = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  prompt: 'test prompt',
  r2_key: 'quarantine/11111111-1111-4111-8111-111111111111/output.mp4',
  created_at: new Date('2026-07-19T12:00:00.000Z'),
  ncmec_report_id: null,
  ncmec_file_id: null,
  ncmec_reported_at: null,
};

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function xmlResponse(body: string) {
  return { ok: true, status: 200, text: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockR2Send.mockResolvedValue({ Body: Readable.from([Buffer.from('flagged-media')]) });
});

it('submits, streams, annotates, finishes, and persists one report ID', async () => {
  mockExecute
    .mockResolvedValueOnce({ rows: [GENERATION] })
    .mockResolvedValueOnce({ rows: [{ id: GENERATION.id }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [{ ...GENERATION, ncmec_report_id: 'report-123' }],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
  mockFetch
    .mockResolvedValueOnce(xmlResponse('<response><responseCode>0</responseCode><reportId>report-123</reportId></response>'))
    .mockResolvedValueOnce(xmlResponse('<response><responseCode>0</responseCode><fileId>file-456</fileId></response>'))
    .mockResolvedValueOnce(xmlResponse('<response><responseCode>0</responseCode></response>'))
    .mockResolvedValueOnce(xmlResponse('<response><responseCode>0</responseCode></response>'));

  await expect(reportGenerationToNcmec(GENERATION.id)).resolves.toBe('report-123');

  expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
    'https://exttest.cybertip.org/ispws/submit',
    'https://exttest.cybertip.org/ispws/upload',
    'https://exttest.cybertip.org/ispws/fileinfo',
    'https://exttest.cybertip.org/ispws/finish',
  ]);
  const submitBody = String(mockFetch.mock.calls[0][1].body);
  const fileInfoBody = String(mockFetch.mock.calls[2][1].body);
  expect(submitBody).toContain('No human reviewer viewed the media');
  expect(fileInfoBody).toContain('<generativeAi />');
  expect(fileInfoBody).toContain('<fileViewedByEsp>false</fileViewedByEsp>');
  expect(mockR2Send).toHaveBeenCalledTimes(1);
});

it('returns the stored report ID without a second API call after finish', async () => {
  mockExecute.mockResolvedValueOnce({
    rows: [{
      ...GENERATION,
      ncmec_report_id: 'report-existing',
      ncmec_file_id: 'file-existing',
      ncmec_reported_at: new Date('2026-07-19T12:05:00.000Z'),
    }],
  });

  await expect(reportGenerationToNcmec(GENERATION.id)).resolves.toBe('report-existing');
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockR2Send).not.toHaveBeenCalled();
});

it('refuses to open a duplicate when an earlier submit has an ambiguous pending reservation', async () => {
  mockExecute.mockResolvedValueOnce({
    rows: [{ ...GENERATION, ncmec_report_id: 'pending:ambiguous' }],
  });

  await expect(reportGenerationToNcmec(GENERATION.id))
    .rejects.toThrow('manual reconciliation required');
  expect(mockFetch).not.toHaveBeenCalled();
});
