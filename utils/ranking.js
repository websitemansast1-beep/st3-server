/**
 * Ranks a list of graded attempts for one exam.
 * Tie-break order (spec): 1) score DESC, 2) time taken ASC,
 * 3) submission time ASC (whoever finished earlier), 4) id ASC as a
 * final, fully-stable tiebreaker so identical ties always render in
 * the same order instead of shuffling between rebuilds.
 * Only one (best) attempt per student is considered for ranking -
 * their best score, and on tie, their fastest qualifying attempt.
 * Only students who actually submitted (graded/submitted) are ranked;
 * students who never attempted or never finished are excluded.
 */
function rankAttempts(attempts) {
  const byStudent = new Map();

  attempts
    .filter((a) => a.status === 'graded' || a.status === 'submitted')
    .forEach((a) => {
      const score = parseFloat(a.score) || 0;
      const duration = parseFloat(a.durationSeconds) || Infinity;
      const finishedAt = a.finishTime ? new Date(a.finishTime).getTime() : Infinity;
      const candidate = { ...a, score, duration, finishedAt };
      const existing = byStudent.get(a.studentId);
      if (!existing) {
        byStudent.set(a.studentId, candidate);
        return;
      }
      const better =
        score > existing.score ||
        (score === existing.score && duration < existing.duration) ||
        (score === existing.score && duration === existing.duration && finishedAt < existing.finishedAt);
      if (better) byStudent.set(a.studentId, candidate);
    });

  const ranked = [...byStudent.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.duration !== b.duration) return a.duration - b.duration;
    if (a.finishedAt !== b.finishedAt) return a.finishedAt - b.finishedAt;
    return String(a.id).localeCompare(String(b.id));
  });

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

module.exports = { rankAttempts };
