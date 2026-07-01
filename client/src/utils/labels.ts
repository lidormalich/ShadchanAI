// ═══════════════════════════════════════════════════════════
// Enum-to-Hebrew labels. Keep in sync with shared/types/enums.ts.
// Any unknown value falls back to the original string.
// ═══════════════════════════════════════════════════════════

const MATCH_TYPE: Record<string, string> = {
  safe: 'בטוח',
  balanced: 'מאוזן',
  creative: 'יצירתי',
  risky: 'מסוכן',
};

const RISK_LEVEL: Record<string, string> = {
  none: 'ללא',
  low: 'נמוך',
  medium: 'בינוני',
  high: 'גבוה',
};

const MATCH_STATUS: Record<string, string> = {
  draft: 'טיוטה',
  pending_approval: 'ממתין לאישור',
  approved: 'אושר',
  sent_side_a: 'נשלח לצד א',
  sent_side_b: 'נשלח לצד ב',
  sent_both: 'נשלח לשני הצדדים',
  accepted_side_a: 'אושר ע״י צד א',
  accepted_side_b: 'אושר ע״י צד ב',
  accepted_both: 'אושר ע״י שני הצדדים',
  dating: 'בהיכרות',
  declined_side_a: 'נדחה ע״י צד א',
  declined_side_b: 'נדחה ע״י צד ב',
  deferred: 'מושהה',
  expired: 'פג תוקף',
  closed: 'סגור',
};

const CLOSURE_REASON: Record<string, string> = {
  engaged: 'התארס/ה',
  married: 'התחתן/ה',
  not_interested: 'לא מעוניין/ת',
  taking_break: 'בהפסקה',
  left_system: 'עזב/ה את המערכת',
  shadchan_decision: 'החלטת שדכן',
  other: 'אחר',
};

const CANDIDATE_STATUS: Record<string, string> = {
  active: 'פעיל',
  paused: 'בהשהיה',
  dating: 'בהיכרות',
  closed: 'סגור',
  archived: 'בארכיון',
};

const AVAILABILITY_STATUS: Record<string, string> = {
  available: 'זמין',
  dating: 'בהיכרות',
  unavailable: 'לא זמין',
  unknown: 'לא ידוע',
};

const CHANNEL_ROLE: Record<string, string> = {
  profiles_source: 'מקור פרופילים',
  match_sending: 'שליחת הצעות',
};

const CHANNEL_STATUS: Record<string, string> = {
  active: 'פעיל',
  disconnected: 'מנותק',
  rate_limited: 'מוגבל קצב',
  suspended: 'מושעה',
  replaced: 'הוחלף',
};

const CONNECTION_HEALTH: Record<string, string> = {
  healthy: 'תקין',
  degraded: 'חלקי',
  down: 'מנותק',
};

const WEBHOOK_STATUS: Record<string, string> = {
  verified: 'מאומת',
  pending: 'בהמתנה',
  failed: 'נכשל',
};

const PAIRING_STATUS: Record<string, string> = {
  idle: 'לא פעיל',
  connecting: 'מתחבר…',
  pending_pairing: 'ממתין לסריקת QR',
  connected: 'מחובר',
  reconnecting: 'מתחבר מחדש…',
  disconnected: 'מנותק',
  logged_out: 'מנותק (נדרשת התחברות מחדש)',
};

const NOTE_VISIBILITY: Record<string, string> = {
  internal: 'פנימי',
  sensitive: 'רגיש',
  operational: 'תפעולי',
  shared: 'משותף',
};

const LIFE_STAGE: Record<string, string> = {
  post_high_school: 'אחרי תיכון',
  national_service: 'שירות לאומי',
  army: 'צבא',
  yeshiva_seminary: 'ישיבה/סמינר',
  early_studies: 'תחילת לימודים',
  mid_studies: 'באמצע לימודים',
  early_career: 'תחילת קריירה',
  established_career: 'קריירה מבוססת',
  mature: 'בוגר/ת',
};

const STUDY_WORK_DIRECTION: Record<string, string> = {
  full_time_torah: 'לימוד תורה במלואו',
  torah_with_work: 'תורה ועבודה',
  academic_studies: 'לימודים אקדמיים',
  professional_training: 'הכשרה מקצועית',
  working: 'עובד/ת',
  military_career: 'קריירה צבאית',
  entrepreneurial: 'יזמות',
  hesder: 'הסדר',
  mechina_army: 'מכינה/צבא',
  sherut_leumi: 'שירות לאומי',
  undecided: 'טרם הוחלט',
};

