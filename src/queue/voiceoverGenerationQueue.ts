// src/queue/voiceoverGenerationQueue.ts
// Re-export the voiceover generation queue so route handlers can enqueue jobs while the worker
// lives in voiceoverGenerationWorker.ts.

export {
  voiceoverGenerationQueue,
  type VoiceoverGenerationJob,
} from './voiceoverGenerationWorker';
