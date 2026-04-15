// ═══════════════════════════════════════════════════════════
// Tests against the 10 real-world profile samples supplied
// by the operator. These are the regression fixtures — any
// future change to templates.ts / regex.extractor.ts must
// continue to pass these assertions.
// ═══════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { Gender, PersonalStatus, SectorGroup } from '@shadchanai/shared';
import { extractProfileFromText } from './regex.extractor.js';

// ── Sample 1: הדס .ו (female, DL) ────────────────────────
const SAMPLE_1 = `שם: הדס .ו
גיל: 23
גובה: 1.65
עדה : חצי מרוקאית חצי כורדיה
מגורים: ירושלים
רמה דתית: דתיה ( באה מבית חרדי)
השכלה : תואר ראשון בחינוך
עיסוק : עובדת כנציגת מכירות  בחברת כבלים.
תכונות אופי: בחורה קלילה , מבית טוב, כמובן עם שמחת חיים, ורצינות כשצריך
מה מחפשת: מחפשת בחור עם מידות טובות , עם שמחת חיים, שרוצה לבנות את עצמו ולהקיים בית , שהיה לו עבודה מסודרת ושייקבע עיתים לתורה.  לפרטים יעקב שדכן 054-5430011`;

// ── Sample 2: מנשה צמח (male, Haredi) ────────────────────
const SAMPLE_2 = `כרטיסיה קורות חיים
כרטיס שידוכים-
💘שם: מנשה צמח
💘גיל: 25
💘מקום מגורים: ירושלים
💘גובה: 1.62
💘עדה: ערקי וחלבי
💘מגזר+רמה דתית: חרדי
💘עיסוק: חצי יום לימוד תורני חצי יום עובד ולומד תואר
💘תאר בקווים כלליים את משפחתך: משפחה חרידית ישיבתית. אבא אברך אמא עובדת  6 אחים 2 נשואים
💘אני מחפש/ת :  בחורה טובה נראית טוב מתלבשת טוב לא יותר מדי מודרני. קלאסי טוב.
מאוד חשוב לי שיהיה לה מידות טובות ושמחת חיים.
זורמת.
ראש בריא.
יראת שמים.
כיסוי ראש  פאה.
בוגרת אחראית.  יודעת מה רוצה מעצמה.
למדה מקצוע.
חברותית כיף לנהל איתה שיחה.
בהצלחה לכולם &&

לפניות-0529677868
אוו 0533604100`;

// ── Sample 3: empty "החצי השני" template followed by free-text intro
const SAMPLE_3 = `*כרטיס שידוכים ״החצי השני״*

😊 שם:

👳🏻עדה:

🎂 גיל:

🌱גובה:

🏡 מגורים:

🙏 מגזר+רמה דתית:

👪 תאר/י בקווים כלליים את משפחתך :

‏🇮🇱 שירות צבאי/לאומי/ישיבה:

🎓 עיסוק:

👱🏼‍♀️ קצת עלי:

🎯 אני מחפש/ת:

🎚 טווח גילאים:

📸 שתי תמונות יפות וברורות
שמי נתנאל 30/180 מירושלים
עובד בעסק משפחתי .
דתי לייט.
חשוב לי בחורה מכילה.רגישה
 .טובת לב אפשרי מסורתית .שומר נגיעה .שבת.וכד
 משתדל מאד להשקיע בקשר .
מעניק .ככל שניתן
רגיש .ומכיל.
בשאיפה להקים  בית חם ואוהב
אם נראה לך שמתאימה מוזמנת ליצור קשר.
אלישבע0509000318`;

// ── Sample 4: ניסים מקסים (male, widower, DL) ─────────────
const SAMPLE_4 = `כרטיס שידוכים:
🌷שם:  ניסים מקסים
🌷גיל:  61
🌷סטטוס:  אלמן
🌷גובה :   172
🌷מוצא : יליד צרפת
🌷א. מגורים: ירושלים
🌷מגזר+רמה דתית: דתי לאומי
🌷עיסוק: מהנדס
🌷תכונות מאופי:   אוהב לטייל, אוהב את החיים, אדם טוב מידות טובות , דובר עברית אנגלית צרפתית וערבית.
🌷תאר/י בקווים כללים את       משפחתך.
🌷אני  מחפש/ת: רצינית, עדינה, לא משנה העדה,   מגורים רק בירושלים`;

