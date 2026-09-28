const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MARKS = /[✅✔✓☑]/u;
const DB_NAME = 'fieldnotes-saa';
const DB_VERSION = 1;
const PROGRESS_KEY = 'fieldnotes-saa-progress';
const POSITION_KEY = 'fieldnotes-saa-position';
const QUESTIONS_PER_QUIZ = 65;

const elements = Object.fromEntries([
  'bank-count', 'quiz-filter', 'question-jump-form', 'question-jump', 'jump-range',
  'progress-label', 'progress-fill', 'answered-count', 'correct-count',
  'folder-button', 'files-button', 'folder-input', 'files-input', 'empty-import-button', 'shuffle-button',
  'question-position', 'question-type', 'empty-state', 'quiz-content', 'question-number', 'source-name',
  'question-text', 'answer-instruction-text', 'options-list', 'feedback', 'selection-count', 'check-button',
  'previous-button', 'next-button', 'nav-caption', 'toast'
].map((id) => [id, document.getElementById(id)]));

let bank = { questions: [], sources: [] };
let progress = loadProgress();
let questionOrder = [];
let currentQuestionId = null;
let currentQuizIndex = 0;
let toastTimer;

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    showToast('Progress could not be saved by this browser.');
  }
}

function savePosition() {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({
      quizIndex: currentQuizIndex,
      questionId: currentQuestionId,
      shuffledOrder: questionOrder.shuffled ? questionOrder.map((question) => question.id) : null
    }));
  } catch {
    showToast('Your current place could not be saved.');
  }
}

function loadPosition() {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) || '{}');
  } catch {
    return {};
  }
}

function setTheme(theme) {
  const validTheme = ['light', 'dark', 'oled'].includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = validTheme;
  document.querySelector('meta[name="theme-color"]').content = validTheme === 'light' ? '#f4f4f3' : '#000000';
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === validTheme));
  });
  try {
    localStorage.setItem('saa-theme', validTheme);
  } catch {
    showToast('The theme will reset when this browser closes.');
  }
}

document.querySelectorAll('[data-theme-choice]').forEach((button) => {
  button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
});
setTheme(document.documentElement.dataset.theme);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore('banks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSavedBank() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('banks', 'readonly').objectStore('banks').get('main');
    request.onsuccess = () => {
      db.close();
      resolve(request.result || { questions: [], sources: [] });
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function saveBank(value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('banks', 'readwrite');
    transaction.objectStore('banks').put(value, 'main');
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function decodeZipEntry(buffer, name) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const minEocd = Math.max(0, bytes.length - 65557);
  let eocd = -1;

  for (let offset = bytes.length - 22; offset >= minEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file does not look like a valid DOCX document.');

  const entryCount = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error('Could not read the DOCX file directory.');
    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const entryName = decoder.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));

    if (entryName === name) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Could not read the DOCX document content.');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return Promise.resolve(decoder.decode(compressed));
      if (method !== 8 || typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot decompress this DOCX file. Please use a current version of Chrome or Edge.');
      }
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('The DOCX file does not contain a Word document body.');
}

function paragraphText(paragraph) {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT);
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.namespaceURI !== WORD_NS) continue;
    if (node.localName === 't') text += node.textContent;
    else if (node.localName === 'tab') text += ' ';
    else if (node.localName === 'br' || node.localName === 'cr') text += '\n';
  }
  return text.trim();
}

