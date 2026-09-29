const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MARKS = /[✅✔✓☑]/u;
const DB_NAME = 'fieldnotes-saa';
const DB_VERSION = 1;
const PROGRESS_KEY = 'fieldnotes-saa-progress';
const POSITION_KEY = 'fieldnotes-saa-position';
const QUESTIONS_PER_QUIZ = 65;

// Topic classifier: applied at bank-load to tag each question with a
// primary topic used by the "By topic" exam mode. Patterns are ordered
// from most specific / niche → most general so that specific services
// win on tiebreak; ties in raw hit count fall back to that ordering.
const TOPIC_DEFINITIONS = [
  { key: 'migration', label: 'Migration & Data Transfer', patterns: [
    /\bsnowball\b/, /\bsnowmobile\b/, /\bsnowcone\b/,
    /\bdatasync\b/, /\bdms\b/, /database migration service/,
    /\btransfer family\b/, /\baws transfer\b/, /\bsftp\b/,
    /storage gateway/, /\bfile gateway\b/, /volume gateway/, /tape gateway/,
    /\bmgn\b/, /application migration service/, /schema conversion tool/,
  ] },
  { key: 'analytics', label: 'Analytics & Streaming', patterns: [
    /\bkinesis\b/, /firehose/, /\bmsk\b/, /managed streaming for apache kafka/,
    /\bathena\b/, /\bredshift\b/, /\bemr\b/, /\bglue\b/, /quicksight/,
    /\bopensearch\b/, /elasticsearch service/, /data pipeline/, /lake formation/,
  ] },
  { key: 'ml', label: 'Machine Learning', patterns: [
    /sagemaker/, /\bcomprehend\b/, /\brekognition\b/, /\btextract\b/,
    /\bpolly\b/, /\btranslate\b/, /\bforecast\b/, /\bpersonalize\b/,
    /\bkendra\b/, /\btranscribe\b/, /\blex\b/,
  ] },
  { key: 'cost', label: 'Cost & Billing', patterns: [
    /cost explorer/, /\bbudgets\b/, /savings plan/, /reserved instance/,
    /\bri\b(?!s)/, /cost allocation/, /compute optimizer/,
    /trusted advisor.*cost/, /cost.*trusted advisor/,
  ] },
  { key: 'integration', label: 'App Integration', patterns: [
    /\bsqs\b/, /simple queue service/,
    /\bsns\b/, /simple notification service/,
    /\beventbridge\b/, /event bus/,
    /step functions/, /state machine/,
    /\bmq\b/, /\bappflow\b/, /workflow/,
  ] },
  { key: 'security', label: 'Security & Identity', patterns: [
    /\biam\b/, /identity and access management/,
    /\bkms\b/, /key management service/, /customer managed key/, /cmk\b/,
    /secrets manager/, /\bcognito\b/,
    /\bwaf\b/, /web application firewall/, /\bshield\b/,
    /guardduty/, /\bmacie\b/, /\binspector\b/,
    /\bacm\b/, /certificate manager/, /ssl certificate/,
    /service control polic/, /\bscp\b/,
    /aws organizations/, /\bsso\b/, /identity center/,
    /\bcloudhsm\b/, /\bsts\b/, /security token service/,
    /firewall manager/, /network firewall/, /detective/,
  ] },
  { key: 'network', label: 'Networking & Delivery', patterns: [
    /\bvpc\b/, /\bsubnet\b/, /nat gateway/, /internet gateway/,
    /route 53/, /\broute53\b/, /\bdns\b/,
    /cloudfront/, /edge location/,
    /\balb\b/, /application load balancer/,
    /\bnlb\b/, /network load balancer/, /\bgateway load balancer\b/,
    /\belb\b/, /elastic load balanc/,
    /direct connect/, /site.to.site vpn/, /\bvpn\b/,
    /transit gateway/, /\btgw\b/, /privatelink/, /interface endpoint/, /gateway endpoint/,
    /global accelerator/, /api gateway/,
    /\bappsync\b/, /app mesh/, /cloud map/,
    /peering connection/, /client vpn/,
  ] },
  { key: 'database', label: 'Database', patterns: [
    /\brds\b/, /relational database service/,
    /\baurora\b/, /\bdynamodb\b/,
    /documentdb/, /\bneptune\b/, /memorydb/, /\belasticache\b/,
    /\bdax\b/, /dynamodb accelerator/,
    /\bqldb\b/, /\btimestream\b/, /keyspaces/,
    /sql server/, /\bmysql\b/, /\bpostgres/, /\boracle\b database/, /mariadb/,
  ] },
  { key: 'compute', label: 'Compute', patterns: [
    /\bec2\b/, /\becs\b/, /\beks\b/, /fargate/,
    /\blambda\b/, /\bbatch\b/, /elastic beanstalk/,
    /auto scaling/, /autoscaling/, /spot instance/,
    /\bami\b/, /launch template/, /launch configuration/,
    /app runner/, /lightsail/, /outposts/, /wavelength/,
  ] },
  { key: 'storage', label: 'Storage', patterns: [
    /\bs3\b/, /simple storage service/,
    /\bebs\b/, /elastic block store/,
    /\befs\b/, /elastic file system/,
    /\bfsx\b/, /lustre/, /windows file server/,
    /\bglacier\b/, /deep archive/, /intelligent.tiering/,
    /aws backup/, /backup plan/, /recovery point/,
    /storage lens/, /object lambda/,
  ] },
  { key: 'ops', label: 'Management & Ops', patterns: [
    /cloudwatch/, /cloudtrail/, /aws config/, /configuration recorder/,
    /systems manager/, /\bssm\b/, /session manager/, /parameter store/,
    /trusted advisor/, /control tower/, /aws health/,
    /aws organizations/, /service catalog/,
    /cloudformation/, /\bcdk\b/, /\bcopilot\b/,
    /personal health dashboard/,
  ] },
  { key: 'other', label: 'Other', patterns: [] },
];

