import { ProfileExtractionSchema } from '../services/extraction/profile.extractor.js';

// The exact junk that hard-failed before (card #4): empty-string names +
// out-of-range seeking ages + a hallucinated enum. Tolerant schema must
// now keep the good fields and drop the bad ones instead of throwing.
const junk = {
  confidence: 0.8,
  firstName: '',
  lastName: '',
  gender: 'female',
  age: 24,
  height: 160,
  sectorGroup: 'dati_leumi',
  lifeStage: 'not_a_real_enum',
  seekingAgeMin: 0,
  seekingAgeMax: 5,
  contactName: '',
  contactPhone: '050-7514586',
};

const r = ProfileExtractionSchema.safeParse(junk);
if (r.success) {
  console.log('OK — tolerant parse succeeded. Result:');
  console.log(JSON.stringify(r.data, null, 2));
} else {
  console.log('STILL REJECTED:\n' + JSON.stringify(r.error.issues, null, 2));
}
