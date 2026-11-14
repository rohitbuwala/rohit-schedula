import assert from 'node:assert/strict';
import { it } from 'node:test';
import { appendSpeechTranscript, speechErrorMessage } from '../components/assistant/assistant-speech.ts';

it('appends speech to an editable draft within the message limit', () => {
  assert.equal(appendSpeechTranscript('Show me ', 'my appointments'), 'Show me my appointments');
  assert.equal(appendSpeechTranscript('', 'my appointments'), 'my appointments');
  assert.equal(appendSpeechTranscript('x'.repeat(999), 'word').length, 1000);
});

it('provides actionable microphone errors without exposing browser details', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'NotAllowedError', 'SecurityError']) assert.match(speechErrorMessage(code), /Microphone access was denied/);
  assert.match(speechErrorMessage('audio-capture'), /No microphone/);
  assert.match(speechErrorMessage('no-speech'), /No speech/);
  assert.match(speechErrorMessage('private browser details'), /Voice input could not/);
});