function classifyTopic(question) {
  const text = `${question.prompt} ${question.options.map((o) => o.text).join(' ')}`.toLowerCase();
  let best = { key: 'other', hits: 0, index: TOPIC_DEFINITIONS.length };
  TOPIC_DEFINITIONS.forEach((topic, index) => {
    if (!topic.patterns.length) return;
    let hits = 0;
    for (const pattern of topic.patterns) if (pattern.test(text)) hits += 1;
    if (hits === 0) return;
    // Higher hit count wins; on tie, earlier (more specific) topic wins.
    if (hits > best.hits || (hits === best.hits && index < best.index)) {
      best = { key: topic.key, hits, index };
    }
  });
  return best.key;
}

function applyTopics(list) {
  for (const question of list) {
    if (!question.topic) question.topic = classifyTopic(question);
  }
}

const elements = Object.fromEntries([
  'bank-count', 'quiz-filter', 'quiz-filter-label', 'topic-filter', 'topic-filter-label',
  'question-jump-form', 'question-jump', 'jump-range',
  'progress-label', 'progress-fill', 'answered-count', 'correct-count', 'accuracy-total',
  'accuracy-track', 'accuracy-correct', 'accuracy-wrong', 'accuracy-right-label', 'accuracy-wrong-label',
  'map-summary', 'wrong-filter', 'wrong-filter-count', 'question-grid', 'map-empty',
  'folder-button', 'files-button', 'folder-input', 'files-input', 'empty-import-button', 'shuffle-button',
  'question-position', 'question-type', 'empty-state', 'quiz-content', 'question-number', 'source-name',
  'streak-row', 'streak-count', 'streak-best', 'confetti-layer',
  'question-text', 'answer-instruction-text', 'options-list', 'feedback', 'explanation', 'requirement-text',
  'explanation-toggle', 'explanation-toggle-hint', 'explanation-body',
  'option-reasons', 'trap-text', 'takeaway-text', 'selection-count', 'check-button',
  'previous-button', 'next-button', 'nav-caption', 'toast'
].map((id) => [id, document.getElementById(id)]));

let bank = { questions: [], sources: [] };
let progress = loadProgress();
let questionOrder = [];
let currentQuestionId = null;
let currentQuizIndex = 0;
let currentMode = 'parts'; // 'parts' (65-question chunks) or 'topics' (by topic)
let currentTopic = TOPIC_DEFINITIONS[0].key;
let wrongOnly = false;
let toastTimer;
// Session-only streak: consecutive correct answers since page load. Resets on
// wrong or on reload — kept in-memory intentionally so a fresh session starts
// clean and there is no "streak debt" carried across days.
let streakCurrent = 0;
let streakBest = 0;
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CONFETTI_COLORS = ['#f6c26b', '#8fd18b', '#7fb7f2', '#e58fb7', '#c58ff2', '#f2a878'];

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
      mode: currentMode,
      quizIndex: currentQuizIndex,
      topic: currentTopic,
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

