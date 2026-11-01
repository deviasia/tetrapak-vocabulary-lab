/* Tetra Pak Vocabulary Lab
 * Vocabulary lives in ./vocabulary.json; learner progress lives in localStorage/Supabase.
 * Each term uses a permanent string ID so adding or reordering terms cannot shift progress.
 */
'use strict';

const STORAGE_KEY = 'tp_vocab_lab_v2';
const LEGACY_STORAGE_KEY = 'tp_vocab_lab_v1';
const CLOUD_CONFIG_KEY = 'tp_vocab_supabase_config_v1';

let words = [];
let categories = [];
let state = null;
let supabaseClient = null;
let cloudUser = null;
let cloudSaveTimer = null;
let cloudSyncBusy = false;
let cloudSyncPending = false;
let currentPage = 'today';
let filterCat = 'All';
let session = [];
let sessionIndex = 0;
let flipped = false;
let quiz = [];
let quizIndex = 0;
let quizScore = 0;
let answered = false;

const $ = (id) => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (date, amount) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = new Date().toLocaleDateString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
});

function emptyState() {
  return { schemaVersion: 2, items: {}, history: {}, streak: 0, lastStudy: null, goal: 12, sessions: {} };
}

function validateDataset(payload) {
  if (!payload || !Array.isArray(payload.terms)) throw new Error('vocabulary.json must contain a "terms" array.');
  const seen = new Set();
  const normalized = payload.terms.map((term, index) => {
    if (!term || typeof term !== 'object') throw new Error(`Term ${index + 1} is not an object.`);
    const id = String(term.id || '').trim();
    const en = String(term.en || '').trim();
    const vi = String(term.vi || '').trim();
    const category = String(term.category || '').trim();
    if (!id || !en || !vi || !category) throw new Error(`Term ${index + 1} needs id, en, vi and category.`);
    if (seen.has(id)) throw new Error(`Duplicate vocabulary ID: ${id}`);
    seen.add(id);
    return { ...term, id, en, vi, category };
  });
  if (!normalized.length) throw new Error('The vocabulary list is empty.');
  return normalized;
}

function buildLegacyIdMap() {
  const map = new Map();
  for (const word of words) {
    if (Number.isInteger(Number(word.legacyId)) && Number(word.legacyId) > 0) {
      map.set(String(Number(word.legacyId)), word.id);
    }
  }
  return map;
}

// Converts progress from the original numeric-ID version to stable vocabulary IDs.
function normalizeState(input) {
  const source = input?.state && typeof input.state === 'object' ? input.state : input;
  if (!source || typeof source !== 'object') return emptyState();
  const normalized = emptyState();
  const legacyMap = buildLegacyIdMap();
  const remapId = (rawId) => {
    const id = String(rawId);
    return legacyMap.get(id) || id;
  };

  for (const [rawId, item] of Object.entries(source.items || {})) {
    const id = remapId(rawId);
    if (words.some((word) => word.id === id) && item && typeof item === 'object') {
      normalized.items[id] = { status: 'new', interval: 0, due: today(), reviews: 0, ...item };
    }
  }
  for (const [day, dayItems] of Object.entries(source.history || {})) {
    if (!dayItems || typeof dayItems !== 'object') continue;
    normalized.history[day] = {};
    for (const [rawId, mark] of Object.entries(dayItems)) {
      const id = remapId(rawId);
      if (words.some((word) => word.id === id)) normalized.history[day][id] = mark;
    }
  }
  for (const [day, ids] of Object.entries(source.sessions || {})) {
    if (!Array.isArray(ids)) continue;
    normalized.sessions[day] = [...new Set(ids.map(remapId).filter((id) => words.some((word) => word.id === id)))];
  }
  normalized.streak = Number(source.streak || 0);
  normalized.lastStudy = source.lastStudy || null;
  normalized.goal = [8, 12, 15, 20].includes(Number(source.goal)) ? Number(source.goal) : 12;
  normalized.schemaVersion = 2;
  return normalized;
}

function loadLocalState() {
  let stored = null;
  let migrated = false;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) stored = JSON.parse(current);
    else {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        stored = JSON.parse(legacy);
        migrated = true;
      }
    }
  } catch (error) {
    console.warn('Could not read saved progress; starting with an empty state.', error);
  }
  state = normalizeState(stored);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (migrated) {
    $('dailyNotice').textContent = 'Progress from the previous trainer version was migrated to permanent vocabulary IDs.';
  }
}

