import { describe, it, expect } from 'vitest';
import { classifyResponse } from './response.classifier.js';

describe('classifyResponse', () => {
  it('returns considering with 0 confidence for empty / missing input', () => {
    expect(classifyResponse('')).toMatchObject({ status: 'considering', confidence: 0 });
    expect(classifyResponse('   ')).toMatchObject({ status: 'considering', confidence: 0 });
    expect(classifyResponse(undefined)).toMatchObject({ status: 'considering', confidence: 0 });
  });

  it('classifies a clear Hebrew accept', () => {
    const r = classifyResponse('מעוניין, נשמע טוב');
    expect(r.status).toBe('accepted');
    expect(r.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('classifies a clear Hebrew decline', () => {
    const r = classifyResponse('מוותר, לא רלוונטי');
    expect(r.status).toBe('declined');
    expect(r.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('classifies a Hebrew "considering" reply', () => {
    const r = classifyResponse('אני אחשוב על זה, אחזור אליך');
    expect(r.status).toBe('considering');
  });

  it('classifies English accept and decline', () => {
    expect(classifyResponse('yes, sounds good').status).toBe('accepted');
    expect(classifyResponse("no thanks, I'll pass").status).toBe('declined');
  });

  it('gives higher confidence for multiple same-intent hits', () => {
    const single = classifyResponse('מעוניין');
    const multi = classifyResponse('מעוניין, נשמע טוב, בשמחה');
    expect(multi.confidence).toBeGreaterThan(single.confidence);
  });

  it('never throws on noise / unrelated text', () => {
    const r = classifyResponse('שבוע טוב לכולם 🙂');
    expect(['accepted', 'declined', 'considering']).toContain(r.status);
  });
});