function partsQuestions(index) {
  const start = index * QUESTIONS_PER_QUIZ;
  return bank.questions.slice(start, start + QUESTIONS_PER_QUIZ)
    .map((question, offset) => ({ ...question, _order: start + offset }));
}

function topicQuestions(topicKey) {
  const filtered = [];
  bank.questions.forEach((question, offset) => {
    if (question.topic === topicKey) filtered.push({ ...question, _order: offset });
  });
  return filtered;
}

function quizQuestions(indexOrKey = null) {
  if (currentMode === 'topics') {
    return topicQuestions(indexOrKey === null ? currentTopic : indexOrKey);
  }
  return partsQuestions(indexOrKey === null ? currentQuizIndex : Number(indexOrKey));
}

function setQuiz(indexOrKey = null, questionId = null, shuffledOrder = null) {
  if (currentMode === 'topics') {
    const knownKeys = new Set(TOPIC_DEFINITIONS.map((topic) => topic.key));
    const requested = indexOrKey === null || indexOrKey === undefined ? currentTopic : String(indexOrKey);
    currentTopic = knownKeys.has(requested) ? requested : TOPIC_DEFINITIONS[0].key;
  } else {
    const count = quizCount();
    currentQuizIndex = Math.max(0, Math.min(Number(indexOrKey) || 0, Math.max(count - 1, 0)));
  }
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
  if (currentMode === 'topics') {
    elements['topic-filter'].value = currentTopic;
  } else {
    elements['quiz-filter'].value = String(currentQuizIndex);
  }
  elements['question-jump'].max = String(Math.max(questionOrder.length, 1));
  elements['jump-range'].textContent = `of ${questionOrder.length}`;
  savePosition();
}

function renderQuizChoices() {
  const partOptions = Array.from({ length: quizCount() }, (_, index) => {
    const first = index * QUESTIONS_PER_QUIZ + 1;
    const last = Math.min(first + QUESTIONS_PER_QUIZ - 1, bank.questions.length);
    return new Option(`Quiz ${String(index + 1).padStart(2, '0')} · ${first}–${last}`, String(index));
  });
  elements['quiz-filter'].replaceChildren(...partOptions);
  if (currentMode === 'parts') elements['quiz-filter'].value = String(currentQuizIndex);

  const topicOptions = TOPIC_DEFINITIONS
    .map((topic) => ({ topic, count: bank.questions.filter((question) => question.topic === topic.key).length }))
    .filter(({ count }) => count > 0)
    .map(({ topic, count }) => new Option(`${topic.label} · ${count}`, topic.key));
  elements['topic-filter'].replaceChildren(...topicOptions);
  if (currentMode === 'topics') {
    const available = new Set(topicOptions.map((opt) => opt.value));
    if (!available.has(currentTopic) && topicOptions.length) currentTopic = topicOptions[0].value;
    elements['topic-filter'].value = currentTopic;
  }
}

function updateQuizCompletion() {
  if (currentMode === 'parts') {
    for (const option of elements['quiz-filter'].options) {
      const index = Number(option.value);
      const questions = partsQuestions(index);
      const complete = questions.length > 0 && questions.every((question) => progress[question.id]?.checked);
      const first = index * QUESTIONS_PER_QUIZ + 1;
      const last = Math.min(first + QUESTIONS_PER_QUIZ - 1, bank.questions.length);
      option.textContent = `Quiz ${String(index + 1).padStart(2, '0')} · ${first}–${last}${complete ? ' · ✓ DONE' : ''}`;
      option.dataset.complete = String(complete);
    }
  } else {
    for (const option of elements['topic-filter'].options) {
      const key = option.value;
      const topic = TOPIC_DEFINITIONS.find((entry) => entry.key === key);
      if (!topic) continue;
      const questions = topicQuestions(key);
      const complete = questions.length > 0 && questions.every((question) => progress[question.id]?.checked);
      option.textContent = `${topic.label} · ${questions.length}${complete ? ' · ✓ DONE' : ''}`;
      option.dataset.complete = String(complete);
    }
  }
}

function setMode(mode) {
  const validMode = mode === 'topics' ? 'topics' : 'parts';
  currentMode = validMode;
  document.querySelectorAll('[data-mode-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.modeChoice === validMode));
  });
  elements['quiz-filter-label'].hidden = validMode !== 'parts';
  elements['topic-filter-label'].hidden = validMode !== 'topics';
  renderQuizChoices();
  setQuiz(validMode === 'topics' ? currentTopic : currentQuizIndex);
  render();
}