const SUB_SECTOR: Record<string, string> = {
  dati_leumi_open: 'דתי לאומי פתוח',
  dati_leumi_classic: 'דתי לאומי קלאסי',
  dati_leumi_torani: 'דתי לאומי תורני',
  haredi_litvish: 'חרדי ליטאי',
  haredi_hasidic: 'חרדי חסידי',
  haredi_sephardi: 'חרדי ספרדי',
  haredi_modern: 'חרדי מודרני',
  dati_lite: 'דתי לייט',
  dati_classic: 'דתי קלאסי',
  hardal_classic: 'חרדלי קלאסי',
  hardal_open: 'חרדלי פתוח',
  other: 'אחר',
};

const SECTOR_GROUP: Record<string, string> = {
  dati_leumi: 'דתי לאומי',
  haredi: 'חרדי',
  dati: 'דתי',
  masorti: 'מסורתי',
  hardal: 'חרדל',
  torani: 'תורני',
  other: 'אחר',
};

const REGION: Record<string, string> = {
  north: 'צפון',
  haifa_krayot: 'חיפה והקריות',
  sharon: 'השרון',
  gush_dan: 'גוש דן',
  jerusalem: 'ירושלים והסביבה',
  shfela: 'שפלה',
  south: 'דרום',
  yosh: 'יהודה ושומרון',
};

const CHILDREN_PREFERENCE: Record<string, string> = {
  large_family: 'משפחה גדולה',
  balanced: 'מאוזן',
  small_family: 'משפחה קטנה',
  flexible: 'גמיש',
  undecided: 'טרם הוחלט',
};

const CAREER_PRIORITY: Record<string, string> = {
  torah_focused: 'עדיפות לתורה',
  balanced: 'תורה ועבודה מאוזן',
  career_focused: 'עדיפות לקריירה',
  flexible: 'גמיש',
};

const SCORING_DIMENSION: Record<string, string> = {
  age: 'גיל',
  sector: 'מגזר',
  lifestyle: 'אורח חיים',
  study_work: 'לימודים / עבודה',
  location: 'מיקום',
  mutual_expectations: 'ציפיות הדדיות',
  life_stage: 'שלב חיים',
  flexibility: 'גמישות',
};

const TASK_STATUS: Record<string, string> = {
  open: 'פתוחה',
  in_progress: 'בטיפול',
  completed: 'הושלמה',
  cancelled: 'בוטלה',
  deferred: 'נדחתה',
};

const MESSAGE_DELIVERY: Record<string, string> = {
  pending: 'ממתין',
  sent: 'נשלח',
  delivered: 'נמסר',
  read: 'נקרא',
  failed: 'נכשל',
};

const MESSAGE_CONTENT_TYPE: Record<string, string> = {
  text: 'טקסט',
  image: 'תמונה',
  document: 'מסמך',
  audio: 'שמע',
  video: 'וידאו',
  location: 'מיקום',
  contact: 'איש קשר',
  sticker: 'סטיקר',
  template: 'תבנית',
  interactive: 'אינטראקטיבי',
};

const CONVERSATION_PURPOSE: Record<string, string> = {
  profile_intake: 'איסוף פרופיל',
  match_proposal: 'הצעת שידוך',
  follow_up: 'מעקב',
  general: 'כללי',
};

const TASK_TYPE: Record<string, string> = {
  follow_up: 'מעקב',
  call_candidate: 'שיחה עם מועמד',
  send_proposal: 'שליחת הצעה',
  verify_profile: 'אימות פרופיל',
  check_dating_status: 'בדיקת סטטוס היכרות',
  review_match: 'סקירת התאמה',
  general: 'כללי',
};

const TASK_PRIORITY: Record<string, string> = {
  low: 'נמוכה',
  medium: 'בינונית',
  high: 'גבוהה',
  urgent: 'דחוף',
};

const RECOMMENDED_ACTION: Record<string, string> = {
  send_to_both: 'שליחה לשני הצדדים',
  send_side_a_first: 'שליחה לצד א תחילה',
  auto_review_queue: 'לתור סקירה',
  review_required: 'דורש סקירה',
  hold_for_more_data: 'המתנה להשלמת מידע',
  wait: 'המתנה',
  skip: 'דילוג',
};

const PERSONAL_STATUS: Record<string, string> = {
  single: 'רווק/ה',
  divorced: 'גרוש/ה',
  widowed: 'אלמן/ה',
  separated: 'פרוד/ה',
};

const READINESS_FOR_MARRIAGE: Record<string, string> = {
  actively_looking: 'מחפש/ת בפעילות',
  open: 'פתוח/ה',
  exploring: 'בוחן/ת',
  not_ready: 'לא מוכן/ה',
  on_hold: 'בהמתנה',
};