function getItem(id) {
  return state.items[id] || { status: 'new', interval: 0, due: today(), reviews: 0 };
}
function isDue(id) {
  const item = getItem(id);
  return item.status === 'new' || !item.due || item.due <= today();
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSave();
}
function mergeCloudStates(localInput, remoteInput) {
  const local = normalizeState(localInput);
  const remote = normalizeState(remoteInput);
  const merged = emptyState();
  merged.streak = Math.max(local.streak || 0, remote.streak || 0);
  merged.lastStudy = (local.lastStudy || '') >= (remote.lastStudy || '') ? local.lastStudy : remote.lastStudy;
  merged.goal = local.goal || remote.goal || 12;

  for (const id of new Set([...Object.keys(local.items), ...Object.keys(remote.items)])) {
    const a = local.items[id];
    const b = remote.items[id];
    if (!a) merged.items[id] = b;
    else if (!b) merged.items[id] = a;
    else if (Number(a.reviews || 0) !== Number(b.reviews || 0)) {
      merged.items[id] = Number(a.reviews || 0) > Number(b.reviews || 0) ? a : b;
    } else {
      merged.items[id] = (a.due || '') >= (b.due || '') ? a : b;
    }
  }
  for (const day of new Set([...Object.keys(local.history), ...Object.keys(remote.history)])) {
    merged.history[day] = { ...(remote.history[day] || {}), ...(local.history[day] || {}) };
  }
  merged.sessions = { ...(remote.sessions || {}), ...(local.sessions || {}) };
  return merged;
}

function createSession() {
  const day = today();
  const validIds = new Set(words.map((word) => word.id));
  const existing = Array.isArray(state.sessions[day]) ? [...new Set(state.sessions[day].filter((id) => validIds.has(id)))] : [];
  if (existing.length >= state.goal) return existing;

  const due = words
    .filter((word) => isDue(word.id) && !existing.includes(word.id))
    .sort((a, b) => {
      const sa = getItem(a.id);
      const sb = getItem(b.id);
      if (sa.status === 'new' && sb.status !== 'new') return 1;
      if (sb.status === 'new' && sa.status !== 'new') return -1;
      return (sa.due || '').localeCompare(sb.due || '') || a.id.localeCompare(b.id);
    });
  const combined = existing.concat(due.slice(0, Math.max(0, state.goal - existing.length)).map((word) => word.id));
  state.sessions[day] = combined;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return combined;
}