// ── Sample 5: אסתר (female, DL torani, single) ──────────
const SAMPLE_5 = `*שידוכים לשם שמיים*        ✨✨✨✨✨✨✨
 *שם*: אסתר
*סטטוס*: רווקה
 *גיל*: 30
*גובה*: 1.55 מ'
*מגורים בהווה ומגורי המשפחה*: בית שאן
*רמה דתית*: דתיה לאומית תורנית
 *שירות צבאי/לאומי*: שירות לאומי (שנתיים)
*עיסוק+מוסדות לימודים*: למדתי בתיכון קיבוצי דתי ולאחריו הלכתי לשנת מדרשה בגבעת וושינגטון. סיימתי תואר ראשון בעברית במתמטיקה ומנהע"ס.
כרגע עובדת בחיפה.
*תכונות אופי*: משפחתית, חמה, ביישנית ואוהבת לעזור.
*אני מחפש/ת*: בחור לאחר שירות צבאי שלמד בישיבה לאחר התיכון (עדיפות לבוגר הסדר). בעל השקפה דתית לאומית תורנית. בחור טוב לב.
*חברה ממליצה*:(אין להתקשר ללא בירור ראשוני דרך אלישבע) יערה 0508807782
אלישבע השדכנית : רק בוואטסאפ 0509000318                                 בע"ה נעשה ונצליח!!!🥂`;

// ── Sample 6: נועה (female, DL, single) ─────────────────
const SAMPLE_6 = `בס"ד
כרטיס שידוך.

😊שם: נועה

🎂גיל:37

🌱גובה:1.56

👳 עדה: ספרדיה

🏡 אזור מגורים: בית שאן

🙏רמה דתית: דתיה

🇮🇱שירות צבאי/
לאומי: שנתיים שרות לאומי ביקנעם

📖ישיבה/ מדרשה: לא

🌡עיסוק+ מוסדות לימוד: גננת משלימה בחינוך המיוחד

🎭תכונות אופי: שקטה וסבלנית

👪תארי בקווים כלליים את משפחתך: משפחה דתייה

🎯אני מחפש/ת: בחור דתי ורציני.

☎ טלפון של השדכן/נית ואו המועמד/ת:


שנזכה לעזור בהקמת בית יהודי
השדכנית אלישבע רק בוואטסאפ לא בשבת
 0509000318`;

// ── Sample 7: הודיה ראובן (female, DL, single) ──────────
const SAMPLE_7 = `*כרטיס שידוכים ״החצי השני״*

😊 שם: הודיה ראובן

👤רווק/גרוש/אלמן: רווקה

👳🏻עדה: פרסיה

🎂 גיל: 20

🌱גובה:  1.62

🏡 מגורים: בת ים

🙏 מגזר+רמה דתית: דתיה לאומית

👪 קצת על משפחתך : משפחה מדהימה, חמה ואוהבת. המשפחה שלי מסורתיים (חזרתי בתשובה לפני שנים)

🎓 עיסוק: סטודנטית לחינוך מיוחד ולשון ועובדת עם נוער

👱🏼‍♀️ קצת עלי:
שמחה, מצחיקה, מחוברת לקודש, בעלת נתינה והקשבה, חייכנית ואופטימית, קלילה ואוהבת, מקבלת את השונה ואוהבת את הבריות, עם עומק פנימי ואופי נוכח. בחורה של עשייה, סקרנית, מקורית, מתעניינת בעולם, טובה מאוד בתקשורת עם אנשים, בחורה אמיתית .

🎯 מה אני מחפש/ת: אדם עם מידות טובות, עם ראיית הטוב, אדם חברותי, שמח, אופטימי וזורם. אדם עם אופי ספרדי אדם שיהיה אפשר לצחוק איתו אבל גם לשבת ולנהל שיחות עומק. בעל נתינה והכלה, ושירצה להתקדם תמיד בכל המישורים .

🎚 טווח גילאים: 21 - 25

📸 שתי תמונות יפות וברורות`;