const LIFESTYLE_TONE: Record<string, string> = {
  very_strict: 'מחמיר מאוד',
  strict: 'מחמיר',
  moderate: 'מתון',
  relaxed: 'רגוע',
  flexible: 'גמיש',
};

const RELIGIOUS_STYLE: Record<string, string> = {
  halachic_strict: 'הלכתי מחמיר',
  halachic_mainstream: 'הלכתי מרכזי',
  traditional_observant: 'מסורתי שומר',
  spiritual_flexible: 'רוחני גמיש',
  cultural: 'תרבותי',
};

const GENDER: Record<string, string> = {
  male: 'גבר',
  female: 'אישה',
};

const SOURCE_TYPE: Record<string, string> = {
  whatsapp_group: 'קבוצת WhatsApp',
  matchmaker_referral: 'הפניית שדכן',
  website: 'אתר',
  manual_entry: 'הזנה ידנית',
  other: 'אחר',
};

const FIELD_NAME: Record<string, string> = {
  firstName: 'שם פרטי',
  lastName: 'שם משפחה',
  hebrewName: 'שם עברי',
  gender: 'מין',
  dateOfBirth: 'תאריך לידה',
  phone: 'טלפון',
  email: 'אימייל',
  city: 'עיר',
  sectorGroup: 'מגזר',
  subSector: 'תת־מגזר',
  personalStatus: 'מצב אישי',
  lifeStage: 'שלב חיים',
  readinessForMarriage: 'מוכנות לנישואין',
  studyWorkDirection: 'כיוון לימודים/עבודה',
  lifestyleTone: 'גוון דתי',
  religiousStyle: 'סגנון הלכתי',
  about: 'על עצמו',
  whatSeeking: 'מה מחפש',
  age: 'גיל',
  height: 'גובה',
  photoUrl: 'תמונה',
  numberOfChildren: 'מספר ילדים',
};

const AGE_CONFIDENCE: Record<string, string> = {
  exact: 'מדויק',
  approximate: 'משוער',
  estimated: 'הערכה',
  unknown: 'לא ידוע',
};

const LOOKUPS: Record<string, Record<string, string>> = {
  matchType: MATCH_TYPE,
  riskLevel: RISK_LEVEL,
  matchStatus: MATCH_STATUS,
  candidateStatus: CANDIDATE_STATUS,
  closureReason: CLOSURE_REASON,
  availabilityStatus: AVAILABILITY_STATUS,
  channelRole: CHANNEL_ROLE,
  channelStatus: CHANNEL_STATUS,
  sectorGroup: SECTOR_GROUP,
  region: REGION,
  childrenPreference: CHILDREN_PREFERENCE,
  careerPriority: CAREER_PRIORITY,
  scoringDimension: SCORING_DIMENSION,
  taskStatus: TASK_STATUS,
  taskType: TASK_TYPE,
  taskPriority: TASK_PRIORITY,
  recommendedAction: RECOMMENDED_ACTION,
  connectionHealth: CONNECTION_HEALTH,
  webhookStatus: WEBHOOK_STATUS,
  pairingStatus: PAIRING_STATUS,
  noteVisibility: NOTE_VISIBILITY,
  lifeStage: LIFE_STAGE,
  studyWorkDirection: STUDY_WORK_DIRECTION,
  subSector: SUB_SECTOR,
  personalStatus: PERSONAL_STATUS,
  readinessForMarriage: READINESS_FOR_MARRIAGE,
  lifestyleTone: LIFESTYLE_TONE,
  religiousStyle: RELIGIOUS_STYLE,
  gender: GENDER,
  sourceType: SOURCE_TYPE,
  ageConfidence: AGE_CONFIDENCE,
  fieldName: FIELD_NAME,
  conversationPurpose: CONVERSATION_PURPOSE,
  messageDeliveryStatus: MESSAGE_DELIVERY,
  messageContentType: MESSAGE_CONTENT_TYPE,
};

export function label(kind: keyof typeof LOOKUPS, value: string | undefined | null): string {
  if (!value) return '—';
  return LOOKUPS[kind]?.[value] ?? value;
}

// ═══════════════════════════════════════════════════════════
// Enum-to-Badge-tone helpers. Tones must stay within the
// BadgeTone union exposed by components/ui/primitives.
// ═══════════════════════════════════════════════════════════

/** Channel status → badge tone. */
export function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'rate_limited') return 'warning';
  if (status === 'disconnected' || status === 'suspended' || status === 'replaced') return 'danger';
  return 'neutral';
}

/** Match type → badge tone. */
export function matchTypeTone(type: string): 'success' | 'brand' | 'warning' | 'danger' {
  if (type === 'safe') return 'success';
  if (type === 'balanced') return 'brand';
  if (type === 'risky') return 'danger';
  return 'warning';
}
