/**
 * Auto-grades an attempt against the exam's questions.
 * essay / image questions are left as null (score contributes 0 until a
 * teacher manually grades them) and flag needsManualGrading = true.
 *
 * questions: array of Question rows (correctAnswer / options are JSON strings)
 * answers: { [questionId]: studentAnswer }
 * exam: { negativeMarking: 'true'|'false', negativeMarkValue: number }
 */
function gradeAttempt(questions, answers, exam) {
  let score = 0;
  let maxScore = 0;
  let needsManualGrading = false;
  const negativeMarking = String(exam.negativeMarking) === 'true';
  const negativeValue = parseFloat(exam.negativeMarkValue) || 0;

  const breakdown = questions.map((q) => {
    const points = parseFloat(q.points) || 1;
    maxScore += points;
    const studentAnswer = answers[q.id];
    let correct = null; // null = ungraded (essay/image)
    let earned = 0;

    switch (q.type) {
      case 'mcq':
      case 'listening': // audio question, graded exactly like mcq (single correct choice)
      case 'truefalse': {
        const correctAnswer = safeParse_(q.correctAnswer);
        correct = studentAnswer !== undefined && String(studentAnswer) === String(correctAnswer);
        earned = correct ? points : (negativeMarking ? -negativeValue : 0);
        break;
      }
      case 'multi': {
        const correctSet = new Set((safeParse_(q.correctAnswer) || []).map(String));
        const studentSet = new Set((studentAnswer || []).map(String));
        correct = correctSet.size === studentSet.size &&
          [...correctSet].every((v) => studentSet.has(v));
        earned = correct ? points : (negativeMarking ? -negativeValue : 0);
        break;
      }
      case 'fillblank': {
        // correctAnswer may be a single string OR an array of acceptable
        // answers (spec: "support more than one correct answer").
        const parsed = safeParse_(q.correctAnswer);
        const acceptable = (Array.isArray(parsed) ? parsed : [parsed])
          .map((v) => String(v || '').trim().toLowerCase())
          .filter((v) => v !== '');
        const given = String(studentAnswer || '').trim().toLowerCase();
        correct = acceptable.length > 0 && acceptable.includes(given);
        earned = correct ? points : (negativeMarking ? -negativeValue : 0);
        break;
      }
      case 'essay':
      case 'image':
        correct = null;
        earned = 0;
        needsManualGrading = true;
        break;
      default:
        correct = false;
        earned = 0;
    }

    if (correct !== null) score += earned;

    return { questionId: q.id, type: q.type, correct, earned, points };
  });

  // Score should never go below zero even with heavy negative marking
  score = Math.max(0, score);
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0;

  return { score, maxScore, percentage, breakdown, needsManualGrading };
}

function safeParse_(value) {
  if (value === undefined || value === null || value === '') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

module.exports = { gradeAttempt };
