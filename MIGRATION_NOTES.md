# Sheets -> Firestore migration notes

## What changed
- **Database only** moved from Google Sheets (via Apps Script) to Firebase
  Firestore. File storage (Google Drive) and Google Apps Script are still
  used for: `uploadFile`, `deleteFile`, `convertToSlides`, `getSlideImages`.
- `services/firestoreClient.js` is the new database layer. It exports the
  exact same function names/signatures as `services/gasClient.js`
  (`getAll`, `getById`, `find`, `insert`, `update`, `remove`, `batchInsert`,
  `batchUpdate`, `replaceMatching`, `getAdminByUsername`, `countAdmins`,
  `insertAdmin`, `updateAdminPassword`, `getStudentByCode`, `generateCodes`,
  `getSettings`, `updateSetting`, `publishExamResults_`).
- `services/gasClient.js` is untouched and still runs — it is now used
  ONLY for the four Drive/file functions above.
- Authentication/authorization/JWT/roles/business logic were NOT changed.

## Files touched
One-line require swap only (`gasClient` -> `firestoreClient`), variable
name `gas` kept as-is, zero other lines changed:
`services/resultsService.js`, `services/submissionQueue.js`,
`utils/contentAccess.js`, `routes/exams.js`, `routes/students.js`,
`routes/questions.js`, `routes/notifications.js`, `routes/attempts.js`,
`routes/settings.js`, `routes/loadtest.js`, `routes/codes.js`,
`routes/analytics.js`, `routes/comments.js`, `routes/lessons.js`,
`routes/auth.js`, `routes/chat.js`.

Dual client (`gas` kept for Drive calls only, `db` added for everything
else): `routes/videos.js`, `routes/books.js`, `routes/presentations.js`,
`routes/units.js`.

Untouched: `routes/upload.js` (pure Drive), `middleware/auth.js`,
`utils/idempotency.js`, `utils/grading.js`, `utils/ranking.js`,
`utils/questions.js`, `server.js`, `api/index.js`,
`scripts/benchmark-queue.js`, `scripts/test-gas-connection.js` (these two
scripts still exercise the Apps Script endpoint on purpose — they test the
Sheets connection itself, not the app).

## Firestore collections
| Table (as used in code) | Collection   | Notes |
|---|---|---|
| Admins | `admins` | |
| Students | `students` | |
| Codes | `codes` | doc id = the code string itself |
| Units | `units` | |
| Lessons | `lessons` | |
| Exams | `exams` | |
| Questions | `questions` | |
| Attempts | `attempts` | |
| Rankings | `rankings` | *discovered in code, not in the original list* |
| Videos | `videos` | |
| VideoProgress | `videoProgress` | |
| Books | `books` | |
| BookProgress | `bookProgress` | *discovered in code* |
| Presentations | `presentations` | *discovered in code* |
| Comments | `comments` | *discovered in code* |
| Messages | `messages` | *discovered in code (chat.js)* |
| Notifications | `notifications` | |
| Settings | `settings` | doc id = the setting `key` |

No subcollections were used — every collection maps 1:1 to a table, since
nothing in the code showed a parent/child access pattern that would
benefit from nesting, and flat collections keep every existing `find`
query (`where(field, '==', value)`) working unchanged.

## Environment variables required in Railway
Keep the existing ones (`GAS_ENDPOINT_URL`, `GAS_API_KEY`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, etc.) — GAS is still needed for
Drive. Add ONE of:

**Option A (recommended — sidesteps the private-key-newline problem):**
- `FIREBASE_SERVICE_ACCOUNT` = the full service-account JSON file,
  base64-encoded into one line:
  `base64 -w0 service-account.json` (Linux) → paste the output as the
  value.

**Option B (three separate variables):**
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` — paste the key exactly as in the JSON file,
  `\n` sequences are unescaped automatically by `firestoreClient.js`.

Never commit the service-account JSON to GitHub. Never log it — nothing in
this codebase does.

## Indexes
None were required to be manually created. Every `find()` call across the
whole project uses 1–2 plain equality (`==`) filters (audited across every
route), and Cloud Firestore resolves multiple equality filters
automatically without a composite index. If Firestore ever complains about
a missing index for a NEW query added later, it returns a direct console
link in the error message — create it from there.

## Known follow-ups / open items
1. **`generateCodes` format**: the original code-generation algorithm
   lives in the Google Apps Script project (`Code.gs`), which isn't part of
   this repo, so its exact visible format couldn't be read. The new
   implementation generates unique, unambiguous codes (prefix + 8
   characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`). If already-printed
   codes need to match a specific format, adjust `CODE_ALPHABET`/length in
   `firestoreClient.js`.
2. **Admin dashboard endpoints that `getAll()` whole collections**
   (`routes/students.js` `GET /`, `GET /:id/activity`, `routes/videos.js`
   `:id/stats`, etc.) still read entire collections, exactly like they read
   entire sheets before. This was intentionally NOT changed (no business
   logic changes were made), but at ~1000 students this is worth revisiting
   later — Firestore bills per document read, so a full `students`
   collection scan on every admin dashboard load has a real (if small)
   cost. Flagging for a later, separate optimization pass.
3. `scripts/test-gas-connection.js` and `scripts/benchmark-queue.js` still
   reference `gasClient.js` on purpose (they test/benchmark the Sheets
   connection itself). Once Sheets is fully retired, these can be deleted.

## Testing checklist
1. `npm install` (adds `firebase-admin`).
2. Set the Firebase + GAS env vars locally (`.env`).
3. `node scripts/migrateSheetsToFirestore.js --dry-run` — confirm row
   counts look right.
4. `node scripts/migrateSheetsToFirestore.js` — real migration (Sheets
   untouched).
5. `node scripts/migrateSheetsToFirestore.js --validate` — confirm row
   counts match between Sheets and Firestore.
6. `npm run dev`, then manually exercise: admin login, student login
   (new code + returning code), start/answer/submit an exam, publish
   results, video progress ping, book tracking, notifications, codes
   generate/export.
7. Deploy to Railway with the new env vars set, repeat step 6 against the
   deployed URL.
8. Once confident, `gasClient.js`'s DB-related fallback logic and the old
   `GAS_ENDPOINT_URL`/Sheets project can be retired — but only the file
   functions (`uploadFile`/`deleteFile`/`convertToSlides`/`getSlideImages`)
   are still actually called by the app, so Drive access must remain.
