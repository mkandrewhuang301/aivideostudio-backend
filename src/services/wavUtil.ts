interface ParsedWav {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  fmtChunk: Buffer;
  dataChunks: Buffer[];
  dataSize: number;
}

function parseWav(wav: Buffer): ParsedWav {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV: expected a RIFF/WAVE container');
  }

  let fmtChunk: Buffer | undefined;
  const dataChunks: Buffer[] = [];
  let offset = 12;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > wav.length) throw new Error(`Invalid WAV: truncated ${chunkId} chunk`);

    if (chunkId === 'fmt ') fmtChunk = wav.subarray(dataStart, dataEnd);
    if (chunkId === 'data') dataChunks.push(wav.subarray(dataStart, dataEnd));

    offset = dataEnd + (chunkSize % 2);
  }

  if (!fmtChunk || fmtChunk.length < 16) throw new Error('Invalid WAV: missing fmt chunk');
  if (dataChunks.length === 0) throw new Error('Invalid WAV: missing data chunk');

  const audioFormat = fmtChunk.readUInt16LE(0);
  const channels = fmtChunk.readUInt16LE(2);
  const sampleRate = fmtChunk.readUInt32LE(4);
  const byteRate = fmtChunk.readUInt32LE(8);
  const blockAlign = fmtChunk.readUInt16LE(12);
  const bitsPerSample = fmtChunk.readUInt16LE(14);
  const dataSize = dataChunks.reduce((total, chunk) => total + chunk.length, 0);
  if (channels <= 0 || sampleRate <= 0 || byteRate <= 0 || blockAlign <= 0 || bitsPerSample <= 0) {
    throw new Error('Invalid WAV: unusable audio format');
  }

  return {
    audioFormat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    fmtChunk,
    dataChunks,
    dataSize,
  };
}

export function wavDurationSeconds(wav: Buffer): number {
  const parsed = parseWav(wav);
  return parsed.dataSize / parsed.byteRate;
}

export function concatWavBuffers(wavs: Buffer[]): Buffer {
  if (wavs.length === 0) throw new Error('Cannot concatenate an empty WAV list');
  const parsed = wavs.map(parseWav);
  const expected = parsed[0];

  for (const current of parsed.slice(1)) {
    if (
      current.audioFormat !== expected.audioFormat
      || current.channels !== expected.channels
      || current.sampleRate !== expected.sampleRate
      || current.byteRate !== expected.byteRate
      || current.blockAlign !== expected.blockAlign
      || current.bitsPerSample !== expected.bitsPerSample
      || !current.fmtChunk.equals(expected.fmtChunk)
    ) {
      throw new Error('Cannot concatenate WAVs with mismatched formats');
    }
  }

  const audioData = Buffer.concat(parsed.flatMap((item) => item.dataChunks));
  const fmtPadding = expected.fmtChunk.length % 2;
  const dataPadding = audioData.length % 2;
  const outputSize = 12 + 8 + expected.fmtChunk.length + fmtPadding + 8 + audioData.length + dataPadding;
  if (outputSize - 8 > 0xffffffff || audioData.length > 0xffffffff) {
    throw new Error('Concatenated WAV is too large for a RIFF container');
  }

  const output = Buffer.alloc(outputSize);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(expected.fmtChunk.length, 16);
  expected.fmtChunk.copy(output, 20);
  const dataHeaderOffset = 20 + expected.fmtChunk.length + fmtPadding;
  output.write('data', dataHeaderOffset, 'ascii');
  output.writeUInt32LE(audioData.length, dataHeaderOffset + 4);
  audioData.copy(output, dataHeaderOffset + 8);
  return output;
}
