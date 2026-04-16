# ShadchanAI — Pilot QA Checklist

Execute every case in order on a staging DB seeded with at least 2 active
`match_sending` channels, 1 `profiles_source` channel, 2 shadchan users
(`userA`, `userB`), and a handful of internal + external candidates of both
genders. Each case is independent: run it, confirm the expected result, then
reset the relevant state before the next case.

**Legend**
- ✅ PASS criteria — what you should see.
- ❌ FAIL signals — if any of these appear, stop and report.

---

## 2.1  WhatsApp Session Lifecycle

### 2.1.1  Pair a new channel
1. ChannelsPage → "חבר ערוץ חדש" → role=`profiles_source`, display name "Intake Test".
2. On the new channel card, click "התחל סשן".
3. When the QR modal appears, scan it from a test WhatsApp account within ~20 s.
4. Wait until status flips to `connected`.

✅ Channel card shows `status=active`, `connectionHealth=healthy`. A toast or realtime refresh removes the QR modal automatically.
❌ QR never updates after 20 s → auto-refresh broken. Status stuck at `pending_pairing` after a successful scan → session-store write failed.

### 2.1.2  QR refresh (must rotate)
1. Start a new session as above.
2. DO NOT scan for 30 s. Watch the QR modal.

✅ QR image changes at least once within 30 s.
❌ Same QR for the full interval.

### 2.1.3  Concurrent session-start guard
1. Open ChannelsPage in two browser tabs.
2. Click "התחל סשן" on the same channel in both tabs within 1 s.

✅ One tab opens the QR modal. The other shows the toast `A session-start is already in progress for this channel.`.
❌ Both tabs get a QR (two live sessions on one channel).

### 2.1.4  Disconnect
1. Channel is `active`. Click "נתק" → confirm.

✅ Status becomes `disconnected`. Page updates without manual refresh (SSE push). Conversation history is still visible.
❌ Status frozen at `active` in other open tabs after 10 s.

### 2.1.5  Reconnect
1. A disconnected channel whose session files still exist. Click "חבר מחדש".

✅ Status returns to `active` without a new QR scan.
❌ A new QR appears (implies session files were purged — should only happen on logout).

### 2.1.6  Logout (credential purge)
1. Click "יציאה מהחשבון" on an active channel → confirm.

