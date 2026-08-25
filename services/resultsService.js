const gas = require('./gasClient');
const { rankAttempts } = require('../utils/ranking');

/**
 * Computes the ranking snapshot for one exam (in Node — pure computation,
 * no Sheets call) so it can be sent together with the publish flip in one
 * combined write. Kept separate from publishExamResults so
 * unpublish/republish flows can still recompute rankings on their own if
 * ever needed.
 */
async function computeRankings_(examId) {
  const attempts = await gas.find('Attempts', { examId });
  const ranked = rankAttempts(attempts);
  const records = ranked.map((r) => ({
    examId,
    studentId: r.studentId,
    attemptId: r.id,
    score: r.score,
    percentage: r.percentage,
    durationSeconds: r.duration === Infinity ? 0 : r.duration,
    rank: r.rank,
    updatedAt: new Date().toISOString()
  }));
  return { ranked, records };
}

/**
 * Rebuilds the Rankings snapshot for one exam in a SINGLE Sheets write
 * (old per-exam ranking rows out, new ones in, via replaceMatching) —
 * never "read everything, recompute, N deletes, N inserts".
 *
 * This is intentionally NOT called on every submit (that's the exact
 * anti-pattern the spec forbids: every submit re-reading and rebuilding
 * the whole ranking). It only runs when the teacher publishes results,
 * which happens once per exam, not once per student.
 */
async function refreshRankings(examId) {
  const { ranked, records } = await computeRankings_(examId);
  await gas.replaceMatching('Rankings', { examId }, records);
  return ranked;
}

/**
 * Publishes results for an exam: rebuilds the ranking snapshot and flips
 * resultsPublished = true. Only after this do students see scores,
 * percentages, or the leaderboard for this exam — enforced server-side in
 * every read path (exams list, attempt result, rankings), never just hidden
 * in the UI.
 *
 * The ranking write and the publish flip are sent as ONE combined Apps
 * Script call (see the 'publishExamResults' action in Code.gs) instead of
 * two sequential ones — this was the biggest chunk of "why does clicking
 * publish take so long" latency, since each round trip to Apps Script has
 * real, unavoidable network cost. They still happen in the same order
 * inside that one call (rankings written first, then the flag), so a
 * student still can never see resultsPublished=true paired with stale
 * rankings.
 *
 * Fallback: the combined action only exists once the LIVE Apps Script
 * deployment has been updated with the newest Code.gs (a manual step —
 * see WHATS_NEW.md). If that hasn't happened yet, this call fails with
 * "Unknown action" — instead of that surfacing as "publish results does
 * nothing", fall back to the two older, individually-existing actions
 * (replaceMatching + update) so publishing still works today, just a
 * little slower until the deployment catches up.
 */
async function publishExamResults(examId) {
  const { records } = await computeRankings_(examId);
  try {
    return await gas.publishExamResults_(examId, records);
  } catch (err) {
    if (!/unknown action/i.test(err.message || '')) throw err;
    console.warn(
      '[resultsService] Combined publishExamResults action not available on the deployed ' +
      'Apps Script yet (redeploy Code.gs to speed this up) — falling back to two separate calls.'
    );
    await gas.replaceMatching('Rankings', { examId }, records);
    return gas.update('Exams', examId, { resultsPublished: true });
  }
}

function unpublishExamResults(examId) {
  return gas.update('Exams', examId, { resultsPublished: false });
}

function isResultsPublished(exam) {
  return String(exam && exam.resultsPublished) === 'true';
}

module.exports = { refreshRankings, publishExamResults, unpublishExamResults, isResultsPublished };
