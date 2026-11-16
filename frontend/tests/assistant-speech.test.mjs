import assert from 'node:assert/strict';
import { it } from 'node:test';
import { appendSpeechTranscript, assistantReplyLanguage, assistantSpokenReply, speechErrorMessage } from '../components/assistant/assistant-speech.ts';

it('matches Hindi or mixed Hindi input automatically and respects an explicit preference', () => {
  assert.equal(assistantReplyLanguage('मेरी next booking कब की है?', 'auto'), 'hi');
  assert.equal(assistantReplyLanguage('My appointments', 'hi'), 'hi');
  assert.equal(assistantReplyLanguage('मेरी अपॉइंटमेंट', 'en'), 'en');
  assert.equal(assistantReplyLanguage('My appointments', 'auto'), 'en');
});

it('speaks actual appointment times without adding patient names to speech requests', () => {
  const result = { tool: 'upcoming_appointments', reply: 'Here are your upcoming appointments.', data: {
    timezone: 'Asia/Kolkata', appointments: [{ patient: { name: 'Private Name' }, startsAt: '2026-11-16T04:30:00Z', endsAt: '2026-11-16T04:45:00Z' }],
  } };
  const spoken = assistantSpokenReply(result);
  assert.match(spoken, /16 Nov 2026/);
  assert.match(spoken, /10:00/);
  assert.match(spoken, /10:15/);
  assert.doesNotMatch(spoken, /Private Name/);
});

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