function selectedQuestion() {
  return questionOrder.find((question) => question.id === currentQuestionId) || questionOrder[0] || null;
}

function renderProgress() {
  const list = questionOrder;
  updateQuizCompletion();
  const answered = list.filter((question) => progress[question.id]?.checked).length;
  const correct = list.filter((question) => progress[question.id]?.correct).length;
  const wrong = answered - correct;
  const percent = list.length ? Math.round((answered / list.length) * 100) : 0;
  const rightAccuracy = answered ? Math.round((correct / answered) * 100) : 0;
  const wrongAccuracy = answered ? 100 - rightAccuracy : 0;
  elements['bank-count'].textContent = list.length.toLocaleString();
  elements['progress-label'].textContent = `${percent}%`;
  elements['progress-fill'].style.width = `${percent}%`;
  elements['answered-count'].textContent = `${answered} answered`;
  elements['correct-count'].textContent = `${correct} correct`;
  elements['accuracy-total'].textContent = `${answered} / ${list.length} graded`;
  elements['accuracy-correct'].style.width = `${list.length ? (correct / list.length) * 100 : 0}%`;
  elements['accuracy-wrong'].style.width = `${list.length ? (wrong / list.length) * 100 : 0}%`;
  elements['accuracy-right-label'].textContent = `Right ${rightAccuracy}%`;
  elements['accuracy-wrong-label'].textContent = `Wrong ${wrongAccuracy}%`;
  elements['accuracy-track'].setAttribute('aria-label', answered
    ? `Of ${answered} graded answers, ${rightAccuracy}% right and ${wrongAccuracy}% wrong`
    : 'No graded answers yet');
}