// ── Sample 8: הדס לוי (female, DL, single) ──────────────
const SAMPLE_8 = `*כרטיס שידוכים ״החצי השני״*

😊 שם: הדס לוי

👤רווק/גרוש/אלמן: רווקה

👳🏻עדה: עדות המזרח

🎂 גיל: 19.5

🌱גובה:  1.70

🏡 מגורים: ירושלים

🙏 מגזר+רמה דתית: דתי לאומי

👪 קצת על משפחתך : אני בכורה מבין 4 ילדים, משפחה מגובשת ושמחה.

🎓 עיסוק: לומדת תואר ראשון בהוראה כוללת וחינוך מיוחד, שנה א. במקביל עובדת בגני חינוך מיוחד.

👱🏼‍♀️ קצת עלי: בחורה שמחה וחייכנית, אוהבת לבשל ולאפות, לבלות עם חברות ומשפחה, אוהבת לטייל ולעשות ספורט.
עשיתי שירות לאומי.
הולכת לשיעורי תורה.
🎯 מה אני מחפש/ת: בחור דתי לאומי, עם שאיפות, ששם דגש על המשפחה, מכבד, חברותי, שהולך בדרך ה' וקובע עיתים לתורה.
מחפשת קשר רציני.

🎚 טווח גילאים: 20-25

📸 שתי תמונות יפות וברורות`;

// ── Sample 9: אביגיל לוין (female, DL open, single) ─────
const SAMPLE_9 = `*כרטיס שידוכים ״החצי השני״*

😊 שם: אביגיל לוין

👤רווק/גרוש/אלמן: רווקה

👳🏻עדה: אשכנזיה

🎂 גיל: 22

🌱גובה:  1.56

🏡 מגורים: ירושלים

🙏 מגזר+רמה דתית: דתי- לאומי פתוח

👪 קצת על משפחתך : יש לי 3 אחים גדולים, אני הקטנה מביניהם.

🎓 עיסוק: סייעת רופא שיניים/ מתכוננת ללימודי רפואת שיניים.

👱🏼‍♀️ קצת עלי: אני בחורה אופטימית, זורמת, שאפתנית עם שמחת חיים ואוהבת להנות מהחיים.

🎯 מה אני מחפש/ת: בחור שמח וזורם, חכם ובעלת שאיפות. אדם מכיל, בעל אינטליגנציה רגשית.

🎚 טווח גילאים: 22-28

📸 שתי תמונות יפות וברורות`;

// ── Sample 10: not-a-profile (a greeting) ────────────────
const NOT_A_PROFILE = `שלום, שלחת לי פרופיל? אני אשמח לדוגמה נוספת.`;

