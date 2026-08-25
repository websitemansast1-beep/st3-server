// Questions are stored with options/correctAnswer as JSON-stringified text
// (so the sheet cell stays a single string); parse them back into real
// arrays/values before handing them to any frontend.
function safeParseJson_(value) {
  try { return JSON.parse(value); } catch (e) { return value; }
}

function parseQuestionOptions_(q) {
  return {
    ...q,
    options: q.options ? safeParseJson_(q.options) : undefined
  };
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The one function that decides what a STUDENT is allowed to see about a
// question: never correctAnswer. Used by both GET /exams/:id and
// POST /attempts/start so there's exactly one place this rule lives.
function questionsForStudent(questions, exam) {
  let list = questions;
  if (String(exam.shuffleQuestions) === 'true') list = shuffle(list);
  return list.map(({ correctAnswer, ...rest }) => parseQuestionOptions_(rest));
}

function questionsForAdmin(questions) {
  return questions.map(parseQuestionOptions_);
}

module.exports = { parseQuestionOptions_, shuffle, questionsForStudent, questionsForAdmin };