function fingerprint(question) {
  const value = `${question.prompt} ${question.options.map((option) => option.text).join(' ')}`
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function parseOptions(paragraphs) {
  const firstOptionIndex = paragraphs.findIndex((paragraph) => /^\s*A\.\s+/i.test(paragraph));
  if (firstOptionIndex < 0) return null;

  const optionSource = paragraphs.slice(firstOptionIndex).join('\n');
  const marker = /(?<![A-Z0-9])([A-E])\.\s+/g;
  const matches = [...optionSource.matchAll(marker)];
  const start = matches.findIndex((match) => match[1] === 'A');
  if (start < 0) return null;

  const accepted = [];
  let expected = 0;
  for (const match of matches.slice(start)) {
    const letterIndex = match[1].charCodeAt(0) - 65;
    if (letterIndex !== expected && letterIndex !== expected - 1) continue;
    accepted.push({ match, letter: String.fromCharCode(65 + expected) });
    expected += 1;
  }
  if (accepted.length < 2) return null;

  const options = accepted.map((entry, index) => {
    const match = entry.match;
    const startIndex = match.index + match[0].length;
    const endIndex = accepted[index + 1]?.match.index ?? optionSource.length;
    const optionSourceText = optionSource.slice(startIndex, endIndex);
    const rawText = optionSourceText.replace(/[✅✔✓☑]/gu, '').replace(/(?:\r?\n)?[\u2500-\u257F]{3,}\s*$/u, '').trim();
    return { letter: entry.letter, text: rawText, correct: MARKS.test(optionSourceText) };
  }).filter((option) => option.text);

  return options.length >= 2 && options.some((option) => option.correct) ? { firstOptionIndex, options } : null;
}

async function parseDocument(file) {
  const xml = await decodeZipEntry(await file.arrayBuffer(), 'word/document.xml');
  const parsedXml = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsedXml.querySelector('parsererror')) throw new Error('The Word document has invalid XML.');
  const paragraphs = [...parsedXml.getElementsByTagNameNS(WORD_NS, 'p')].map(paragraphText).filter(Boolean);
  const blocks = [];
  let current = null;

  for (const paragraph of paragraphs) {
    const heading = paragraph.match(/^Question\s+(\d+)\s*:?\s*$/i);
    if (heading) {
      if (current) blocks.push(current);
      current = { number: heading[1], paragraphs: [] };
    } else if (current) {
      current.paragraphs.push(paragraph);
    }
  }
  if (current) blocks.push(current);

  const questions = [];
  for (const block of blocks) {
    const parsed = parseOptions(block.paragraphs);
    if (!parsed) continue;
    const prompt = block.paragraphs.slice(0, parsed.firstOptionIndex).join('\n').trim();
    if (!prompt) continue;
    const question = {
      prompt,
      options: parsed.options,
      source: normalizeSourceName(file.name),
      number: block.number
    };
    question.id = fingerprint(question);
    questions.push(question);
  }
  return { questions, total: blocks.length };
}

function showToast(message, duration = 4200) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), duration);
}

function normalizeSourceName(source) {
  const part = source.match(/PART-(\d+)(?:\s*\(\d+\))?/i);
  return part ? `PART-${part[1]}.docx` : source.replace(/ \(\d+\)(?=\.docx$)/i, '');
}

function mergeBanks(...banks) {
  const questions = [];
  const locations = new Map();
  const ids = new Set();

  for (const value of banks) {
    for (const question of value?.questions || []) {
      const normalized = {
        ...question,
        source: normalizeSourceName(question.source)
      };
      normalized.id = fingerprint(normalized);
      const location = `${normalized.source}::${normalized.number}`;
      const existingIndex = locations.get(location);

      if (existingIndex !== undefined) {
        const existing = questions[existingIndex];
        if (normalized.options.length > existing.options.length && !ids.has(normalized.id)) {
          ids.delete(existing.id);
          questions[existingIndex] = normalized;
          ids.add(normalized.id);
        }
      } else if (!ids.has(normalized.id)) {
        locations.set(location, questions.length);
        ids.add(normalized.id);
        questions.push(normalized);
      }
    }
  }

  const counts = new Map();
  for (const question of questions) counts.set(question.source, (counts.get(question.source) || 0) + 1);
  return {
    questions,
    sources: [...counts].map(([name, count]) => ({ name, count }))
  };
}

function quizCount() {
  return Math.ceil(bank.questions.length / QUESTIONS_PER_QUIZ);
}

function quizQuestions(index = currentQuizIndex) {
  const start = index * QUESTIONS_PER_QUIZ;
  return bank.questions.slice(start, start + QUESTIONS_PER_QUIZ)
    .map((question, offset) => ({ ...question, _order: start + offset }));
}

function setQuiz(index, questionId = null, shuffledOrder = null) {
  const count = quizCount();
  currentQuizIndex = Math.max(0, Math.min(Number(index) || 0, Math.max(count - 1, 0)));
  const canonical = quizQuestions();
  const byId = new Map(canonical.map((question) => [question.id, question]));
  const canRestoreShuffle = Array.isArray(shuffledOrder)
    && shuffledOrder.length === canonical.length
    && shuffledOrder.every((id) => byId.has(id));
  questionOrder = canRestoreShuffle ? shuffledOrder.map((id) => byId.get(id)) : canonical;
  questionOrder.shuffled = canRestoreShuffle;
  currentQuestionId = questionOrder.some((question) => question.id === questionId)
    ? questionId
    : questionOrder[0]?.id || null;
  elements['quiz-filter'].value = String(currentQuizIndex);
  elements['question-jump'].max = String(Math.max(questionOrder.length, 1));
  elements['jump-range'].textContent = `of ${questionOrder.length}`;
  savePosition();
}