function sessionReviewed() {
  const history = state.history[today()] || {};
  return session.filter((id) => Object.prototype.hasOwnProperty.call(history, id)).length;
}
function updateStats() {
  const total = words.length;
  const known = words.filter((word) => getItem(word.id).status === 'mastered').length;
  const learning = words.filter((word) => getItem(word.id).status === 'learning').length;
  const reviewed = Math.min(sessionReviewed(), session.length);
  $('overallPill').textContent = `${known} / ${total} mastered`;
  $('statKnown').textContent = known;
  $('statToday').textContent = `${reviewed}/${session.length}`;
  $('statStreak').textContent = `${state.streak || 0} ${(state.streak || 0) === 1 ? 'day' : 'days'}`;
  $('pKnown').textContent = known;
  $('pLearning').textContent = learning;
  $('pNew').textContent = Math.max(0, total - known - learning);
  $('dailyProgress').style.width = `${session.length ? reviewed / session.length * 100 : 0}%`;
  $('dailyPct').textContent = `${Math.round(session.length ? reviewed / session.length * 100 : 0)}%`;
  $('dailyCountLabel').textContent = `${session.length} terms · about ${Math.max(5, Math.round(session.length * 1.1))} min`;
  $('courseSize').textContent = `${total} terms`;
  $('libraryTotal').textContent = `${total} TERMS`;
  const counts = categories.map((cat) => `${words.filter((word) => word.category === cat).length} ${cat.toLowerCase()}`).join(' · ');
  $('categorySizeSummary').textContent = counts;
}
function selectedWord() {
  return words.find((word) => word.id === session[sessionIndex]) || words[0];
}
function renderCard() {
  if (!session.length) {
    $('cardWord').textContent = 'All caught up';
    $('cardTranslation').classList.add('hidden');
    $('cardHint').textContent = 'No terms are due right now. Add vocabulary or return tomorrow.';
    $('cardCount').textContent = '—';
    $('againBtn').disabled = true;
    $('knownBtn').disabled = true;
    $('nextBtn').disabled = true;
    return;
  }
  sessionIndex = Math.max(0, Math.min(sessionIndex, session.length - 1));
  const word = selectedWord();
  const item = getItem(word.id);
  const marked = !!(state.history[today()] || {})[word.id];
  flipped = false;
  $('cardCategory').textContent = word.category.toUpperCase();
  $('cardCount').textContent = `${String(sessionIndex + 1).padStart(2, '0')} / ${String(session.length).padStart(2, '0')}`;
  $('cardPrompt').textContent = 'ENGLISH TERM';
  $('cardWord').textContent = word.en;
  $('cardTranslation').textContent = word.vi;
  $('cardTranslation').classList.add('hidden');
  $('cardHint').textContent = 'Think of the Vietnamese meaning, then tap to reveal.';
  $('cardStatus').textContent = item.status === 'new' ? 'New term' : item.status === 'mastered' ? 'Mastered · review scheduled' : `Learning · ${item.reviews} review(s)`;
  $('againBtn').disabled = marked;
  $('knownBtn').disabled = marked;
  $('nextBtn').disabled = false;
}
function flipCard() {
  if (!session.length) return;
  flipped = !flipped;
  const word = selectedWord();
  $('cardPrompt').textContent = flipped ? 'VIETNAMESE MEANING' : 'ENGLISH TERM';
  $('cardWord').textContent = flipped ? word.vi : word.en;
  $('cardTranslation').classList.add('hidden');
  $('cardHint').textContent = flipped ? 'Say the English term aloud and make a short sentence.' : 'Think of the Vietnamese meaning, then tap to reveal.';
}
function markWord(known) {
  if (!session.length) return;
  const word = selectedWord();
  const item = { ...getItem(word.id) };
  if (!state.history[today()]) state.history[today()] = {};
  if (state.history[today()][word.id]) return;
  item.reviews = (item.reviews || 0) + 1;
  if (known) {
    item.interval = item.status === 'new' ? 1 : item.interval === 1 ? 3 : item.interval === 3 ? 7 : item.interval === 7 ? 14 : 30;
    item.status = item.interval >= 14 ? 'mastered' : 'learning';
    item.due = addDays(today(), item.interval);
  } else {
    item.status = 'learning';
    item.interval = 1;
    item.due = addDays(today(), 1);
  }
  state.items[word.id] = item;
  state.history[today()][word.id] = known ? 'known' : 'again';
  if (state.lastStudy !== today()) {
    state.streak = state.lastStudy === addDays(today(), -1) ? (state.streak || 0) + 1 : 1;
    state.lastStudy = today();
  }
  save();
  updateStats();
  renderCard();
  renderLibraryIfVisible();
}
function nextCard() {
  if (!session.length) return;
  sessionIndex = sessionIndex < session.length - 1 ? sessionIndex + 1 : 0;
  renderCard();
}
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  ['today', 'library', 'progress', 'quiz'].forEach((name) => $(`page-${name}`).classList.toggle('hidden', name !== page));
  if (page === 'library') renderLibrary();
  if (page === 'progress') renderProgress();
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
function renderCategoryFilters() {
  const counts = Object.fromEntries(categories.map((category) => [category, words.filter((word) => word.category === category).length]));
  $('categoryFilters').innerHTML = [
    `<button class="chip active" data-filter="All">All · ${words.length}</button>`,
    ...categories.map((category) => `<button class="chip" data-filter="${escapeHtml(category)}">${escapeHtml(category)} · ${counts[category]}</button>`)
  ].join('');
}
function renderLibrary() {
  const query = $('searchInput').value.toLocaleLowerCase().trim();
  const status = $('statusFilter').value;
  const results = words.filter((word) => {
    const item = getItem(word.id);
    return (filterCat === 'All' || word.category === filterCat)
      && (!query || word.en.toLocaleLowerCase().includes(query) || word.vi.toLocaleLowerCase().includes(query))
      && (status === 'all' || item.status === status);
  });
  $('resultCount').textContent = `${results.length} results`;
  $('vocabRows').innerHTML = results.map((word) => {
    const item = getItem(word.id);
    const label = item.status === 'mastered' ? 'Mastered' : item.status === 'learning' ? 'Learning' : 'New';
    const number = word.legacyId ? String(word.legacyId).padStart(3, '0') : 'NEW';
    return `<tr><td>${number}</td><td class="term">${escapeHtml(word.en)}</td><td class="translationcell">${escapeHtml(word.vi)}</td><td>${escapeHtml(word.category)}</td><td><span class="status ${item.status}">${label}</span></td><td><button class="rowbutton" data-study="${escapeHtml(word.id)}">Study →</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No terms match your search.</td></tr>';
  document.querySelectorAll('[data-study]').forEach((button) => button.addEventListener('click', () => studyWord(button.dataset.study)));
}
function renderLibraryIfVisible() {
  if (currentPage === 'library') renderLibrary();
}
function studyWord(id) {
  if (!session.includes(id)) session.unshift(id);
  sessionIndex = session.indexOf(id);
  showPage('today');
  renderCard();
}
function renderProgress() {
  $('categoryProgress').innerHTML = categories.map((category) => {
    const list = words.filter((word) => word.category === category);
    const mastered = list.filter((word) => getItem(word.id).status === 'mastered').length;
    const percent = list.length ? mastered / list.length * 100 : 0;
    return `<div class="categoryrow"><strong>${escapeHtml(category)}</strong><div class="progress"><span style="width:${percent}%"></span></div><span>${mastered}/${list.length}</span></div>`;
  }).join('');
  const dates = Array.from({ length: 7 }, (_, index) => addDays(today(), index - 6));
  $('historyChart').innerHTML = dates.map((day) => {
    const count = Object.keys(state.history[day] || {}).length;
    const height = Math.max(5, Math.min(100, count / Math.max(1, state.goal) * 100));
    const color = count ? '#087f78' : '#e8efec';
    const label = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:end;height:100%;gap:6px"><span style="font-size:10px;color:var(--muted)">${count || ''}</span><div style="height:${height}%;width:100%;max-width:34px;background:${color};border-radius:7px 7px 3px 3px"></div><span style="font-size:10px;color:var(--muted)">${label}</span></div>`;
  }).join('');
}
function startQuiz() {
  if (!session.length) { alert('There are no terms in today’s lesson to quiz.'); return; }
  quiz = session.map((id) => words.find((word) => word.id === id)).filter(Boolean).slice(0, 10);
  for (let index = quiz.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [quiz[index], quiz[j]] = [quiz[j], quiz[index]];
  }
  quizIndex = 0;
  quizScore = 0;
  answered = false;
  showPage('quiz');
  renderQuiz();
}
function renderQuiz() {
  const word = quiz[quizIndex];
  if (!word) return;
  answered = false;
  $('quizCategory').textContent = word.category.toUpperCase();
  $('quizCount').textContent = `Question ${quizIndex + 1} / ${quiz.length}`;
  $('quizProgress').style.width = `${quizIndex / quiz.length * 100}%`;
  $('quizWord').textContent = word.en;
  $('quizFeedback').innerHTML = '';
  $('quizNext').disabled = true;
  $('quizNext').textContent = quizIndex === quiz.length - 1 ? 'See results' : 'Next question →';
  const options = [word.vi];
  const candidates = [...new Set(words.map((entry) => entry.vi).filter((meaning) => meaning !== word.vi))];
  while (options.length < 4 && candidates.length) {
    const index = Math.floor(Math.random() * candidates.length);
    options.push(candidates.splice(index, 1)[0]);
  }
  options.sort(() => Math.random() - 0.5);
  $('quizChoices').innerHTML = options.map((option) => `<button class="choice">${escapeHtml(option)}</button>`).join('');
  document.querySelectorAll('.choice').forEach((button) => button.addEventListener('click', () => answerQuiz(button, word)));
}
function answerQuiz(button, word) {
  if (answered) return;
  answered = true;
  const correct = button.textContent === word.vi;
  if (correct) quizScore += 1;
  document.querySelectorAll('.choice').forEach((option) => {
    option.disabled = true;
    if (option.textContent === word.vi) option.classList.add('correct');
  });
  if (!correct) button.classList.add('wrong');
  $('quizFeedback').innerHTML = `<div class="feedback ${correct ? 'good' : 'bad'}">${correct ? 'Correct.' : 'Not quite.'} <b>${escapeHtml(word.en)}</b> means <b>${escapeHtml(word.vi)}</b>.</div>`;
  $('quizNext').disabled = false;
}
function finishQuiz() {
  $('quizCategory').textContent = 'COMPLETED';
  $('quizCount').textContent = 'Results';
  $('quizProgress').style.width = '100%';
  $('quizWord').textContent = `${quizScore} / ${quiz.length} correct`;
  $('quizChoices').innerHTML = '';
  $('quizFeedback').innerHTML = `<div class="feedback ${quizScore >= Math.ceil(quiz.length * 0.7) ? 'good' : 'bad'}">${quizScore >= Math.ceil(quiz.length * 0.7) ? 'Good work.' : 'Keep practising.'} Review the terms you missed and try again later.</div>`;
  $('quizNext').textContent = 'Back to lesson';
  $('quizNext').disabled = false;
  $('quizNext').dataset.finished = 'true';
}

