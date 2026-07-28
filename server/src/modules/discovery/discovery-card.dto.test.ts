import { describe, it, expect } from 'vitest';
import { sanitizeCardText, buildDiscoveryCardDTO } from './discovery-card.dto.js';

describe('sanitizeCardText', () => {
  const identity = { firstName: 'מיכל', lastName: 'כהן' };

  it('strips the candidate name including prefixed forms staying intact', () => {
    const out = sanitizeCardText('מיכל כהן היא בחורה מקסימה', identity);
    expect(out).not.toContain('מיכל');
    expect(out).not.toContain('כהן');
    expect(out).toContain('בחורה מקסימה');
  });

  it('strips Israeli phone numbers in local and international form', () => {
    expect(sanitizeCardText('להתקשר 050-1234567 בערב', identity)).not.toMatch(/\d{7}/);
    expect(sanitizeCardText('טלפון +972 50 123 4567 זמין', identity)).not.toMatch(/972/);
  });

  it('strips emails and URLs', () => {
    const out = sanitizeCardText('אפשר במייל foo@example.com או באתר https://x.co/p', identity);
    expect(out).not.toContain('@');
    expect(out).not.toContain('http');
  });

  it('returns undefined for empty results and truncates long text', () => {
    expect(sanitizeCardText('מיכל כהן', identity)).toBeUndefined();
    expect(sanitizeCardText(undefined, identity)).toBeUndefined();
    const long = sanitizeCardText('א'.repeat(500), identity, 300);
    expect(long).toHaveLength(300); // 299 chars + ellipsis
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('buildDiscoveryCardDTO', () => {
  const ext = {
    firstName: 'שרה',
    lastName: 'לוי',
    age: 27,
    region: 'jerusalem',
    sectorGroup: 'dati_leumi',
    subSector: 'dati_leumi_torani',
    personalStatus: 'single',
    currentOccupation: 'מורה',
    educationLevel: 'תואר ראשון',
    height: 165,
    about: 'שרה בחורה ערכית, טלפון 0501234567',
    aiEnrichment: undefined,
  };

  it('never leaks PII keys or values into the serialized card', () => {
    const dto = buildDiscoveryCardDTO('card1', ext, ['התאמה מגזרית'], false);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('שרה');
    expect(json).not.toContain('לוי');
    expect(json).not.toContain('0501234567');
    expect(json).not.toContain('firstName');
    expect(json).not.toContain('lastName');
    expect(json).not.toContain('city');
    expect(json).not.toContain('phone');
    expect(json).not.toContain('_id');
  });

  it('translates enums to Hebrew labels and keeps facts', () => {
    const dto = buildDiscoveryCardDTO('card1', ext, ['a', 'b', 'c', 'd'], true);
    expect(dto.regionLabel).toBe('ירושלים והסביבה');
    expect(dto.sectorGroupLabel).toBe('דתי לאומי');
    expect(dto.personalStatusLabel).toBe('רווק/ה');
    expect(dto.age).toBe(27);
    expect(dto.highlights).toHaveLength(3); // capped
    expect(dto.hasPhoto).toBe(true);
  });

  it('prefers the AI enrichment summary over raw about text', () => {
    const dto = buildDiscoveryCardDTO(
      'c',
      { ...ext, aiEnrichment: { summary: 'בחורה ערכית ושמחה' } },
      [],
      false,
    );
    expect(dto.summary).toBe('בחורה ערכית ושמחה');
  });
});