function renderQuestionMap() {
  const currentIndex = questionOrder.findIndex((question) => question.id === currentQuestionId);
  const answered = questionOrder.filter((question) => progress[question.id]?.checked).length;
  const wrong = questionOrder.filter((question) => progress[question.id]?.checked && !progress[question.id]?.correct);
  const visible = questionOrder
    .map((question, index) => ({ question, index, state: progress[question.id] }))
    .filter(({ state }) => !wrongOnly || (state?.checked && !state.correct));

  elements['map-summary'].textContent = `${answered} of ${questionOrder.length} answered · ${questionOrder.length - answered} left`;
  elements['wrong-filter-count'].textContent = String(wrong.length);
  elements['wrong-filter'].setAttribute('aria-pressed', String(wrongOnly));
  elements['question-grid'].replaceChildren(...visible.map(({ question, index, state }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'question-tile';
    if (state?.checked) button.classList.add(state.correct ? 'right' : 'wrong');
    if (index === currentIndex) button.classList.add('current');
    button.textContent = String(index + 1);
    button.setAttribute('aria-label', `Question ${index + 1}${state?.checked ? (state.correct ? ', correct' : ', incorrect') : ', unanswered'}`);
    if (index === currentIndex) button.setAttribute('aria-current', 'step');
    button.title = `Question ${index + 1}${state?.checked ? (state.correct ? ' · Right' : ' · Wrong') : ' · Unanswered'}`;
    button.addEventListener('click', () => {
      currentQuestionId = question.id;
      savePosition();
      render();
      elements['question-panel'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return button;
  }));
  elements['map-empty'].hidden = !wrongOnly || wrong.length > 0;
  elements['question-grid'].hidden = wrongOnly && wrong.length === 0;
}

function extractRequirement(prompt) {
  const text = prompt.replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  const explicitQuestion = sentences.findIndex((sentence) => /^\s*(which|what|how|why|a solutions architect|what should|which solution)\b/i.test(sentence));
  const context = sentences.slice(0, explicitQuestion >= 0 ? explicitQuestion : sentences.length);
  const requirementSentences = context.filter((sentence) => /\b(must|need|needs|require|requires|want|wants|least|most|only|without|ensure|should|acceptable|within|quickly|latency|order|cost|secure|available|recover|recovery|overhead|operational)\b/i.test(sentence));
  const selected = (requirementSentences.length ? requirementSentences.slice(-2) : context.slice(-1)).join(' ').trim();
  return selected.length > 360 ? `${selected.slice(0, 357).trimEnd()}...` : selected;
}

function optionInsight(optionText) {
  const text = optionText.toLowerCase();
  if (/transfer acceleration/.test(text)) return 'S3 Transfer Acceleration routes uploads through AWS edge locations to improve long-distance transfers into one S3 bucket; multipart upload improves throughput for large objects.';
  if (/cross.region replication|\bcrr\b/.test(text)) return 'S3 Cross-Region Replication asynchronously copies objects between buckets in different Regions; it adds a replication path and does not make the original upload land directly in the destination bucket.';
  if (/snowball/.test(text)) return 'AWS Snowball is designed for bulk data transfer when network transfer is impractical; arranging device jobs is not a low-overhead, near-real-time upload path.';
  if (/sqs.{0,45}fifo|fifo.{0,45}sqs/.test(text)) return 'An SQS FIFO queue preserves ordering within each message group; the group ID defines which messages must stay in sequence.';
  if (/sqs/.test(text)) return 'An SQS standard queue scales well, but it provides best-effort ordering rather than the strict FIFO ordering required by some workloads.';
  if (/kinesis data streams|kinesis data stream/.test(text)) return 'Kinesis Data Streams preserves order within a shard; using the entity ID as the partition key keeps related events on the same shard.';
  if (/\bsns\b|simple notification service/.test(text)) return 'SNS is a pub/sub fan-out service; by itself it does not provide the per-message FIFO processing guarantee required by an ordered workflow.';
  if (/dax|dynamodb accelerator/.test(text)) return 'DynamoDB Accelerator (DAX) is a managed in-memory cache for DynamoDB reads and can improve read latency without changing the application’s DynamoDB API calls.';
  if (/elasticache/.test(text)) return 'ElastiCache is a separate in-memory cache; the application generally must be designed or changed to read from and maintain that cache.';
  if (/interface endpoint|private link/.test(text)) return 'An interface VPC endpoint uses AWS PrivateLink to reach supported services privately over the AWS network.';
  if (/gateway endpoint/.test(text)) return 'A gateway VPC endpoint provides private routing specifically for Amazon S3 or DynamoDB; it is not a general endpoint for other AWS services.';
  if (/cloudfront/.test(text)) return 'CloudFront caches content at edge locations, reducing repeated origin requests and latency for globally distributed viewers.';
  if (/storage lens/.test(text)) return 'Amazon S3 Storage Lens provides organization-wide visibility and metrics across S3 buckets, including storage configuration and usage.';
  if (/object lambda/.test(text)) return 'S3 Object Lambda can invoke Lambda to transform an object as it is retrieved, so a caller can receive a filtered view without changing the stored original.';
  if (/\bkms\b|key management service/.test(text)) return 'AWS KMS manages encryption keys and integrates with AWS services; permissions and key policies determine which principals can use a key.';
  if (/secrets manager/.test(text)) return 'AWS Secrets Manager stores and can rotate secrets; it is intended for secret lifecycle management rather than general-purpose application data processing.';
  if (/aurora global|global database/.test(text)) return 'An Aurora Global Database replicates an Aurora cluster across Regions with low-latency storage replication for disaster recovery and read access.';
  if (/multi.az|multi az/.test(text)) return 'A Multi-AZ database deployment maintains a standby in another Availability Zone for high availability; it is not a cross-Region disaster-recovery design.';
  if (/\bcloudtrail\b/.test(text)) return 'AWS CloudTrail records account activity and API calls for auditing; it is not a live application performance or resource-metrics service.';
  if (/\bcloudwatch\b/.test(text)) return 'Amazon CloudWatch collects metrics, logs, and alarms for monitoring workloads and responding to operational signals.';
  if (/auto scaling|autoscaling/.test(text)) return 'EC2 Auto Scaling adjusts instance capacity to match configured health and scaling policies; it does not itself cache or accelerate static content.';
  if (/\blambda\b/.test(text)) return 'AWS Lambda runs code in response to events without managing servers, but the function’s event path and processing logic still need to meet the stated latency and ordering requirements.';
  if (/\b(route 53|dns|failover routing)\b/.test(text)) return 'Amazon Route 53 provides DNS and health-check-based routing; DNS failover redirects traffic but does not replicate application data or make an unhealthy service healthy.';
  if (/patchloadbalan.{0,5}instance|awsec2.patchloadbalan.{0,5}instance|patch manager|systems manager.{0,30}patch|ssm.{0,30}patch/.test(text)) return 'The AWSEC2-PatchLoadBalancerInstance Systems Manager Automation document coordinates patching for a load-balanced EC2 instance: it removes the instance from service, patches it, and returns it to the load balancer.';
  if (/target type.{0,80}instance type|target group.{0,80}instance type|instance type.{0,80}target group/.test(text)) return 'An Application Load Balancer target group with instance targets registers EC2 instances by instance ID; that target type is required for the load-balancer-aware Systems Manager patch workflow used here.';
  if (/maintenance window/.test(text)) return 'Systems Manager Maintenance Windows schedules operational tasks, but scheduling a patch task alone does not provide the load-balancer-aware deregister, patch, and re-register workflow required here.';
  if (/state manager/.test(text)) return 'Systems Manager State Manager maintains a desired instance configuration; it does not by itself drain an instance from an ALB target group and safely return it after patching.';
  if (/\b(eventbridge|event bus|eventbridge scheduler)\b/.test(text)) return 'Amazon EventBridge routes events between producers and consumers; event buses support fan-out, while ordering guarantees depend on the specific event target and queue or stream.';
  if (/\b(aws backup|backup plan|recovery point)\b/.test(text)) return 'AWS Backup centrally schedules and manages backups; restoring from a recovery point is not the same as continuous replication or low-recovery-point failover.';
  if (/\b(direct connect|site.to.site vpn)\b/.test(text)) return 'AWS Direct Connect provides a dedicated network connection to AWS, while Site-to-Site VPN uses encrypted tunnels over the internet; neither choice alone copies application data.';
  if (/\b(efs|elastic file system)\b/.test(text)) return 'Amazon EFS is a managed, elastic NFS file system for Linux workloads and can be mounted concurrently by multiple instances.';
  if (/\b(fsx|lustre|windows file server)\b/.test(text)) return 'Amazon FSx provides managed file systems with workload-specific protocols and features, such as Windows file shares or high-performance Lustre.';
  if (/\b(aws config|configuration recorder|config rule)\b/.test(text)) return 'AWS Config records resource configuration and evaluates compliance rules over time; it is not a real-time traffic-control mechanism.';
  if (/\b(service control policy|\bscp\b|aws organizations)\b/.test(text)) return 'AWS Organizations service control policies set maximum available permissions for accounts; they do not grant permissions by themselves.';
  if (/\b(waf|web application firewall)\b/.test(text)) return 'AWS WAF filters HTTP requests using web ACL rules; it protects application endpoints but does not replace network routing or identity permissions.';
  if (/\b(spot instance|spot instances)\b/.test(text)) return 'EC2 Spot Instances can reduce compute costs but may be interrupted when AWS needs the capacity, so workloads must tolerate interruption.';
  if (/\biam\b|identity and access/.test(text)) return 'IAM policies control who can call AWS APIs and which resources they can access; they do not provide the application feature or data transformation by themselves.';
  if (/ebs snapshot|elastic block store/.test(text)) return 'EBS snapshots back up block volumes; copying and restoring them is a volume recovery workflow, not a direct S3 object-ingestion path.';
  if (/lifecycle|glacier|deep archive/.test(text)) return 'S3 Lifecycle automates object transitions and expiration; archival storage classes trade retrieval speed for lower storage cost.';
  if (/\brds\b|relational database service/.test(text)) return 'Amazon RDS manages relational databases, while the correct availability, replication, and recovery behavior depends on the selected deployment configuration.';
  if (/\bs3\b|simple storage service/.test(text)) return 'Amazon S3 is object storage; bucket policies, replication, lifecycle, and acceleration each solve different storage or transfer requirements.';
  return '';
}

function makeOptionRationale(option, correctOption, requirement) {
  const insight = optionInsight(option.text);
  const correctInsight = optionInsight(correctOption.text);
  if (option.correct) {
    return insight
      ? `${insight} This matches the stated requirement: ${requirement}`
      : `This option proposes: ${option.text} It is the choice marked correct in the source question and is the best match for: ${requirement}`;
  }
  const optionDescription = insight || `This option proposes: ${option.text}`;
  const comparison = correctInsight
    ? `The marked answer instead uses a more direct fit: ${correctInsight}`
    : `The source marks ${correctOption.letter} instead. Compare this proposal with the requirement and the marked choice: ${correctOption.text}`;
  return `${optionDescription} This is less suitable for this scenario because the deciding requirement is: ${requirement} ${comparison}`;
}

function setExplanationExpanded(expanded) {
  const section = elements['explanation'];
  section.dataset.expanded = String(expanded);
  elements['explanation-toggle'].setAttribute('aria-expanded', String(expanded));
  elements['explanation-toggle-hint'].textContent = expanded ? 'Hide' : 'Show';
}

function renderExplanation(question, state, correctOptions) {
  elements['explanation'].hidden = !state.checked;
  elements['option-reasons'].replaceChildren();
  if (!state.checked) {
    setExplanationExpanded(false);
    return;
  }
  // Default to collapsed each time the question changes; user opens it on demand.
  if (elements['explanation'].dataset.forQuestion !== question.id) {
    elements['explanation'].dataset.forQuestion = question.id;
    setExplanationExpanded(false);
  }

  const requirement = extractRequirement(question.prompt) || 'Choose the option that meets all stated constraints.';
  const primaryCorrect = correctOptions[0];
  elements['requirement-text'].textContent = requirement;
  elements['option-reasons'].replaceChildren(...question.options.map((option) => {
    const row = document.createElement('div');
    row.className = `option-reason ${option.correct ? 'is-correct' : 'is-incorrect'}`;
    const letter = document.createElement('span');
    letter.className = 'reason-letter';
    letter.textContent = option.letter;
    const content = document.createElement('div');
    const heading = document.createElement('p');
    heading.className = 'reason-heading';
    heading.textContent = option.correct ? 'Why it is right' : 'Why it is wrong';
    const rationale = document.createElement('p');
    rationale.className = 'reason-copy';
    rationale.textContent = makeOptionRationale(option, primaryCorrect, requirement);
    content.append(heading, rationale);
    row.append(letter, content);
    return row;
  }));

  const selectedWrong = question.options.find((option) => state.selected.includes(option.letter) && !option.correct);
  const trapOption = selectedWrong || question.options.find((option) => !option.correct);
  const trapInsight = trapOption && optionInsight(trapOption.text);
  const correctInsight = optionInsight(primaryCorrect.text);
  elements['trap-text'].textContent = trapOption
    ? `The tempting distractor is ${trapOption.letter}. ${trapInsight || `It sounds plausible, but it does not satisfy the marked answer for this scenario.`} Check it against the requirement: ${requirement}`
    : `Do not choose by familiar service name alone. Check every choice against the constraint: ${requirement}`;
  elements['takeaway-text'].textContent = `${correctInsight || `The source marks ${primaryCorrect.letter} as correct.`} When solving similar questions, identify the constraint first: ${requirement}`;
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
  if (currentMode === 'topics') {
    const topic = TOPIC_DEFINITIONS.find((entry) => entry.key === currentTopic);
    elements['question-type'].textContent = `${(topic?.label || 'TOPIC').toUpperCase()} · PRACTICE`;
  } else {
    elements['question-type'].textContent = `QUIZ ${String(currentQuizIndex + 1).padStart(2, '0')} · PRACTICE`;
  }
  elements['question-jump'].value = question ? String(questionIndex + 1) : '';
  elements['question-jump'].max = String(Math.max(list.length, 1));
  elements['jump-range'].textContent = `of ${list.length}`;
  elements['bank-count'].textContent = list.length.toLocaleString();
  elements['nav-caption'].textContent = question ? `${list.length} questions in this quiz` : 'Import documents to begin';
  elements['shuffle-button'].title = questionOrder.shuffled ? 'Restore question order' : 'Shuffle questions';
  elements['shuffle-button'].setAttribute('aria-label', elements['shuffle-button'].title);
  renderProgress();
  renderQuestionMap();
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
  renderExplanation(question, state, correctOptions);

  elements['options-list'].replaceChildren(...question.options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-option';
    button.classList.toggle('selected', state.selected.includes(option.letter));
    if (state.checked && option.correct) button.classList.add('is-correct');
    if (state.checked && state.selected.includes(option.letter) && !option.correct) button.classList.add('is-wrong');
    // Use aria-disabled instead of the disabled attribute so option text
    // stays selectable/copyable after grading. Clicks are already guarded
    // in toggleOption() by state.checked.
    button.classList.toggle('is-locked', state.checked);
    button.setAttribute('aria-disabled', String(state.checked));
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

function renderStreak(bumped, milestone) {
  const active = streakCurrent > 0;
  elements['streak-row'].dataset.active = String(active);
  elements['streak-count'].textContent = String(streakCurrent);
  elements['streak-best'].textContent = `Best ${streakBest}`;
  if (bumped && !REDUCED_MOTION) {
    const badge = elements['streak-count'];
    badge.classList.remove('bump');
    void badge.offsetWidth; // restart animation
    badge.classList.add('bump');
  }
  if (milestone && !REDUCED_MOTION) {
    const row = elements['streak-row'];
    row.classList.remove('milestone');
    void row.offsetWidth;
    row.classList.add('milestone');
  }
}

function launchConfetti(intensity) {
  if (REDUCED_MOTION) return;
  const layer = elements['confetti-layer'];
  const button = elements['check-button'];
  const rect = button.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const count = Math.round((intensity || 1) * 22);
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    const angle = (-Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.9);
    const distance = 120 + Math.random() * 220 * (intensity || 1);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance + 40 + Math.random() * 220;
    const dur = 900 + Math.random() * 700;
    piece.style.left = `${originX}px`;
    piece.style.top = `${originY}px`;
    piece.style.width = `${5 + Math.random() * 6}px`;
    piece.style.height = `${8 + Math.random() * 8}px`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.setProperty('--dx', `${dx}px`);
    piece.style.setProperty('--dy', `${dy}px`);
    piece.style.setProperty('--dr', `${Math.floor(Math.random() * 720 - 360)}deg`);
    piece.style.setProperty('--dur', `${dur}ms`);
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), dur + 60);
  }
}

function playReward(correct) {
  // Toggle the reward class on option buttons and let CSS animate them. The
  // class name is class-scoped so it is safe to reset every render pass.
  requestAnimationFrame(() => {
    const options = elements['options-list'].querySelectorAll('.answer-option');
    for (const button of options) {
      button.classList.remove('play-reward', 'play-reveal');
      void button.offsetWidth;
      if (button.classList.contains('is-wrong')) button.classList.add('play-reward');
      if (button.classList.contains('is-correct')) {
        button.classList.add(correct ? 'play-reward' : 'play-reveal');
      }
    }
  });
  if (correct) {
    elements['check-button'].classList.remove('flash-correct');
    void elements['check-button'].offsetWidth;
    elements['check-button'].classList.add('flash-correct');
    launchConfetti(1);
  }
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
  // Update session streak: increment on correct, reset on wrong. Fire a bigger
  // celebration at every 5-answer milestone (5, 10, 15, …).
  let bumped = false;
  let milestone = false;
  if (state.correct) {
    streakCurrent += 1;
    bumped = true;
    if (streakCurrent > streakBest) streakBest = streakCurrent;
    if (streakCurrent >= 5 && streakCurrent % 5 === 0) milestone = true;
  } else {
    streakCurrent = 0;
  }
  renderStreak(bumped, milestone);
  render();
  playReward(state.correct);
  if (milestone) launchConfetti(2.2);
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
  applyTopics(bank.questions);
  renderQuizChoices();
  setQuiz(currentMode === 'topics' ? currentTopic : currentQuizIndex, currentQuestionId);
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
  wrongOnly = false;
  setQuiz(Number(elements['quiz-filter'].value));
  render();
});
elements['topic-filter'].addEventListener('change', () => {
  wrongOnly = false;
  setQuiz(elements['topic-filter'].value);
  render();
});
document.querySelectorAll('[data-mode-choice]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') return;
    setMode(button.dataset.modeChoice);
  });
});
elements['wrong-filter'].addEventListener('click', () => {
  wrongOnly = !wrongOnly;
  renderQuestionMap();
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
elements['explanation-toggle'].addEventListener('click', () => {
  const expanded = elements['explanation'].dataset.expanded !== 'true';
  setExplanationExpanded(expanded);
});
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
  applyTopics(bank.questions);
  const savedPosition = loadPosition();
  const savedMode = savedPosition.mode === 'topics' ? 'topics' : 'parts';
  currentMode = savedMode;
  if (savedPosition.topic && TOPIC_DEFINITIONS.some((topic) => topic.key === savedPosition.topic)) {
    currentTopic = savedPosition.topic;
  }
  document.querySelectorAll('[data-mode-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.modeChoice === savedMode));
  });
  elements['quiz-filter-label'].hidden = savedMode !== 'parts';
  elements['topic-filter-label'].hidden = savedMode !== 'topics';
  renderQuizChoices();
  const resumeKey = savedMode === 'topics' ? currentTopic : (savedPosition.quizIndex ?? 0);
  setQuiz(resumeKey, savedPosition.questionId, savedPosition.shuffledOrder);
  renderStreak(false, false);
  render();
  if (bank.questions.length) {
    try {
      await saveBank(bank);
    } catch {
      showToast('Your question bank is ready. Local imports will only last for this visit.');
    }
  }
})();