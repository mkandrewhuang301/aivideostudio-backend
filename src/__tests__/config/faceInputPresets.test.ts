import { isRealFaceGenerationPath } from '../../config/faceInputPresets';

it.each([
  ['faceswap', 'faceswap'],
  ['ai-influencer', 'character_replace'],
  ['motion-transfer', 'avatar'],
  ['viral-motions', 'video'],
  ['you-vs-you', 'chain'],
] as const)('classifies %s / %s as a real-face path', (presetId, mediaType) => {
  expect(isRealFaceGenerationPath(presetId, mediaType)).toBe(true);
});

it.each([
  [undefined, 'video'],
  [undefined, 'image'],
  [undefined, 'format'],
  ['explainer', 'format'],
  ['kling-o3-elements', 'video'],
] as const)('leaves %s / %s outside the blocking output-scan boundary', (presetId, mediaType) => {
  expect(isRealFaceGenerationPath(presetId, mediaType)).toBe(false);
});
