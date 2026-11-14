import { describe, expect, it } from 'vitest';
import { isAllowedFrontendOrigin } from './main.js';

describe('CORS Origin Validation (isAllowedFrontendOrigin)', () => {
  const configuredOrigin = 'http://localhost:3000';

  it('allows exact configured frontend origin (e.g. localhost)', () => {
    expect(isAllowedFrontendOrigin('http://localhost:3000', configuredOrigin)).toBe(true);
  });

  it('allows production Vercel domain', () => {
    expect(isAllowedFrontendOrigin('https://rohit-schedula.vercel.app', configuredOrigin)).toBe(true);
  });

  it('allows legitimate team-scoped branch preview origin', () => {
    const branchPreview =
      'https://rohit-schedula-git-feat-ai-voice-chat-assistant-rohit-buwalas-projects.vercel.app';
    expect(isAllowedFrontendOrigin(branchPreview, configuredOrigin)).toBe(true);
  });

  it('allows legitimate team-scoped commit/deployment preview origin', () => {
    const commitPreview = 'https://rohit-schedula-b5uapvz4-rohit-buwalas-projects.vercel.app';
    expect(isAllowedFrontendOrigin(commitPreview, configuredOrigin)).toBe(true);
  });

  it('rejects arbitrary rohit-schedula-*.vercel.app without team suffix', () => {
    expect(isAllowedFrontendOrigin('https://rohit-schedula-evil.vercel.app', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('https://rohit-schedula-attacker.vercel.app', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('https://rohit-schedula-preview.vercel.app', configuredOrigin)).toBe(false);
  });

  it('rejects unrelated Vercel project origins', () => {
    expect(isAllowedFrontendOrigin('https://evil-doctor-app.vercel.app', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('https://another-project.vercel.app', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('https://evil-rohit-buwalas-projects.vercel.app', configuredOrigin)).toBe(false);
  });

  it('rejects insecure HTTP preview origins', () => {
    const httpPreview =
      'http://rohit-schedula-git-feat-ai-voice-chat-assistant-rohit-buwalas-projects.vercel.app';
    expect(isAllowedFrontendOrigin(httpPreview, configuredOrigin)).toBe(false);
  });

  it('rejects malformed, empty, or non-http origin strings', () => {
    expect(isAllowedFrontendOrigin('not-a-valid-url', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('javascript:alert(1)', configuredOrigin)).toBe(false);
    expect(isAllowedFrontendOrigin('ftp://rohit-schedula.vercel.app', configuredOrigin)).toBe(false);
  });
});
