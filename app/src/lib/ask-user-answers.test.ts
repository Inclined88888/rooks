/**
 * The answers of a `question` form: an open question answers with the typed
 * text; a question with options answers with its pick, and the free text typed
 * under it joins THAT question's answer — alone when nothing is ticked. A
 * question with neither a pick nor text holds the form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askFormComplete,
  askQuestionAnswered,
  buildAskAnswers,
  isFreeTextQuestion,
  optionActor,
  type AskUserQuestion,
} from './ask-user-answers';

const open: AskUserQuestion = { question: 'Name of the mail agent?', placeholder: 'assistant.mails' };
const choice: AskUserQuestion = { question: 'Create which?', options: [{ label: 'Both' }, { label: 'None' }] };
const multi: AskUserQuestion = { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] };

test('a question with no options, or an empty list, is an open question', () => {
  assert.equal(isFreeTextQuestion(open), true);
  assert.equal(isFreeTextQuestion({ question: 'Q?', options: [] }), true);
  assert.equal(isFreeTextQuestion(choice), false);
});

test('the common case stays a bare label, a list of labels, or the typed text', () => {
  assert.deepEqual(
    buildAskAnswers([open, choice, multi], { [choice.question]: 'Both', [multi.question]: ['lint', 'types'] }, { [open.question]: '  mails  ' }),
    { [open.question]: 'mails', [choice.question]: 'Both', [multi.question]: ['lint', 'types'] },
  );
});

test('the free text of a question rides inside its own answer, beside the pick', () => {
  assert.deepEqual(
    buildAskAnswers([choice, multi], { [choice.question]: 'Both', [multi.question]: ['types'] }, {
      [choice.question]: ' but mails first ',
      [multi.question]: 'lint later',
    }),
    {
      [choice.question]: { choice: 'Both', text: 'but mails first' },
      [multi.question]: { choices: ['types'], text: 'lint later' },
    },
  );
});

test('nothing ticked and some text: the text alone is the answer', () => {
  assert.deepEqual(
    buildAskAnswers([choice, multi], { [choice.question]: '', [multi.question]: [] }, {
      [choice.question]: 'Only mails',
      [multi.question]: 'none of these',
    }),
    { [choice.question]: { text: 'Only mails' }, [multi.question]: { text: 'none of these' } },
  );
});

test('a pick that is not one of the options never reaches the agent', () => {
  assert.deepEqual(buildAskAnswers([choice], { [choice.question]: '__rooks_other__' }, {}), { [choice.question]: '' });
  assert.equal(askQuestionAnswered(choice, { [choice.question]: '__rooks_other__' }, {}), false);
});

test('a question is answered by a ticked option or by its text, never by nothing', () => {
  assert.equal(askQuestionAnswered(choice, {}, {}), false);
  assert.equal(askQuestionAnswered(choice, { [choice.question]: '' }, { [choice.question]: '   ' }), false);
  assert.equal(askQuestionAnswered(choice, { [choice.question]: 'None' }, {}), true);
  assert.equal(askQuestionAnswered(choice, { [choice.question]: '' }, { [choice.question]: 'mine' }), true);
  assert.equal(askQuestionAnswered(multi, { [multi.question]: [] }, {}), false);
  assert.equal(askQuestionAnswered(multi, { [multi.question]: ['lint'] }, {}), true);
});

test('the form cannot be sent while a question has neither a pick nor text; an open question needs its text', () => {
  assert.equal(askFormComplete([open, choice], { [choice.question]: 'Both' }, {}), false);
  assert.equal(askFormComplete([open], {}, { [open.question]: '   ' }), false);
  assert.equal(askFormComplete([open], {}, { [open.question]: 'mails' }), true);
  assert.equal(askFormComplete([choice], {}, {}), false);
  assert.equal(askFormComplete([choice], {}, { [choice.question]: 'my own' }), true);
  assert.equal(askFormComplete([choice, multi], { [choice.question]: 'Both', [multi.question]: ['lint'] }, {}), true);
});

test('only the two listed actors give a badge', () => {
  assert.equal(optionActor({ label: 'a', actor: 'agent' }), 'agent');
  assert.equal(optionActor({ label: 'a', actor: 'user' }), 'user');
  assert.equal(optionActor({ label: 'a' }), null);
  assert.equal(optionActor({ label: 'a', actor: 'Agent' as never }), null);
});