function renderQuizChoices() {
  const options = Array.from({ length: quizCount() }, (_, index) => {
    const first = index * QUESTIONS_PER_QUIZ + 1;
    const last = Math.min(first + QUESTIONS_PER_QUIZ - 1, bank.questions.length);
    return new Option(`Quiz ${String(index + 1).padStart(2, '0')} · ${first}–${last}`, String(index));
  });
  elements['quiz-filter'].replaceChildren(...options);
  elements['quiz-filter'].value = String(currentQuizIndex);
}

function updateQuizCompletion() {
  for (const option of elements['quiz-filter'].options) {
    const index = Number(option.value);
    const questions = quizQuestions(index);
    const complete = questions.length > 0 && questions.every((question) => progress[question.id]?.checked);
    const first = index * QUESTIONS_PER_QUIZ + 1;
    const last = Math.min(first + QUESTIONS_PER_QUIZ - 1, bank.questions.length);
    option.textContent = `Quiz ${String(index + 1).padStart(2, '0')} · ${first}–${last}${complete ? ' · ✓ DONE' : ''}`;
    option.dataset.complete = String(complete);
  }
}

function selectedQuestion() {
  return questionOrder.find((question) => question.id === currentQuestionId) || questionOrder[0] || null;
}

function renderProgress() {
  const list = questionOrder;
  updateQuizCompletion();
  const answered = list.filter((question) => progress[question.id]?.checked).length;
  const correct = list.filter((question) => progress[question.id]?.correct).length;
  const percent = list.length ? Math.round((answered / list.length) * 100) : 0;
  elements['bank-count'].textContent = list.length.toLocaleString();
  elements['progress-label'].textContent = `${percent}%`;
  elements['progress-fill'].style.width = `${percent}%`;
  elements['answered-count'].textContent = `${answered} answered`;
  elements['correct-count'].textContent = `${correct} correct`;
}

function render() {
  const list = questionOrder;
  const question = selectedQuestion();
  const questionIndex = question ? list.indexOf(question) : -1;
  elements['empty-state'].hidden = Boolean(question);
  elements['quiz-content'].hidden = !question;
  elements['previous-button'].disabled = !question || questionIndex === 0;
  elements['next-button'].disabled = !question || questionIndex === list.length - 1;
  elements['question-position'].textContent = question ? `Question ${questionIndex + 1} of ${list.length}` : 'Waiting for questions';
  elements['question-type'].textContent = `QUIZ ${String(currentQuizIndex + 1).padStart(2, '0')} · PRACTICE`;
  elements['question-jump'].value = question ? String(questionIndex + 1) : '';
  elements['question-jump'].max = String(Math.max(list.length, 1));
  elements['jump-range'].textContent = `of ${list.length}`;
  elements['bank-count'].textContent = list.length.toLocaleString();
  elements['nav-caption'].textContent = question ? `${list.length} questions in this quiz` : 'Import documents to begin';
  elements['shuffle-button'].title = questionOrder.shuffled ? 'Restore question order' : 'Shuffle questions';
  elements['shuffle-button'].setAttribute('aria-label', elements['shuffle-button'].title);
  renderProgress();
  if (!question) return;

  const state = progress[question.id] || { selected: [], checked: false };
  const correctOptions = question.options.filter((option) => option.correct);
  elements['question-number'].textContent = `QUESTION ${String(question.number).padStart(3, '0')}`;
  elements['source-name'].textContent = question.source.replace(/\.docx$/i, '');
  elements['source-name'].title = question.source;
  elements['question-text'].textContent = question.prompt;
  elements['answer-instruction-text'].textContent = correctOptions.length > 1 ? 'Choose all that apply' : 'Choose one answer';
  elements['selection-count'].textContent = state.checked
    ? (state.correct ? 'Answer recorded as correct' : 'Review the highlighted correct answer')
    : (correctOptions.length > 1 ? `${state.selected.length} selected · ${correctOptions.length} correct answers` : (state.selected.length ? '1 answer selected' : 'Select an answer to continue'));
  elements['check-button'].disabled = !state.checked && state.selected.length === 0;
  elements['check-button'].innerHTML = state.checked ? 'Next question <span aria-hidden="true">↗</span>' : 'Check answer <span aria-hidden="true">↗</span>';
  elements['feedback'].hidden = !state.checked;
  elements['feedback'].className = `feedback ${state.correct ? 'correct' : 'incorrect'}`;
  elements['feedback'].replaceChildren();
  if (state.checked) {
    const summary = document.createElement('strong');
    summary.textContent = state.correct ? 'Correct. Nicely done.' : 'Not quite. Review the correct answer.';
    const detail = document.createElement('span');
    detail.className = 'feedback-detail';
    detail.textContent = `Correct answer${correctOptions.length > 1 ? 's' : ''}: ${correctOptions.map((option) => `${option.letter}. ${option.text}`).join('  ·  ')}`;
    elements['feedback'].append(summary, detail);
  }

  elements['options-list'].replaceChildren(...question.options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-option';
    button.classList.toggle('selected', state.selected.includes(option.letter));
    if (state.checked && option.correct) button.classList.add('is-correct');
    if (state.checked && state.selected.includes(option.letter) && !option.correct) button.classList.add('is-wrong');
    button.disabled = state.checked;
    button.setAttribute('aria-pressed', String(state.selected.includes(option.letter)));
    const letter = document.createElement('span');
    letter.className = 'option-letter';
    letter.textContent = option.letter;
    const text = document.createElement('span');
    text.className = 'option-text';
    text.textContent = option.text;
    const indicator = document.createElement('span');
    indicator.className = 'option-indicator';
    indicator.textContent = state.checked && option.correct ? '✓' : '';
    button.append(letter, text, indicator);
    button.addEventListener('click', () => toggleOption(question, option));
    return button;
  }));
}