describe('regex.extractor — real samples', () => {
  it('sample 1: הדס .ו — female, age 23, DL-ish, phone captured', () => {
    const r = extractProfileFromText(SAMPLE_1);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('הדס');
    expect(r.profile.lastName).toBe('.ו');
    expect(r.profile.age).toBe(23);
    expect(r.profile.height).toBe(165);
    expect(r.profile.city).toBe('ירושלים');
    expect(r.profile.edah).toContain('מרוקאית');
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI);
    expect(r.profile.gender).toBe(Gender.FEMALE);
    expect(r.profile.contactPhones).toContain('0545430011');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('sample 2: מנשה צמח — male, Haredi, two phones', () => {
    const r = extractProfileFromText(SAMPLE_2);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('מנשה');
    expect(r.profile.lastName).toBe('צמח');
    expect(r.profile.age).toBe(25);
    expect(r.profile.height).toBe(162);
    expect(r.profile.city).toBe('ירושלים');
    expect(r.profile.sectorGroup).toBe(SectorGroup.HAREDI);
    expect(r.profile.gender).toBe(Gender.MALE);
    expect(r.profile.contactPhones).toEqual(expect.arrayContaining(['0529677868', '0533604100']));
  });

  it('sample 3: empty template followed by free text — detected as template form', () => {
    const r = extractProfileFromText(SAMPLE_3);
    expect(r.isTemplateForm).toBe(true);
    expect(r.isLikelyProfile).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it('sample 4: ניסים מקסים — male, widower, DL, 61', () => {
    const r = extractProfileFromText(SAMPLE_4);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('ניסים');
    expect(r.profile.lastName).toBe('מקסים');
    expect(r.profile.age).toBe(61);
    expect(r.profile.height).toBe(172);
    expect(r.profile.personalStatus).toBe(PersonalStatus.WIDOWED);
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI_LEUMI);
    expect(r.profile.city).toBe('ירושלים');
    expect(r.profile.gender).toBe(Gender.MALE);
  });

  it('sample 5: אסתר — female, single, DL torani, phone', () => {
    const r = extractProfileFromText(SAMPLE_5);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('אסתר');
    expect(r.profile.age).toBe(30);
    expect(r.profile.height).toBe(155);
    expect(r.profile.city).toBe('בית שאן');
    expect(r.profile.personalStatus).toBe(PersonalStatus.SINGLE);
    expect(r.profile.gender).toBe(Gender.FEMALE);
    expect(r.profile.contactPhones).toEqual(expect.arrayContaining(['0508807782', '0509000318']));
  });

  it('sample 6: נועה — female, DL, age 37', () => {
    const r = extractProfileFromText(SAMPLE_6);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('נועה');
    expect(r.profile.age).toBe(37);
    expect(r.profile.height).toBe(156);
    expect(r.profile.edah).toContain('ספרדיה');
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI);
    expect(r.profile.contactPhones).toContain('0509000318');
  });

  it('sample 7: הודיה ראובן — female, DL, age range 21-25', () => {
    const r = extractProfileFromText(SAMPLE_7);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('הודיה');
    expect(r.profile.lastName).toBe('ראובן');
    expect(r.profile.age).toBe(20);
    expect(r.profile.height).toBe(162);
    expect(r.profile.personalStatus).toBe(PersonalStatus.SINGLE);
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI_LEUMI);
    expect(r.profile.seekingAgeMin).toBe(21);
    expect(r.profile.seekingAgeMax).toBe(25);
    expect(r.profile.gender).toBe(Gender.FEMALE);
  });

  it('sample 8: הדס לוי — female, DL, age 19.5 → 20 (rounded)', () => {
    const r = extractProfileFromText(SAMPLE_8);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('הדס');
    expect(r.profile.lastName).toBe('לוי');
    expect(r.profile.age).toBe(20);
    expect(r.profile.ageText).toContain('19.5');
    expect(r.profile.height).toBe(170);
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI_LEUMI);
    expect(r.profile.seekingAgeMin).toBe(20);
    expect(r.profile.seekingAgeMax).toBe(25);
  });

  it('sample 9: אביגיל לוין — female, DL open', () => {
    const r = extractProfileFromText(SAMPLE_9);
    expect(r.isLikelyProfile).toBe(true);
    expect(r.profile.firstName).toBe('אביגיל');
    expect(r.profile.lastName).toBe('לוין');
    expect(r.profile.age).toBe(22);
    expect(r.profile.height).toBe(156);
    expect(r.profile.sectorGroup).toBe(SectorGroup.DATI_LEUMI);
    expect(r.profile.personalStatus).toBe(PersonalStatus.SINGLE);
    expect(r.profile.seekingAgeMin).toBe(22);
    expect(r.profile.seekingAgeMax).toBe(28);
  });

  it('non-profile message — not flagged as profile', () => {
    const r = extractProfileFromText(NOT_A_PROFILE);
    expect(r.isLikelyProfile).toBe(false);
    expect(r.confidence).toBeLessThan(0.3);
  });
});