✅ Status transitions away from `active`; the next "התחל סשן" produces a fresh QR.
❌ Next start immediately reconnects without QR (credentials weren't purged).

### 2.1.7  Replace
1. Click "החלפת חשבון" → supply new display name + phone, confirm.

✅ Old channel row is marked `replaced`. A new channel row appears in `disconnected` state, ready to pair. Conversations from the old channel still open and show the "continues from replaced account" banner.
❌ Old channel disappears entirely, or new channel is auto-created as `active` without pairing.

---

## 2.2  Inbound Profile Ingestion

Setup: send the following messages to the `profiles_source` test WhatsApp number.

### 2.2.1  Plain text profile
Send a formatted profile message ("דנה כהן, בת 27, מירושלים, דתית-לאומית, מעוניינת בתורני-עובד, 0501234567").

✅ Message appears in /chats within SSE latency. Within a few seconds the message badge reads "נוצר מועמד חדש" or "ממתין לסקירה". A matching ExternalCandidate exists in /candidates/external.
❌ Badge stays "מעבד פרופיל…" indefinitely; no ExternalCandidate is created and no review-queue row appears.

### 2.2.2  Image + caption profile
Send an image with a caption containing the same profile text.

✅ Same outcome as 2.2.1. The extraction runs on the caption.
❌ Badge reads "לא פרופיל" or no extraction attempt.

### 2.2.3  Pure media (no caption)
Send an image (or voice note) with no caption.

✅ Badge explicitly shows "לא פרופיל" with reason `no_text`. The message is NOT in /review.
❌ Badge shows "מעבד…" forever, or the message appears silently with no badge.

### 2.2.4  Duplicate profile
Immediately re-send the same profile text (same phone number) from a different WhatsApp participant.

✅ The pipeline matches the existing external candidate. Badge reads "זוהה כמועמד קיים". No duplicate ExternalCandidate row is created (check `/candidates/external` count).
❌ A second ExternalCandidate appears with the same phone.

### 2.2.5  Malformed profile
Send an obviously non-profile message ("היי שבוע טוב!").

✅ Badge reads "לא פרופיל". No review queue row, no candidate.
❌ Appears in /review or auto-creates a garbage candidate.

---

## 2.3  Extraction + Review Queue

### 2.3.1  Successful extraction
Use the high-confidence profile from 2.2.1. Open the new ExternalCandidate.

✅ All visible fields (name, age, city, phone) match the source message.
❌ Fields are empty or mis-assigned (e.g., city in the name field).

### 2.3.2  Review queue — fix extracted fields before approve
Send a deliberately low-confidence message ("ילד טוב בן עשרים ויותר"). Wait for it to appear in /review.
1. Edit the extracted fields (correct the age and add a phone).
2. Click "אשר וצור".

✅ The created ExternalCandidate has your corrected values, not the regex guess.
❌ The candidate is created with the original bad values.

### 2.3.3  Rerun extraction
On any needs_review row, click "עבד מחדש".

✅ Fields update in place within a few seconds.
❌ Row disappears without re-extracting; status becomes `failed`.

### 2.3.4  Dashboard deep-link
On the dashboard, click a `needs_review` row.

✅ /review opens, auto-scrolls to the matching card, the card is ring-highlighted.
❌ /review opens at the top of the list; the operator has to scroll to find the message.

---

## 2.4  Matching (Internal ↔ External)

### 2.4.1  Find matches — eligible list
Open an internal candidate with a gender opposite to several active externals. Click "חפש התאמות".

✅ Eligible externals appear, sorted by score. Each row shows matchScore, matchType badge, confidence.
❌ List is empty when you expect results; or ineligible externals appear in the eligible list.

### 2.4.2  Blocked candidates list
In the same dialog, scroll to the "מועמדים חסומים / לא זמינים להתאמה" section.

✅ Ineligible externals appear with a severity badge + per-blocker reason. "ניתן לעקוף" rows have an enabled "אלץ עם נימוק" button; "חסימה קשה" rows show a disabled "לא ניתן לעקוף" button.
❌ Blocked list is empty even when you know of blocked pairs; or non-overridable rows expose a force button.

### 2.4.3  Blocker correctness
For each of these deliberate setups, verify the exact blocker code appears:
| Setup | Expected blocker.code | Expected overridable |
|---|---|---|
| Same gender | `same_gender` | `none` |
| External availability = `dating` | `external_dating` | `none` |
| Internal candidate in `dating` status | `internal_already_dating` | `none` |
| Existing active suggestion for the same pair | `active_pair_duplicate` | `with_reason` |
| Internal has `openToDivorced=false`, external is `divorced` | `personal_status_divorced_not_open` | `with_reason` |

✅ Exact code + overridable classification as above.
❌ Wrong code, or a "with_reason" where "none" was expected (or vice versa).

### 2.4.4  Create suggestion from eligible
Click "צור הצעה" on an eligible row.

✅ Suggestion created (status=DRAFT), list refreshes, new suggestion visible on the candidate's Suggestions tab.
❌ 422 error, or duplicate suggestion created.

---

## 2.5  Force Match

### 2.5.1  Overridable blocker → success
In the blocked list, click "אלץ עם נימוק" on a `with_reason` row. Fill the justification with ≥10 chars. Tick the acknowledgement checkbox. Click "אלץ יצירה".

✅ Toast "הצעת שידוך נכפתה". New suggestion appears with the red "נכפתה" badge. Opening it shows the full blocker list in the override narrative on the history tab.
❌ Justification accepted without ticking the checkbox, or suggestion created without the `forcedOverride` badge.

### 2.5.2  Non-overridable blocker → rejected server-side
Manually POST to `/api/matches/force` for a same-gender pair via browser devtools or curl with a valid justification.

✅ Response 422 with `code=non_overridable_blocker` and the list of offending blockers.
❌ Suggestion created.

### 2.5.3  Justification length
Submit the force dialog with a 5-character justification.

✅ Server rejects with 400 validation error; UI shows the error message.
❌ Suggestion created.

### 2.5.4  Audit
After a successful force, open the match's History tab.

✅ Timeline shows a row with action `נכפתה` (match_forced) and the justification visible in the metadata block.
❌ No distinct audit row for the force.

---

## 2.6  Send Proposal

### 2.6.1  Single send — happy path
Approve a match. Click "שלח הצעה". Select a match_sending channel and side. Click "שלח".

✅ Toast "ההצעה נשלחה". Match status badge flips instantly to SENT_SIDE_A / B. Linked conversation tile appears on match page. Recipient receives the message on WhatsApp.
❌ Match status stays at APPROVED; no message on recipient; UI shows "send_failed".

### 2.6.2  Double-click send (idempotency)
In the send modal, click "שלח" twice rapidly.

✅ Exactly ONE outbound message received on WhatsApp. The second click either does nothing (UI button disabled) or produces `already_sending_side_X` error.
❌ Two identical messages arrive at the recipient.

### 2.6.3  Concurrent send from two tabs
Approve a match. Open two tabs of the match page. Click send in both within 1 second.

✅ One send succeeds, the other returns `already_sending_side_X`. Recipient receives exactly one message.
❌ Recipient receives two messages.

### 2.6.4  Network retry simulation
In DevTools, throttle to "Offline" mid-send (click "שלח", immediately switch to offline). Restore connectivity and retry the send.

✅ First attempt fails cleanly. After retry, one send succeeds. Recipient receives one message. No orphan in-flight lock.
❌ Retry produces `already_sending_side_X` and stays stuck longer than 30 s.

### 2.6.5  Wrong-role channel rejection
Manually select a `profiles_source` channel in the send modal (if the UI exposes it).

✅ Server returns `wrong_channel_role`; UI surfaces it.
❌ Send proceeds.

---

## 2.7  Response Detection

### 2.7.1  Accept reply (Hebrew)
After a successful send, have the recipient reply "כן מעוניין, נשמע מתאים!".

✅ Within SSE latency, dashboard shows `new_response` row. Match detail side badge shows "accepted". Match status transitions to ACCEPTED_SIDE_X.
❌ Row never appears; match status stays SENT_*.

### 2.7.2  Decline reply (Hebrew)
Recipient replies "לא מתאים, תודה".

✅ Dashboard shows `new_response` row. Match status transitions to DECLINED_SIDE_X. Response row badge shows "declined".
❌ Status stays SENT_*; or the response is classified as considering.

### 2.7.3  Considering / unclear reply
Recipient replies "אני אחשוב על זה, נדבר בהמשך".

✅ `new_response` row appears with status `considering`. Match status is NOT changed to ACCEPTED/DECLINED.
❌ Match mis-advanced to ACCEPTED_*.

### 2.7.4  Low-confidence AI fallback
Recipient replies with a colloquial/emoji-only reply ("👍" alone).

✅ Classifier does NOT decisively flip to accepted. Status is `considering` (low AI confidence held at the conservative floor).
❌ Status = accepted with AI confidence < 0.7.

### 2.7.5  Fast reply race
Recipient replies within <2 s of the send completing.

✅ Response row still appears; side is resolved correctly because conversation is pre-linked.
❌ Response detection silently no-ops because conversation lookup showed no match link.

### 2.7.6  Acknowledge by viewing
Open the match detail page for a match with an unacked response.

✅ Within a refresh, the dashboard `new_response` row disappears. Next visit to the dashboard doesn't re-show it.
❌ Row remains on the dashboard after visiting the match page.

---

## 2.8  Dashboard

### 2.8.1  needs_review realtime
Send a low-confidence inbound profile (see 2.2). Have the dashboard open in another tab.

✅ Needs_review row appears without manual refresh within a few seconds.
❌ Must refresh manually.

### 2.8.2  awaiting_response past SLA
Manually set `sentSideAAt` on a match to > `AWAITING_RESPONSE_HOURS` ago in DB. Refresh dashboard.

✅ Row appears in `awaiting_response` category.
❌ Row missing or wrong category.

### 2.8.3  overdue_task in-place complete
From an overdue task row on the dashboard, click "סמן בוצע".

✅ Task completes without leaving dashboard; row disappears on next refresh.
❌ Button does nothing; requires nav to /tasks.

### 2.8.4  Ownership filter — mine / team / all
Toggle the tri-state filter on the dashboard.

✅ `mine` shows only user's owned matches + tasks. `all` shows everything. `team` shows everything today (documented).
❌ `mine` shows rows owned by other users.

---

## 2.9  Ownership Enforcement

### 2.9.1  Owner edits own candidate
As userA, edit an internal candidate you own.

✅ Save succeeds; audit row logs the update under userA.
❌ Forbidden error.

### 2.9.2  Non-owner edits blocked candidate
As userB, try to edit userA's internal candidate.

✅ 403 response with `code=not_owner`. Toast: "This internal candidate is owned by another shadchan…".
❌ Edit succeeds.

### 2.9.3  Admin can edit anyone's
As an admin user, edit any candidate.

✅ Save succeeds.
❌ 403.

### 2.9.4  Task assigned to another operator
UserA creates a task and sets assignedTo=userB. UserB opens /tasks with `mine` filter.

✅ Task appears for userB. UserB can complete it (owner-or-assignee check).
❌ Task invisible to userB; or completion fails with not_owner.

### 2.9.5  Non-overridable match actions are still guarded
As userB, try to approve/decline/send/close a match owned by userA.

✅ All return 403 `not_owner`.
❌ Any of the actions succeed silently.

---

## 2.10  Notes / Tasks / History

### 2.10.1  Create note on candidate
On an internal candidate page, add a note via the notes rail.

✅ Note appears at top of the list immediately (optimistic prepend) and is visible on refresh.
❌ Note takes >2 s to appear or disappears on refresh.

### 2.10.2  Create task from entity
Open the Tasks rail on a match page. Click "משימה חדשה".

✅ The new task is created with the match pre-linked as related entity; visible in the rail + on /tasks.
❌ Task created with no relation; requires manual re-linking.

### 2.10.3  Complete task from rail
Click "סגור" on an open task in the rail.

✅ Task disappears from the open-rail view; shows in /tasks with status=completed.
❌ Button spins indefinitely; task stays open.

### 2.10.4  Timeline shows actions
On any entity (candidate, match) with recent activity, open the History tab.

✅ Timeline shows each recorded action in reverse chronological order, with Hebrew labels for the action type (נוצר, עודכן, הצעה נשלחה, etc.).
❌ Timeline empty despite audit actions visible in `auditlogs` collection, or actions show raw English strings.

---

## Sign-off

Execute all sections. Record pass/fail per numbered case. Block the pilot
start on any ❌ in sections 2.1 (session), 2.5 (force), 2.6 (send), 2.9
(ownership). Other failures should be triaged and either fixed or
documented as known gaps before onboarding the second operator.