function toggleOption(question, option) {
  const state = progress[question.id] || { selected: [], checked: false };
  if (state.checked) return;
  const multiple = question.options.filter((item) => item.correct).length > 1;
  state.selected = state.selected.includes(option.letter)
    ? state.selected.filter((letter) => letter !== option.letter)
    : (multiple ? [...state.selected, option.letter] : [option.letter]);
  progress[question.id] = state;
  saveProgress();
  render();
}

function checkAnswer() {
  const question = selectedQuestion();
  if (!question) return;
  const state = progress[question.id] || { selected: [], checked: false };
  if (state.checked) {
    moveQuestion(1);
    return;
  }
  if (!state.selected.length) return;
  const expected = question.options.filter((option) => option.correct).map((option) => option.letter).sort();
  const actual = [...state.selected].sort();
  state.checked = true;
  state.correct = expected.length === actual.length && expected.every((letter, index) => letter === actual[index]);
  progress[question.id] = state;
  saveProgress();
  render();
}

function moveQuestion(direction) {
  const list = questionOrder;
  const index = list.findIndex((question) => question.id === selectedQuestion()?.id);
  const next = list[index + direction];
  if (!next) return;
  currentQuestionId = next.id;
  savePosition();
  render();
}

function shuffleQuestions() {
  const selected = selectedQuestion();
  const shuffled = !questionOrder.shuffled;
  questionOrder = [...quizQuestions()];
  if (shuffled) {
    for (let index = questionOrder.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [questionOrder[index], questionOrder[swapIndex]] = [questionOrder[swapIndex], questionOrder[index]];
    }
  } else {
    questionOrder.sort((first, second) => first._order - second._order);
  }
  questionOrder.shuffled = shuffled;
  currentQuestionId = selected?.id || questionOrder[0]?.id || null;
  savePosition();
  render();
  showToast(shuffled ? 'Question order shuffled.' : 'Original question order restored.');
}