// --- Import/export ---
function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
function exportProgress() {
  downloadJson('tetrapak-vocabulary-progress.json', {
    exportVersion: 2,
    exportedAt: new Date().toISOString(),
    vocabularyDatasetVersion: document.documentElement.dataset.vocabularyVersion || null,
    wordCount: words.length,
    state
  });
}
async function importProgress(file) {
  const parsed = JSON.parse(await file.text());
  const imported = normalizeState(parsed);
  state = mergeCloudStates(state, imported);
  session = createSession();
  sessionIndex = 0;
  save();
  updateStats();
  renderCard();
  renderLibraryIfVisible();
  if (currentPage === 'progress') renderProgress();
  alert('Progress imported. Numeric IDs from the previous trainer are mapped to permanent vocabulary IDs where possible.');
}

// --- Supabase cloud synchronization ---
function cloudStatus(message) {
  if ($('cloudStatus')) $('cloudStatus').textContent = message;
  if ($('cloudHelp')) $('cloudHelp').textContent = message;
}
async function syncToCloud() {
  if (!supabaseClient || !cloudUser) return;
  if (cloudSyncBusy) { cloudSyncPending = true; return; }
  cloudSyncBusy = true;
  cloudStatus('Syncing progress…');
  try {
    const { error } = await supabaseClient.from('vocab_progress').upsert({
      user_id: cloudUser.id,
      state,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    cloudStatus(`Synced · ${cloudUser.email}`);
  } catch (error) {
    console.error(error);
    cloudStatus(`Sync error: ${error.message || 'check your connection and RLS policies'}`);
  } finally {
    cloudSyncBusy = false;
    if (cloudSyncPending) {
      cloudSyncPending = false;
      scheduleCloudSave(150);
    }
  }
}
function scheduleCloudSave(delay = 900) {
  if (!cloudUser || !supabaseClient) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(syncToCloud, delay);
}
async function loadCloudState(user) {
  if (!supabaseClient || !user) return;
  cloudUser = user;
  cloudStatus('Loading cloud progress…');
  try {
    const { data, error } = await supabaseClient
      .from('vocab_progress')
      .select('state, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (data && data.state) state = mergeCloudStates(state, data.state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    session = createSession();
    sessionIndex = 0;
    updateStats();
    renderCard();
    renderLibraryIfVisible();
    if (currentPage === 'progress') renderProgress();
    await syncToCloud();
  } catch (error) {
    console.error(error);
    cloudStatus(`Cloud load failed: ${error.message || 'unknown error'}`);
  }
}
function initializeSupabase() {
  const url = $('supabaseUrl').value.trim();
  const key = $('supabaseKey').value.trim();
  if (!url || !key) { cloudStatus('Enter your Supabase Project URL and publishable key first.'); return false; }
  if (!window.supabase?.createClient) { cloudStatus('Supabase library did not load. Check your internet connection.'); return false; }
  try {
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify({ url, key }));
    supabaseClient = window.supabase.createClient(url, key);
    cloudStatus('Connection configured. Log in or create an account.');
    supabaseClient.auth.onAuthStateChange((event, sessionData) => {
      if (event === 'SIGNED_IN' && sessionData?.user) {
        if (cloudUser?.id !== sessionData.user.id) setTimeout(() => loadCloudState(sessionData.user), 0);
      }
      if (event === 'SIGNED_OUT') {
        cloudUser = null;
        cloudStatus('Logged out · local progress retained');
      }
    });
    supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      if (data.session?.user) loadCloudState(data.session.user);
    }).catch((error) => cloudStatus(`Session error: ${error.message}`));
    return true;
  } catch (error) {
    cloudStatus(`Configuration error: ${error.message}`);
    return false;
  }
}
function restoreCloudConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || 'null');
    if (config) {
      $('supabaseUrl').value = config.url || '';
      $('supabaseKey').value = config.key || '';
      initializeSupabase();
    }
  } catch (error) {
    console.warn('Could not restore Supabase config.', error);
  }
}

