/**
 * review.js — question-by-question breakdown of one quiz attempt
 * (which questions were right / wrong / unanswered, what was answered and
 * what the correct answer is). Read-only: it never changes the attempt or
 * its score — the score shown is the one saved when the quiz was submitted.
 */

// Same answer matching the quiz uses when marking direct (typed) answers:
// case/spacing-insensitive, any of the "a|b|c" alternatives, 2 == 2.0
function normAnswer(v) { return String(v).trim().toLowerCase().replace(/\s+/g, ' '); }
function directAnswerMatches(given, accepted) {
  const g = normAnswer(given);
  return String(accepted).split('|').some((a) => {
    const n = normAnswer(a);
    if (!n) return false;
    if (n === g) return true;
    return n !== '' && g !== '' && !isNaN(Number(n)) && !isNaN(Number(g)) && Number(n) === Number(g);
  });
}

/**
 * @param quiz     the quiz (with correct answers)
 * @param attempt  the attempt (with answers)
 * @param opts.revealCorrect  include the correct answers
 */
function buildReview(quiz, attempt, { revealCorrect = true } = {}) {
  const answers = attempt.answers || {};
  const counts = { correct: 0, wrong: 0, unanswered: 0 };

  const questions = quiz.questions.map((q, i) => {
    const marks = q.marks || 1;
    const given = answers[q.id];
    const isDirect = q.type === 'direct';
    const unanswered = given === undefined || given === null || (isDirect && String(given).trim() === '');

    let result;
    let earned = 0;
    if (unanswered) result = 'unanswered';
    else if (isDirect) {
      result = directAnswerMatches(given, q.correctAnswer) ? 'correct' : 'wrong';
      earned = result === 'correct' ? marks : 0; // typed answers are never penalised
    } else {
      result = given === q.correctIndex ? 'correct' : 'wrong';
      earned = result === 'correct' ? marks : (quiz.negativeMarking ? -(marks * 0.25) : 0);
    }
    counts[result]++;

    const out = { n: i + 1, id: q.id, type: isDirect ? 'direct' : 'mcq', text: q.text, marks, result, earned };
    if (isDirect) {
      out.yourAnswer = unanswered ? null : String(given);
      if (revealCorrect) out.correctAnswers = String(q.correctAnswer).split('|').map((a) => a.trim()).filter(Boolean);
    } else {
      out.options = q.options;
      out.yourIndex = unanswered ? null : given;
      if (revealCorrect) out.correctIndex = q.correctIndex;
    }
    return out;
  });

  return {
    attemptId: attempt.id,
    quizTitle: quiz.title,
    score: attempt.score,
    totalMarks: attempt.totalMarks,
    percent: attempt.totalMarks ? Math.round((attempt.score / attempt.totalMarks) * 100) : null,
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    negativeMarking: !!quiz.negativeMarking,
    revealCorrect,
    counts,
    questions
  };
}

module.exports = { buildReview };