async function importFiles(fileList) {
  const files = [...fileList].filter((file) => file.name.toLowerCase().endsWith('.docx'));
  if (!files.length) {
    showToast('Choose one or more .docx files to import.');
    return;
  }
  showToast(`Reading ${files.length} document${files.length === 1 ? '' : 's'}…`, 30000);
  let addedQuestions = 0;
  let skippedQuestions = 0;
  let correctedQuestions = 0;
  const failures = [];
  const normalizedQuestions = [];
  const normalizedLocations = new Map();
  for (const question of bank.questions) {
    const location = `${question.source}::${question.number}`;
    const existingIndex = normalizedLocations.get(location);
    if (existingIndex === undefined) {
      normalizedLocations.set(location, normalizedQuestions.length);
      normalizedQuestions.push(question);
    } else if (question.options.length > normalizedQuestions[existingIndex].options.length) {
      normalizedQuestions[existingIndex] = question;
    }
  }
  bank.questions = normalizedQuestions;
  const knownQuestions = new Set(bank.questions.map((question) => fingerprint(question)));
  const knownLocations = new Map(bank.questions.map((question, index) => [`${question.source}::${question.number}`, index]));
  const knownSources = new Map(bank.sources.map((source) => [source.name, source]));

  for (const file of files) {
    try {
      const sourceName = normalizeSourceName(file.name);
      const parsed = await parseDocument(file);
      const unique = [];
      for (const question of parsed.questions) {
        const id = fingerprint(question);
        const location = `${sourceName}::${question.number}`;
        const existingIndex = knownLocations.get(location);
        if (existingIndex !== undefined) {
          const existing = bank.questions[existingIndex];
          if (existing.id === id) {
            skippedQuestions += 1;
          } else if (question.options.length > existing.options.length && !knownQuestions.has(id)) {
            knownQuestions.delete(existing.id);
            question.id = id;
            bank.questions[existingIndex] = question;
            knownQuestions.add(id);
            correctedQuestions += 1;
          } else {
            skippedQuestions += 1;
          }
          continue;
        }
        if (knownQuestions.has(id)) {
          skippedQuestions += 1;
          continue;
        }
        knownQuestions.add(id);
        question.id = id;
        unique.push(question);
        knownLocations.set(location, bank.questions.length + unique.length - 1);
      }
      addedQuestions += unique.length;
      bank.questions.push(...unique);
      const source = knownSources.get(sourceName) || { name: sourceName, count: 0 };
      source.count += unique.length;
      knownSources.set(sourceName, source);
      if (!parsed.questions.length) failures.push(`${file.name}: no marked questions found`);
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  bank.sources = [...knownSources.values()];
  for (const source of bank.sources) {
    source.count = bank.questions.filter((question) => question.source === source.name).length;
  }
  renderQuizChoices();
  setQuiz(currentQuizIndex, currentQuestionId);
  render();

  try {
    await saveBank(bank);
  } catch {
    failures.push('The question bank could not be saved. Keep this tab open to study.');
  }

  elements.toast.classList.remove('visible');
  const summary = `${addedQuestions.toLocaleString()} new question${addedQuestions === 1 ? '' : 's'} imported`;
  const duplicateNote = skippedQuestions ? `; ${skippedQuestions.toLocaleString()} duplicate${skippedQuestions === 1 ? '' : 's'} skipped` : '';
  const correctionNote = correctedQuestions ? `; ${correctedQuestions.toLocaleString()} incomplete question${correctedQuestions === 1 ? '' : 's'} corrected` : '';
  showToast(failures.length ? `${summary}${duplicateNote}${correctionNote}. ${failures.slice(0, 2).join(' · ')}` : `${summary}${duplicateNote}${correctionNote}. Saved in this browser.`);
}

elements['files-button'].addEventListener('click', () => elements['files-input'].click());
elements['empty-import-button'].addEventListener('click', () => elements['files-input'].click());
elements['folder-button'].addEventListener('click', () => elements['folder-input'].click());
elements['files-input'].addEventListener('change', (event) => {
  importFiles(event.target.files);
  event.target.value = '';
});
elements['folder-input'].addEventListener('change', (event) => {
  importFiles(event.target.files);
  event.target.value = '';
});
elements['quiz-filter'].addEventListener('change', () => {
  setQuiz(Number(elements['quiz-filter'].value));
  render();
});
elements['question-jump-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const requested = Number(elements['question-jump'].value);
  if (!Number.isInteger(requested) || requested < 1 || requested > questionOrder.length) {
    elements['question-jump'].value = String(Math.max(1, questionOrder.findIndex((question) => question.id === currentQuestionId) + 1));
    return;
  }
  currentQuestionId = questionOrder[requested - 1].id;
  savePosition();
  render();
});
elements['shuffle-button'].addEventListener('click', shuffleQuestions);
elements['previous-button'].addEventListener('click', () => moveQuestion(-1));
elements['next-button'].addEventListener('click', () => moveQuestion(1));
elements['check-button'].addEventListener('click', checkAnswer);
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.matches('input, select, textarea')) return;
  if (event.key === 'Enter') {
    if (event.target === elements['question-jump']) return;
    event.preventDefault();
    checkAnswer();
    return;
  }
  if (/^[1-5]$/.test(event.key)) {
    const question = selectedQuestion();
    const option = question?.options[Number(event.key) - 1];
    if (option) toggleOption(question, option);
  }
});

(async function initialize() {
  let bundledBank = { questions: [], sources: [] };
  let savedBank = { questions: [], sources: [] };
  try {
    const response = await fetch('questions.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bundledBank = await response.json();
  } catch {
    showToast('Bundled questions could not be loaded. You can import DOCX files instead.');
  }
  try {
    savedBank = await readSavedBank();
  } catch {
    showToast('Browser storage is unavailable. Your bundled questions are still available.');
  }
  bank = mergeBanks(bundledBank, savedBank);
  renderQuizChoices();
  const savedPosition = loadPosition();
  setQuiz(savedPosition.quizIndex, savedPosition.questionId, savedPosition.shuffledOrder);
  render();
  if (bank.questions.length) {
    try {
      await saveBank(bank);
    } catch {
      showToast('Your question bank is ready. Local imports will only last for this visit.');
    }
  }
})();