function bindEvents() {
  document.querySelectorAll('.nav button').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $('flashcard').addEventListener('click', flipCard);
  $('flashcard').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flipCard(); }
  });
  $('againBtn').addEventListener('click', () => markWord(false));
  $('knownBtn').addEventListener('click', () => markWord(true));
  $('nextBtn').addEventListener('click', nextCard);
  document.addEventListener('keydown', (event) => {
    if (currentPage !== 'today' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); flipCard(); }
    if (event.key === 'ArrowLeft') markWord(false);
    if (event.key === 'ArrowRight') {
      const word = selectedWord();
      if (word && !(state.history[today()] || {})[word.id]) markWord(true);
      else nextCard();
    }
  });
  $('goalSelect').value = String(state.goal || 12);
  $('goalSelect').addEventListener('change', (event) => {
    state.goal = Number(event.target.value);
    delete state.sessions[today()];
    session = createSession();
    sessionIndex = 0;
    save();
    renderCard();
    updateStats();
  });
  $('searchInput').addEventListener('input', renderLibrary);
  $('statusFilter').addEventListener('change', renderLibrary);
  $('categoryFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filterCat = button.dataset.filter;
    document.querySelectorAll('#categoryFilters .chip').forEach((chip) => chip.classList.toggle('active', chip === button));
    renderLibrary();
  });
  $('startQuizTop').addEventListener('click', startQuiz);
  $('exitQuiz').addEventListener('click', () => showPage('today'));
  $('quizNext').addEventListener('click', () => {
    if ($('quizNext').dataset.finished === 'true') {
      $('quizNext').dataset.finished = 'false';
      showPage('today');
      return;
    }
    if (!answered) return;
    if (quizIndex < quiz.length - 1) { quizIndex += 1; renderQuiz(); }
    else finishQuiz();
  });
  $('exportBtn').addEventListener('click', exportProgress);
  $('importProgressBtn').addEventListener('click', () => $('progressFile').click());
  $('progressFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importProgress(file); }
    catch (error) { alert(`Could not import progress: ${error.message}`); }
    finally { event.target.value = ''; }
  });
  $('saveCloudConfig').addEventListener('click', initializeSupabase);
  $('cloudSignup').addEventListener('click', async () => {
    if (!supabaseClient && !initializeSupabase()) return;
    const email = $('cloudEmail').value.trim();
    const password = $('cloudPassword').value;
    if (!email || !password) { cloudStatus('Enter an email address and password.'); return; }
    cloudStatus('Creating account…');
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) { cloudStatus(`Sign-up failed: ${error.message}`); return; }
    if (data.session?.user) await loadCloudState(data.session.user);
    else cloudStatus('Account created. Check your email to confirm, then log in.');
  });
  $('cloudLogin').addEventListener('click', async () => {
    if (!supabaseClient && !initializeSupabase()) return;
    const email = $('cloudEmail').value.trim();
    const password = $('cloudPassword').value;
    if (!email || !password) { cloudStatus('Enter an email address and password.'); return; }
    cloudStatus('Logging in…');
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) cloudStatus(`Login failed: ${error.message}`);
  });
  $('cloudLogout').addEventListener('click', async () => {
    if (!supabaseClient) { cloudStatus('Not connected.'); return; }
    const { error } = await supabaseClient.auth.signOut();
    if (error) cloudStatus(`Logout failed: ${error.message}`);
  });
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset all learning progress? Export a backup first if you may need it.')) return;
    state = emptyState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    session = createSession();
    sessionIndex = 0;
    updateStats();
    renderCard();
    renderLibraryIfVisible();
    if (currentPage === 'progress') renderProgress();
    await syncToCloud();
  });
}

async function init() {
  $('todayLabel').textContent = dateLabel.toUpperCase();
  try {
    const response = await fetch('./vocabulary.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load vocabulary.json (HTTP ${response.status}).`);
    const payload = await response.json();
    words = validateDataset(payload);
    categories = [...new Set(words.map((word) => word.category))].sort((a, b) => a.localeCompare(b));
    document.documentElement.dataset.vocabularyVersion = payload.datasetVersion || '';
    loadLocalState();
    renderCategoryFilters();
    session = createSession();
    bindEvents();
    updateStats();
    renderCard();
    $('dailyNotice').textContent = `${words.length} terms loaded from vocabulary.json. Progress is saved locally and can sync to Supabase when you log in.`;
    restoreCloudConfig();
  } catch (error) {
    console.error(error);
    $('cardWord').textContent = 'Vocabulary data could not be loaded';
    $('cardHint').textContent = `${error.message} Make sure index.html and vocabulary.json are both in the published repository.`;
    $('dailyNotice').textContent = error.message;
    cloudStatus('Vocabulary data unavailable. Check the GitHub Pages deployment.');
  }
}

init();
