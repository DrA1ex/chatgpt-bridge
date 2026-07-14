// Pure, DOM-independent state helpers for the ChatGPT content-script parser.
// Loaded before content.js and exposed as a global because MV3 content scripts
// listed in manifest.json are classic scripts, not ES modules.
(() => {
  'use strict';

  const PHASE = Object.freeze({
    USER: 'USER',
    ASSISTANT_PLACEHOLDER: 'ASSISTANT_PLACEHOLDER',
    ASSISTANT_REASONING: 'ASSISTANT_REASONING',
    ASSISTANT_FINAL_STREAMING: 'ASSISTANT_FINAL_STREAMING',
    ASSISTANT_FINAL_STREAMING_WITH_HISTORY: 'ASSISTANT_FINAL_STREAMING_WITH_HISTORY',
    ASSISTANT_FINAL: 'ASSISTANT_FINAL',
    TOOL_RUNNING: 'TOOL_RUNNING',
    NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
    NEEDS_CONTINUE: 'NEEDS_CONTINUE',
    ERROR: 'ERROR',
  });

  function normalizeText(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function normalizeComparable(value = '') {
    return normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
  }

  const INTELLIGENCE_EFFORT_ALIASES = Object.freeze({
    instant: Object.freeze([
      'instant', 'fast', 'quick', 'мгновенный', 'мгновенно', 'быстрый', 'быстро',
    ]),
    low: Object.freeze([
      'low', 'низкий', 'низкая', 'низкое',
    ]),
    medium: Object.freeze([
      'medium', 'med', 'moderate', 'balanced', 'normal', 'standard',
      'средний', 'средняя', 'среднее', 'обычный', 'сбалансированный',
    ]),
    high: Object.freeze([
      'high', 'высокий', 'высокая', 'высокое',
    ]),
    xhigh: Object.freeze([
      'xhigh', 'x high', 'extra high', 'very high', 'maximum', 'max',
      'очень высокий', 'максимальный', 'максимальная', 'максимальное',
    ]),
    auto: Object.freeze([
      'auto', 'automatic', 'авто', 'автоматически', 'автоматический',
    ]),
  });

  function intelligenceSlug(value = '') {
    const normalized = normalizeComparable(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'unknown';
  }

  function canonicalEffortId(value = '', index = -1, total = 0) {
    const normalized = normalizeComparable(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Check longer/more specific aliases first so "очень высокий" does not
    // collapse to the ordinary high tier.
    const orderedIds = ['xhigh', 'instant', 'medium', 'high', 'low', 'auto'];
    for (const id of orderedIds) {
      for (const alias of INTELLIGENCE_EFFORT_ALIASES[id]) {
        const candidate = normalizeComparable(alias);
        if (normalized === candidate || normalized.startsWith(`${candidate} `)) return id;
      }
    }

    // The current ChatGPT intelligence picker exposes exactly three ordered
    // tiers. This positional fallback is deliberately bounded to that shape;
    // unfamiliar menus are preserved with a stable opaque id instead of being
    // guessed as a known effort.
    if (Number(total) === 3 && Number(index) >= 0 && Number(index) < 3) {
      return ['instant', 'medium', 'high'][Number(index)];
    }
    return `effort-${intelligenceSlug(value)}`;
  }

  function normalizeIntelligenceOptions(kind = '', options = []) {
    const source = Array.isArray(options) ? options : [];
    return source.map((option, index) => {
      const label = normalizeText(option?.label || option?.rawText || '');
      const rawText = normalizeText(option?.rawText || label);
      const selected = Boolean(option?.selected || option?.checked);
      const annotation = normalizeText(option?.annotation || '');
      const normalizedKind = kind === 'effort' ? 'effort' : 'model';
      const id = normalizedKind === 'effort'
        ? canonicalEffortId(`${label} ${rawText}`, index, source.length)
        : `model-${intelligenceSlug(label || rawText)}`;
      return {
        ...option,
        kind: normalizedKind,
        id,
        value: normalizedKind === 'effort' ? id : label,
        label,
        rawText,
        selected,
        checked: selected,
        index,
        ...(annotation ? { annotation } : {}),
      };
    });
  }

  function intelligenceOptionMatches(option = {}, desired = '') {
    const wanted = normalizeComparable(desired).replace(/[\s_.-]+/g, '');
    if (!wanted) return false;
    const values = [option?.id, option?.value, option?.label, option?.rawText]
      .map((value) => normalizeComparable(value).replace(/[\s_.-]+/g, ''))
      .filter(Boolean);
    return values.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value));
  }

  function resolveCurrentModel(models = [], trigger = null) {
    const normalizedModels = normalizeIntelligenceOptions('model', models);
    const triggerLabel = normalizeText(trigger?.label || trigger?.rawText || '');
    const triggerMatch = triggerLabel
      ? normalizedModels.find((option) => intelligenceOptionMatches(option, triggerLabel))
      : null;
    const checkedMatch = normalizedModels.find((option) => option.checked) || null;
    let current = triggerMatch || checkedMatch || null;
    let resolvedModels = normalizedModels;

    if (!current && triggerLabel) {
      current = normalizeIntelligenceOptions('model', [{
        label: triggerLabel,
        rawText: normalizeText(trigger?.rawText || triggerLabel),
        selected: true,
      }])[0];
      resolvedModels = [current, ...normalizedModels];
    }

    if (current) {
      resolvedModels = resolvedModels.map((option) => ({
        ...option,
        selected: option.id === current.id,
        selectionSource: option.id === current.id
          ? (triggerMatch ? 'submenu-trigger' : 'submenu-check')
          : undefined,
      }));
      current = resolvedModels.find((option) => option.id === current.id) || current;
    }

    return {
      models: resolvedModels,
      current,
      trigger: triggerLabel ? {
        kind: 'model-trigger',
        id: `model-trigger-${intelligenceSlug(triggerLabel)}`,
        label: triggerLabel,
        rawText: normalizeText(trigger?.rawText || triggerLabel),
      } : null,
      checkedModel: checkedMatch,
    };
  }


  const CODE_LANGUAGE_ALIASES = Object.freeze({
    js: 'javascript',
    javascript: 'javascript',
    node: 'javascript',
    nodejs: 'javascript',
    'node.js': 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    py: 'python',
    python: 'python',
    shell: 'bash',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'fish',
    cplusplus: 'cpp',
    'c++': 'cpp',
    cpp: 'cpp',
    csharp: 'csharp',
    'c#': 'csharp',
    cs: 'csharp',
    objectivec: 'objective-c',
    'objective-c': 'objective-c',
    objc: 'objective-c',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    markdown: 'markdown',
    plaintext: 'text',
    'plain text': 'text',
    plain: 'text',
    text: 'text',
    console: 'text',
    terminal: 'text',
    shellsession: 'shell-session',
    'shell-session': 'shell-session',
  });

  const CODE_LANGUAGE_UI_ACTIONS = Object.freeze([
    'copy code', 'copy', 'copied', 'run code', 'run', 'execute', 'edit', 'download',
    'expand', 'collapse', 'wrap lines', 'unwrap lines', 'open in canvas',
    'preview', 'open', 'save', 'share', 'full screen', 'fullscreen', 'code', 'code block',
    'копировать код', 'копировать', 'скопировано', 'запустить код', 'запустить',
    'выполнить', 'редактировать', 'скачать', 'развернуть', 'свернуть',
    'предпросмотр', 'открыть', 'сохранить', 'поделиться', 'на весь экран', 'код', 'блок кода',
    'copiar código', 'copiar', 'copiado', 'ejecutar código', 'ejecutar',
    'code kopieren', 'kopieren', 'kopiert', 'code ausführen', 'ausführen',
    'copier le code', 'copier', 'copié', 'exécuter le code', 'exécuter',
    'copiar código', 'executar código', 'executar', 'copia codice', 'copia', 'copiato', 'esegui codice', 'esegui',
    'コードをコピー', 'コピー', '実行', '코드 복사', '복사', '실행', '复制代码', '复制', '运行代码', '运行',
  ]);

  function normalizeCodeLanguageLabel(value = '') {
    const raw = normalizeText(value)
      .toLowerCase()
      .replace(/^language[-_: ]+/i, '')
      .replace(/^[`'"\s]+|[`'"\s:]+$/g, '')
      .trim();
    if (!raw || raw.length > 40 || /[\n\r]/.test(raw)) return '';
    const compact = raw.replace(/[\s_.-]+/g, '');
    if (CODE_LANGUAGE_UI_ACTIONS.includes(raw) || /^(?:copycode|runcode|execute|copied|run|copy|const|let|var|function|import|from|def|class|return|print|true|false|null|none)$/.test(compact)) return '';
    if (CODE_LANGUAGE_ALIASES[raw]) return CODE_LANGUAGE_ALIASES[raw];
    if (CODE_LANGUAGE_ALIASES[compact]) return CODE_LANGUAGE_ALIASES[compact];
    if (/^(?:json|jsonc|json5|html|css|scss|sass|less|sql|jsx|tsx|java|c|go|golang|rust|ruby|php|swift|kotlin|xml|r|lua|dart|scala|perl|powershell|dockerfile|docker|toml|ini|diff|graphql|mermaid|latex|tex|makefile|cmake|nginx|apache|protobuf|proto|solidity|wasm|assembly|asm|haskell|clojure|elixir|erlang|fortran|matlab|groovy|vim|regex|http|csv)$/.test(raw)) return raw === 'golang' ? 'go' : raw === 'docker' ? 'dockerfile' : raw;
    // Unknown but structurally scoped language labels are preserved when they
    // are a single safe token. UI prose and sentences are rejected above.
    if (/^[a-z][a-z0-9+#./-]{0,31}$/i.test(raw)) return raw;
    return '';
  }

  function isKnownCodeLanguageLabel(value = '') {
    const raw = normalizeText(value)
      .toLowerCase()
      .replace(/^language[-_: ]+/i, '')
      .replace(/^[`'"\s]+|[`'"\s:]+$/g, '')
      .trim();
    const compact = raw.replace(/[\s_.-]+/g, '');
    if (CODE_LANGUAGE_ALIASES[raw] || CODE_LANGUAGE_ALIASES[compact]) return true;
    return /^(?:json|jsonc|json5|html|css|scss|sass|less|sql|jsx|tsx|java|c|go|golang|rust|ruby|php|swift|kotlin|xml|r|lua|dart|scala|perl|powershell|dockerfile|docker|toml|ini|diff|graphql|mermaid|latex|tex|makefile|cmake|nginx|apache|protobuf|proto|solidity|wasm|assembly|asm|haskell|clojure|elixir|erlang|fortran|matlab|groovy|vim|regex|http|csv)$/i.test(raw);
  }

  function classifyCodeWidgetChromeText(value = '', options = {}) {
    const text = normalizeText(value);
    if (!text) return { kind: 'empty', text: '', languages: [] };
    const signal = normalizeText(`${text} ${options.ariaLabel || ''} ${options.title || ''}`);
    const action = Boolean(options.interactive)
      || CODE_LANGUAGE_UI_ACTIONS.some((item) => normalizeComparable(signal).includes(normalizeComparable(item)));
    if (action) return { kind: 'interface_action', text, languages: [] };
    const languages = codeLanguageLabelsFromText(text);
    if (languages.length) {
      const known = languages.some((language) => isKnownCodeLanguageLabel(language));
      return { kind: 'language', text, languages, confidence: known ? 'high' : 'medium' };
    }
    return { kind: 'unknown', text, languages: [] };
  }

  function summarizeParserLeafOwnership(records = []) {
    const result = {
      visibleTextLeaves: 0,
      contentLeaves: 0,
      interfaceLeaves: 0,
      artifactLeaves: 0,
      reasoningLeaves: 0,
      unknownLeaves: 0,
      unknownVisualElements: 0,
      duplicateLeaves: 0,
      classifiedLeaves: 0,
      coveragePercent: 100,
    };
    for (const record of Array.isArray(records) ? records : []) {
      const kind = String(record?.category || record?.kind || 'unknown');
      if (kind === 'unknown-visual') {
        result.unknownVisualElements += 1;
        continue;
      }
      result.visibleTextLeaves += 1;
      if (kind === 'content') result.contentLeaves += 1;
      else if (kind === 'interface') result.interfaceLeaves += 1;
      else if (kind === 'artifact') result.artifactLeaves += 1;
      else if (kind === 'reasoning') result.reasoningLeaves += 1;
      else if (kind === 'duplicate') result.duplicateLeaves += 1;
      else result.unknownLeaves += 1;
    }
    result.classifiedLeaves = result.contentLeaves + result.interfaceLeaves + result.artifactLeaves + result.reasoningLeaves;
    result.coveragePercent = result.visibleTextLeaves > 0
      ? Number(((result.classifiedLeaves / result.visibleTextLeaves) * 100).toFixed(2))
      : 100;
    return result;
  }

  function codeLanguageLabelsFromText(value = '') {
    const text = String(value || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const escapedActions = CODE_LANGUAGE_UI_ACTIONS
      .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    const actionPattern = new RegExp(`(?:^|[\\s,:;()\\[\\]–—-])(?:${escapedActions.join('|')})(?=$|[\\s,:;()\\[\\]–—-])`, 'giu');
    const rawSegments = [text, ...text.split(/\n+|\t+|\s+[|•·]\s+/g)];
    const labels = [];
    const seen = new Set();
    const add = (candidate) => {
      const language = normalizeCodeLanguageLabel(candidate);
      if (language && !seen.has(language)) {
        seen.add(language);
        labels.push(language);
      }
    };
    for (const rawSegment of rawSegments) {
      const segment = normalizeText(rawSegment).trim();
      if (!segment || segment.length > 160) continue;
      add(segment);

      // Accessibility labels commonly use forms such as “Code block: Python”
      // or “Language — JavaScript”. Capture the value explicitly rather than
      // treating arbitrary prose before a <pre> as a language name.
      const descriptor = segment.match(/(?:code\s*block|language|язык|блок\s+кода)\s*[:;,–—-]?\s*([a-z0-9+#./-]{1,40})/iu);
      if (descriptor?.[1]) add(descriptor[1]);

      const stripped = segment
        .replace(actionPattern, ' ')
        .replace(/^[\s,:;()\[\]–—-]+|[\s,:;()\[\]–—-]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (stripped && stripped !== segment) add(stripped);
    }
    return labels;
  }

  function rankCodeLanguageCandidates(candidates = [], targetPreIndex = -1) {
    const target = Number(targetPreIndex);
    const ranked = [];
    for (const [index, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
      const values = [candidate?.language, ...(codeLanguageLabelsFromText(candidate?.text || candidate?.label || ''))].filter(Boolean);
      const seenLanguages = new Set();
      for (const languageValue of values) {
        const language = normalizeCodeLanguageLabel(languageValue);
        if (!language || seenLanguages.has(language)) continue;
        seenLanguages.add(language);
        const preIndex = Number.isInteger(candidate?.preIndex) ? candidate.preIndex : -1;
        const nextPreIndex = Number.isInteger(candidate?.nextPreIndex) ? candidate.nextPreIndex : -1;
        const previousPreIndex = Number.isInteger(candidate?.previousPreIndex) ? candidate.previousPreIndex : -1;
        const containerPreCount = Number(candidate?.containerPreCount || 0);
        const distance = Math.max(0, Number(candidate?.distance || 0));
        const visualDistance = Math.max(0, Number(candidate?.visualDistance || 0));
        let score = Number(candidate?.score || 0);
        if (candidate?.directPreviousSibling) score += 12_000;
        if (candidate?.sameCodeWrapper) score += 8_000;
        if (candidate?.headerLike) score += 4_000;
        if (candidate?.actionLike) score += 6_000;
        if (candidate?.attributeLike) score += 10_000;
        if (candidate?.directText) score += 2_500;
        if (candidate?.semanticContent) score -= 50_000;
        const knownLanguage = typeof candidate?.knownLanguage === 'boolean' ? candidate.knownLanguage : isKnownCodeLanguageLabel(language);
        if (knownLanguage) score += 750;
        if (!knownLanguage && !candidate?.headerLike && !candidate?.actionLike && !candidate?.attributeLike) score -= 30_000;
        if (preIndex === target) score += 10_000;
        else if (preIndex >= 0) score -= 20_000;
        if (containerPreCount === 1 && (preIndex === target || nextPreIndex === target)) score += 5_000;
        if (nextPreIndex === target) score += 2_000;
        else if (nextPreIndex >= 0) score -= 12_000;
        if (previousPreIndex === target) score += 250;
        score -= Math.min(distance, 2_000);
        score -= Math.min(Math.round(visualDistance), 1_000);
        ranked.push({
          language,
          score,
          index,
          knownLanguage,
          preIndex,
          nextPreIndex,
          previousPreIndex,
          containerPreCount,
          distance,
          visualDistance,
          source: candidate?.source || '',
          text: normalizeText(candidate?.text || candidate?.label || '').slice(0, 240),
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.distance - b.distance || a.index - b.index);
    return ranked;
  }

  function selectCodeLanguageCandidate(candidates = [], targetPreIndex = -1) {
    const ranked = rankCodeLanguageCandidates(candidates, targetPreIndex);
    return ranked[0]?.score > 0 ? ranked[0].language : '';
  }

  function isAssistantAuthorLabel(value = '') {
    const text = normalizeText(value);
    if (!text || text.length > 80 || /\n/.test(text)) return false;
    return /^(?:(?:chatgpt|assistant|ассистент)\s+(?:said|says|сказал(?:а)?|говорит)|(?:you|user|вы|пользователь)\s+(?:said|say|сказал(?:и)?|говорит))\s*:?$/iu.test(text);
  }

  function conversationIdFromUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''), 'https://chatgpt.com');
      return parsed.pathname.match(/^\/c\/([^/?#]+)\/?$/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function canonicalConversationUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''), 'https://chatgpt.com');
      const id = conversationIdFromUrl(parsed.toString());
      if (!id) return '';
      const host = parsed.hostname.toLowerCase();
      if (host !== 'chatgpt.com' && host !== 'chat.openai.com') return '';
      return `${parsed.protocol}//${host}/c/${id}`;
    } catch {
      return '';
    }
  }

  function verifySessionDeletionTarget({ currentUrl = '', expectedUrl = '', expectedSessionId = '' } = {}) {
    const currentId = conversationIdFromUrl(currentUrl);
    const expectedIdFromUrl = conversationIdFromUrl(expectedUrl);
    const expectedId = String(expectedSessionId || '').trim();
    const currentCanonical = canonicalConversationUrl(currentUrl);
    const expectedCanonical = canonicalConversationUrl(expectedUrl);

    if (!expectedId) return { ok: false, reason: 'missing_expected_session_id' };
    if (!expectedUrl) return { ok: false, reason: 'missing_expected_url' };
    if (!currentId || !currentCanonical) return { ok: false, reason: 'current_url_is_not_a_conversation' };
    if (!expectedIdFromUrl || !expectedCanonical) return { ok: false, reason: 'expected_url_is_not_a_conversation' };
    if (expectedId !== expectedIdFromUrl) {
      return { ok: false, reason: 'expected_session_url_mismatch', currentId, expectedId, expectedIdFromUrl };
    }
    if (currentId !== expectedId) {
      return { ok: false, reason: 'current_session_mismatch', currentId, expectedId };
    }
    if (currentCanonical !== expectedCanonical) {
      return { ok: false, reason: 'current_url_mismatch', currentCanonical, expectedCanonical, currentId, expectedId };
    }
    return { ok: true, currentId, expectedId, currentCanonical, expectedCanonical };
  }


  function normalizedDomToken(value = '') {
    return normalizeComparable(value).replace(/\s+/g, '-');
  }

  function artifactPreviewNameFromId(value = '') {
    const raw = String(value || '');
    const prefix = 'artifact-text-preview-';
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
  }


  function artifactNameParts(value = '') {
    const name = normalizeText(value).split(/[\\/]/).pop() || '';
    const match = name.match(/^(.*)\.([a-z0-9][a-z0-9+_-]{0,15})$/i);
    return {
      name,
      stem: match ? match[1] : name,
      extension: match ? match[2].toLowerCase() : '',
    };
  }

  const ARTIFACT_FORMAT_ALIASES = Object.freeze({
    txt: Object.freeze(['txt', 'text', 'plain text']),
    md: Object.freeze(['md', 'markdown']),
    json: Object.freeze(['json']),
    csv: Object.freeze(['csv', 'comma separated values', 'comma-separated values']),
    tsv: Object.freeze(['tsv', 'tab separated values', 'tab-separated values']),
    zip: Object.freeze(['zip', 'zip archive', 'archive']),
    pdf: Object.freeze(['pdf']),
    xlsx: Object.freeze(['xlsx', 'excel', 'spreadsheet']),
    xls: Object.freeze(['xls', 'excel', 'spreadsheet']),
    docx: Object.freeze(['docx', 'word', 'document']),
    pptx: Object.freeze(['pptx', 'powerpoint', 'presentation']),
    png: Object.freeze(['png', 'image']),
    jpg: Object.freeze(['jpg', 'jpeg', 'image']),
    jpeg: Object.freeze(['jpeg', 'jpg', 'image']),
    gif: Object.freeze(['gif', 'image']),
    mp4: Object.freeze(['mp4', 'video']),
  });

  const MIME_FORMATS = Object.freeze({
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/tab-separated-values': 'tsv',
    'application/json': 'json',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
  });

  function artifactFormatToken({ name = '', extension = '', mime = '' } = {}) {
    const explicit = normalizeComparable(extension).replace(/^\./, '');
    if (explicit) return explicit;
    const fromName = artifactNameParts(name).extension;
    if (fromName) return fromName;
    return MIME_FORMATS[String(mime || '').toLowerCase()] || '';
  }

  function artifactFormatLabelToken(value = '') {
    const normalized = normalizeActionLabel(value);
    if (!normalized) return '';
    for (const [token, aliases] of Object.entries(ARTIFACT_FORMAT_ALIASES)) {
      if (aliases.some((alias) => normalizeActionLabel(alias) === normalized)) return token;
    }
    return /^[a-z0-9][a-z0-9+_-]{0,15}$/.test(normalized) ? normalized : '';
  }

  const ARTIFACT_PREVIEW_ACTION_LABELS = Object.freeze({
    download: Object.freeze([
      'download', 'скачать', 'telecharger', 'herunterladen', 'descargar', 'scarica', 'baixar',
      'downloaden', 'pobierz', 'indir', 'ダウンロード', '다운로드', '下载', '下載',
    ]),
    close: Object.freeze([
      'close', 'закрыть', 'exit full screen', 'exit fullscreen', 'leave full screen',
      'выйти из полноэкранного режима', 'quitter le plein ecran', 'fermer',
      'vollbildmodus verlassen', 'schliessen', 'salir de pantalla completa', 'cerrar',
      'esci da schermo intero', 'chiudi', 'sair da tela cheia', 'fechar',
      'volledig scherm afsluiten', 'sluiten', 'zamknij', '全画面表示を終了', '閉じる',
      '전체 화면 종료', '닫기', '退出全屏', '关闭', '關閉',
    ]),
  });

  function normalizeActionLabel(value = '') {
    return normalizeComparable(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s_-]+/g, ' ')
      .trim();
  }

  function artifactPreviewActionKind({ ariaLabel = '', title = '', testId = '', hasDownloadAttribute = false } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    if (hasDownloadAttribute) return 'download';
    if (normalizedTestId === 'close-button' || /(?:^|[-_])close(?:[-_]|$)/.test(normalizedTestId)) return 'close';
    if (/download/.test(normalizedTestId) && !/upload/.test(normalizedTestId)) return 'download';

    const label = normalizeActionLabel(ariaLabel || title || '');
    if (!label) return '';
    const matches = (items) => items.some((item) => {
      const candidate = normalizeActionLabel(item);
      return label === candidate || label.startsWith(`${candidate} `) || label.endsWith(` ${candidate}`);
    });
    if (matches(ARTIFACT_PREVIEW_ACTION_LABELS.download)) return 'download';
    if (matches(ARTIFACT_PREVIEW_ACTION_LABELS.close)) return 'close';
    return '';
  }

  // ChatGPT currently exposes file-preview actions inconsistently. Prefer
  // stable metadata, but accept a bounded multilingual aria-label fallback for
  // the exact filename-bound preview container. Never search globally by text.
  function planArtifactPreviewDownload({
    desiredName = '',
    desiredExtension = '',
    desiredMime = '',
    dialogLabel = '',
    heading = '',
    fileNameCandidates = [],
    displayTitleCandidates = [],
    formatLabels = [],
    previewIds = [],
    controls = [],
    allowFormatOnly = false,
  } = {}) {
    const desired = normalizeComparable(desiredName);
    if (!desired) return { ok: false, reason: 'missing_desired_name' };

    const desiredParts = artifactNameParts(desiredName);
    const desiredStem = normalizeComparable(desiredParts.stem);
    const expectedFormat = artifactFormatToken({ name: desiredName, extension: desiredExtension, mime: desiredMime });
    const previewNames = Array.from(previewIds || []).map(artifactPreviewNameFromId).filter(Boolean);
    const observedNames = [dialogLabel, heading, ...fileNameCandidates, ...previewNames]
      .map(normalizeComparable)
      .filter(Boolean);
    const rawDisplayTitles = Array.from(displayTitleCandidates || []).map(normalizeText).filter(Boolean);
    const displayTitleComparables = rawDisplayTitles.map(normalizeComparable);
    const observedFormats = Array.from(formatLabels || []).map(artifactFormatLabelToken).filter(Boolean);
    const exactFilename = observedNames.includes(desired);
    const exactDisplayTitle = displayTitleComparables.includes(desired);
    const stemTitleMatched = Boolean(desiredStem && displayTitleComparables.includes(desiredStem));
    const formatMatched = Boolean(expectedFormat && observedFormats.includes(expectedFormat));
    const stemAndFormatMatched = Boolean(stemTitleMatched && formatMatched);
    const formatOnlyMatched = Boolean(allowFormatOnly && expectedFormat && formatMatched && displayTitleComparables.length === 1);
    const identitySource = exactFilename
      ? 'exact_filename'
      : exactDisplayTitle
        ? 'exact_display_title'
        : stemAndFormatMatched
          ? 'display_title_stem_and_format'
          : formatOnlyMatched
            ? 'unique_format_after_exact_action'
            : '';
    if (!identitySource) {
      return {
        ok: false,
        reason: 'preview_filename_mismatch',
        desiredName,
        desiredStem,
        expectedFormat,
        observedNames,
        displayTitles: rawDisplayTitles,
        observedFormats,
        allowFormatOnly: Boolean(allowFormatOnly),
      };
    }

    const normalizedControls = Array.from(controls || []).map((control, index) => {
      const descriptor = {
        index,
        tagName: String(control?.tagName || '').toLowerCase(),
        testId: normalizedDomToken(control?.testId || ''),
        ariaLabel: String(control?.ariaLabel || ''),
        title: String(control?.title || ''),
        hasDownloadAttribute: Boolean(control?.hasDownloadAttribute),
      };
      return { ...descriptor, actionKind: artifactPreviewActionKind(descriptor) };
    });
    const downloads = normalizedControls.filter((control) => control.actionKind === 'download');
    if (downloads.length !== 1) {
      return {
        ok: false,
        reason: downloads.length ? 'ambiguous_download_controls' : 'download_control_not_identified',
        controlCount: normalizedControls.length,
        downloadCount: downloads.length,
      };
    }
    const closes = normalizedControls.filter((control) => control.actionKind === 'close');
    if (closes.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous_close_controls',
        controlCount: normalizedControls.length,
        closeCount: closes.length,
      };
    }

    const download = downloads[0];
    const close = closes[0] || null;
    const stableDownload = download.hasDownloadAttribute
      || /download/.test(download.testId)
      || (download.tagName === 'a' && download.hasDownloadAttribute);
    const source = stableDownload
      ? 'stable_download_metadata'
      : 'localized_download_label';
    const desiredExtensionToken = desiredParts.extension || normalizeComparable(desiredExtension).replace(/^\./, '');
    const downloadNameAliases = desiredExtensionToken
      ? rawDisplayTitles.map((title) => {
          const suffix = `.${desiredExtensionToken}`;
          return normalizeComparable(title).endsWith(suffix) ? title : `${title}${suffix}`;
        })
      : [];
    return {
      ok: true,
      source,
      identitySource,
      downloadControlIndex: download.index,
      closeControlIndex: close?.index ?? null,
      closeSource: close
        ? (close.testId === 'close-button' ? 'stable_close_testid' : 'localized_close_label')
        : '',
      textPreview: previewNames.map(normalizeComparable).includes(desired),
      observedNames,
      displayTitles: rawDisplayTitles,
      displayTitleComparables,
      observedFormats,
      expectedFormat,
      exactFilename,
      exactDisplayTitle,
      stemTitleMatched,
      formatMatched,
      formatOnlyMatched,
      downloadNameAliases,
    };
  }


  function isTextLikeArtifactDescriptor(artifact = {}) {
    const name = String(artifact.name || artifact.fileName || '').toLowerCase();
    const mime = String(artifact.mime || '').toLowerCase();
    if (mime.startsWith('text/')) return true;
    if (/^(?:application\/(?:json|ld\+json|xml|javascript|x-javascript|yaml|x-yaml))$/.test(mime)) return true;
    return /\.(?:txt|md|markdown|json|jsonl|ndjson|csv|tsv|xml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|css|html?|svg|sql|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|ini|toml|conf|log)$/i.test(name);
  }

  function shouldWaitForLateArtifactPreview({ artifact = {}, result = {}, previewObserved = false } = {}) {
    if (previewObserved || !isTextLikeArtifactDescriptor(artifact)) return false;
    return ['page-url', 'dom-url'].includes(String(result.captureSource || ''));
  }

  function artifactPreviewReadiness({
    plan = null,
    downloadControlUsable = false,
    textContentMounted = false,
    loaderVisible = false,
  } = {}) {
    if (!plan?.ok) return { ready: false, reason: plan?.reason || 'preview_plan_not_ready' };
    if (!downloadControlUsable) {
      return { ready: false, reason: loaderVisible ? 'preview_loading' : 'download_control_not_ready' };
    }
    if (plan.textPreview && !textContentMounted) {
      return { ready: false, reason: loaderVisible ? 'preview_loading' : 'text_content_not_ready' };
    }
    return { ready: true, reason: 'ready' };
  }

  function scoreArtifactActionCandidate(artifact = {}, candidate = {}) {
    const desiredName = normalizeComparable(artifact.name || artifact.fileName || '');
    const candidateName = normalizeComparable(candidate.name || candidate.fileName || '');
    const exactName = Boolean(desiredName && candidateName && desiredName === candidateName);

    const exactBlockRange = Boolean(
      artifact.blockStart
      && artifact.blockEnd
      && candidate.blockStart === artifact.blockStart
      && candidate.blockEnd === artifact.blockEnd
    );
    const exactBlockTestId = Boolean(
      artifact.blockTestId
      && candidate.blockTestId
      && candidate.blockTestId === artifact.blockTestId
    );
    const exactActionTestId = Boolean(
      artifact.actionTestId
      && candidate.actionTestId
      && candidate.actionTestId === artifact.actionTestId
    );
    const exactActionAriaLabel = Boolean(
      artifact.actionAriaLabel
      && candidate.actionAriaLabel
      && candidate.actionAriaLabel === artifact.actionAriaLabel
    );
    const exactOrdinal = Number.isInteger(artifact.actionOrdinal)
      && Number.isInteger(candidate.actionOrdinal)
      && candidate.actionOrdinal === artifact.actionOrdinal;
    const exactTag = Boolean(
      artifact.actionTag
      && candidate.actionTag
      && candidate.actionTag === artifact.actionTag
    );

    // A selector hint is never identity. It is frequently a generic CSS path
    // shared by every generated-file button in the same assistant turn.
    const locatorIdentity = (exactBlockRange || exactBlockTestId)
      && (exactOrdinal || exactActionTestId || exactActionAriaLabel);
    const actionIdentityWithoutName = !desiredName && (locatorIdentity || exactActionTestId || exactActionAriaLabel);
    const eligible = exactName || locatorIdentity || actionIdentityWithoutName;

    let score = 0;
    if (exactName) score += 240;
    if (exactBlockRange) score += 120;
    if (exactBlockTestId) score += 90;
    if (exactActionTestId) score += 80;
    if (exactActionAriaLabel) score += 70;
    if (exactOrdinal) score += 30;
    if (exactTag) score += 5;
    if (candidate.selectorMatched) score += 2;

    return {
      eligible,
      score: eligible ? score : -Infinity,
      exactName,
      locatorIdentity,
      desiredName,
      candidateName,
    };
  }

  function selectArtifactActionCandidate(artifact = {}, candidates = []) {
    const ranked = Array.from(candidates || []).map((candidate, index) => ({
      index,
      candidate,
      match: scoreArtifactActionCandidate(artifact, candidate),
    }))
      .filter((entry) => entry.match.eligible && Number.isFinite(entry.match.score))
      .sort((left, right) => right.match.score - left.match.score || left.index - right.index);

    if (!ranked.length) {
      return {
        ok: false,
        reason: 'artifact_action_identity_not_found',
        desiredName: normalizeComparable(artifact.name || artifact.fileName || ''),
      };
    }
    if (ranked.length > 1 && ranked[0].match.score === ranked[1].match.score) {
      return {
        ok: false,
        reason: 'artifact_action_identity_ambiguous',
        score: ranked[0].match.score,
        candidateIndexes: ranked.filter((entry) => entry.match.score === ranked[0].match.score).map((entry) => entry.index),
      };
    }
    return {
      ok: true,
      index: ranked[0].index,
      score: ranked[0].match.score,
      exactName: ranked[0].match.exactName,
      locatorIdentity: ranked[0].match.locatorIdentity,
      candidateName: ranked[0].match.candidateName,
    };
  }

  // Destructive UI automation must not depend on localized visible labels.
  // Only stable DOM metadata is accepted; visible text is retained solely for
  // diagnostics by the caller.
  function isConversationDeleteActionDescriptor({ testId = '', role = '' } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    if (!normalizedTestId) return false;
    if (/(?:^|[-_])(?:all|every|bulk)(?:[-_]|$)|(?:^|[-_])clear(?:[-_]|$)/.test(normalizedTestId)) return false;
    const exact = /^(?:delete-chat-menu-item|delete-conversation-menu-item|chat-delete-menu-item|conversation-delete-menu-item)$/.test(normalizedTestId);
    const semantic = /delete/.test(normalizedTestId)
      && /(?:chat|conversation)/.test(normalizedTestId)
      && /(?:menu|item|action|button)/.test(normalizedTestId);
    if (!exact && !semantic) return false;
    const normalizedRole = normalizedDomToken(role);
    return !normalizedRole || /^(?:menuitem|button)$/.test(normalizedRole);
  }

  function isConversationDeleteConfirmationDescriptor({
    testId = '',
    role = '',
    dataColor = '',
    dataVariant = '',
    dataDestructive = '',
  } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    const normalizedRole = normalizedDomToken(role);
    const semanticTestId = Boolean(normalizedTestId)
      && /(?:confirm.*delete|delete.*confirm)/.test(normalizedTestId)
      && /(?:chat|conversation)/.test(normalizedTestId);
    if (semanticTestId) return !normalizedRole || normalizedRole === 'button';

    // This fallback is safe only when the caller scopes it to the modal that
    // appeared directly after clicking the exact conversation-delete item.
    const destructive = ['danger', 'destructive'].includes(normalizedDomToken(dataColor))
      || ['danger', 'destructive'].includes(normalizedDomToken(dataVariant))
      || normalizedDomToken(dataDestructive) === 'true';
    return destructive && (!normalizedRole || normalizedRole === 'button');
  }

  function menuTriggerOwnsMenu({ triggerId = '', triggerAriaControls = '', menuId = '', menuAriaLabelledby = '' } = {}) {
    const trigger = String(triggerId || '').trim();
    const controls = String(triggerAriaControls || '').trim();
    const menu = String(menuId || '').trim();
    const labelledBy = String(menuAriaLabelledby || '').trim().split(/\s+/).filter(Boolean);
    return Boolean((trigger && labelledBy.includes(trigger)) || (controls && menu && controls === menu));
  }

  function selectLatestNewTurnRecord(records = [], baselineKeys = [], role = 'user') {
    const baseline = baselineKeys instanceof Set ? baselineKeys : new Set(Array.isArray(baselineKeys) ? baselineKeys : []);
    const expectedRole = String(role || '').trim();
    const candidates = (Array.isArray(records) ? records : [])
      .filter((record) => record && record.key && (!expectedRole || record.role === expectedRole) && !baseline.has(record.key));
    return candidates[candidates.length - 1] || null;
  }

  function userTurnMatchesExpectedText(actualText = '', expectedText = '') {
    const actualVisible = normalizeText(actualText);
    const expectedVisible = normalizeText(expectedText);
    const actual = normalizeComparable(actualVisible);
    const expected = normalizeComparable(expectedVisible);
    if (!expected) return true;
    if (!actual) return false;
    if (actual === expected) return true;
    // Attachment chips may be rendered as extra lines before or after the
    // actual prompt. Require a line boundary rather than a loose substring so
    // a short prompt such as "ok" cannot match an unrelated word like "token".
    if (actualVisible.startsWith(`${expectedVisible}
`)
      || actualVisible.endsWith(`
${expectedVisible}`)
      || actualVisible.includes(`
${expectedVisible}
`)) return true;
    return textSimilarity(actual, expected) >= 0.9;
  }

  function selectLatestMatchingNewTurnRecord(records = [], baselineKeys = [], role = 'user', expectedText = '') {
    const baseline = baselineKeys instanceof Set ? baselineKeys : new Set(Array.isArray(baselineKeys) ? baselineKeys : []);
    const expectedRole = String(role || '').trim();
    const candidates = (Array.isArray(records) ? records : [])
      .filter((record) => record && record.key && (!expectedRole || record.role === expectedRole) && !baseline.has(record.key));
    if (!normalizeComparable(expectedText)) return candidates[candidates.length - 1] || null;
    const matching = candidates.filter((record) => userTurnMatchesExpectedText(record.text || '', expectedText));
    return matching[matching.length - 1] || null;
  }

  function selectFirstTurnAfterRecord(records = [], startKey = '', role = 'assistant') {
    const list = Array.isArray(records) ? records : [];
    const startIndex = list.findIndex((record) => record?.key === startKey);
    if (startIndex < 0) return null;
    const expectedRole = String(role || '').trim();
    return list.slice(startIndex + 1).find((record) => record && (!expectedRole || record.role === expectedRole)) || null;
  }

  function comparableTokens(value = '') {
    return normalizeComparable(value)
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .map((token) => token.slice(0, Math.min(7, token.length)));
  }

  function textSimilarity(left = '', right = '') {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      const shorter = Math.min(a.length, b.length);
      const longer = Math.max(a.length, b.length);
      return Math.max(0.72, shorter / Math.max(1, longer));
    }
    const aTokens = new Set(comparableTokens(a));
    const bTokens = new Set(comparableTokens(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let intersection = 0;
    for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
    return intersection / Math.max(aTokens.size, bTokens.size);
  }

  function normalizedThinkingState(candidate = {}) {
    if (candidate.state === 'completed' || candidate.state === 'removed') return candidate.state;
    return candidate.active ? 'active' : 'completed';
  }

  function thinkingRecordPublic(record = {}) {
    return {
      id: record.id,
      key: record.id,
      sequence: record.sequence,
      kind: record.kind,
      state: record.state,
      text: record.text,
      revision: record.revision,
      active: record.state === 'active',
      visible: Boolean(record.visible),
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      structuralHint: record.structuralHint || '',
      source: record.source || '',
      testIds: Array.isArray(record.testIds) ? record.testIds : [],
    };
  }

  /**
   * Reconcile React DOM snapshots into logical thinking/progress records.
   *
   * The same logical block may be rerendered into a different DOM node or move
   * from an active shimmer label to a completed cot-v5 button. Conversely, a
   * transition slot may be reused for a genuinely new step. This helper keeps
   * stable IDs across the first case and allocates a new ID for the second.
   */
  function reconcileThinkingBlocks(previousState = {}, candidates = [], options = {}) {
    const now = Number(options.now || Date.now());
    const turnId = String(options.turnId || previousState.turnId || 'turn');
    const scan = Number(previousState.scan || 0) + 1;
    let nextSequence = Math.max(1, Number(previousState.nextSequence || 1));
    const records = (Array.isArray(previousState.records) ? previousState.records : []).map((record) => ({ ...record, visible: false }));
    const assigned = new Set();
    const events = [];

    const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
      .map((candidate, index) => ({
        ...candidate,
        index: Number.isFinite(candidate.index) ? candidate.index : index,
        text: normalizeText(candidate.text || ''),
        kind: String(candidate.kind || 'thinking'),
        state: normalizedThinkingState(candidate),
        structuralHint: String(candidate.structuralHint || ''),
        nodeToken: String(candidate.nodeToken || ''),
      }))
      .filter((candidate) => candidate.text);

    const findMatch = (candidate) => {
      const available = records.filter((record) => !assigned.has(record.id) && record.state !== 'removed');
      if (candidate.nodeToken) {
        const sameNode = available.find((record) => record.nodeToken && record.nodeToken === candidate.nodeToken);
        if (sameNode) return sameNode;
      }

      if (candidate.structuralHint) {
        const sameSlot = available
          .filter((record) => record.structuralHint === candidate.structuralHint && record.kind === candidate.kind)
          .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
        for (const record of sameSlot) {
          const similarity = textSimilarity(record.text, candidate.text);
          if (record.state === 'active' && candidate.state === 'completed') return record;
          if (record.state === 'active' && candidate.state === 'active' && similarity >= 0.34) return record;
          if (record.state === 'completed' && candidate.state === 'completed' && similarity >= 0.82) return record;
          if (record.state === 'completed' && candidate.state === 'active' && similarity >= 0.92) return record;
        }
      }

      const exact = available.find((record) => record.kind === candidate.kind && normalizeComparable(record.text) === normalizeComparable(candidate.text));
      if (exact) return exact;

      const similarActive = available
        .filter((record) => record.kind === candidate.kind && record.state === 'active')
        .map((record) => ({ record, score: textSimilarity(record.text, candidate.text) }))
        .sort((a, b) => b.score - a.score)[0];
      return similarActive?.score >= 0.58 ? similarActive.record : null;
    };

    for (const candidate of normalizedCandidates) {
      let record = findMatch(candidate);
      if (!record) {
        const sequence = nextSequence++;
        record = {
          id: `thinking-${turnId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-18) || 'turn'}-${sequence}`,
          sequence,
          kind: candidate.kind,
          state: candidate.state,
          text: candidate.text,
          revision: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenScan: scan,
          misses: 0,
          visible: true,
          structuralHint: candidate.structuralHint,
          nodeToken: candidate.nodeToken,
          source: candidate.source || '',
          testIds: candidate.testIds || [],
        };
        records.push(record);
        events.push({ type: 'started', item: thinkingRecordPublic(record) });
      } else {
        assigned.add(record.id);
        const changed = record.text !== candidate.text
          || record.state !== candidate.state
          || record.kind !== candidate.kind
          || record.structuralHint !== candidate.structuralHint;
        record.kind = candidate.kind;
        record.state = candidate.state;
        record.text = candidate.text;
        record.structuralHint = candidate.structuralHint || record.structuralHint;
        record.nodeToken = candidate.nodeToken || record.nodeToken;
        record.source = candidate.source || record.source;
        record.testIds = candidate.testIds || record.testIds;
        record.lastSeenAt = now;
        record.lastSeenScan = scan;
        record.misses = 0;
        record.visible = true;
        if (changed) {
          record.revision = Number(record.revision || 1) + 1;
          events.push({ type: record.state === 'completed' ? 'completed' : 'updated', item: thinkingRecordPublic(record) });
        }
      }
      assigned.add(record.id);
    }

    for (const record of records) {
      if (record.lastSeenScan === scan || record.state === 'removed') continue;
      record.misses = Number(record.misses || 0) + 1;
      const shouldComplete = record.state === 'active' && (Boolean(options.finalSeen) || record.misses >= 2);
      if (shouldComplete) {
        record.state = 'completed';
        record.revision = Number(record.revision || 1) + 1;
        record.lastSeenAt = now;
        events.push({ type: 'completed', item: thinkingRecordPublic(record), reason: options.finalSeen ? 'final_seen' : 'disappeared' });
      }
    }

    const retained = records
      .filter((record) => record.state !== 'removed')
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-80);
    return {
      state: { turnId, scan, nextSequence, records: retained },
      items: retained.map(thinkingRecordPublic),
      events,
    };
  }


  const FILE_EXTENSION_SOURCE = '(?:zip|txt|csv|json|js|mjs|cjs|ts|tsx|jsx|md|pdf|png|jpe?g|webp|gif|svg|html?|css|xml|ya?ml|toml|ini|log|py|sh|bash|zsh|sql|tar|gz|tgz|7z|rar|docx|xlsx|pptx|odt|ods|odp|mp3|wav|mp4|mov|webm)';
  const FILE_NAME_PATTERN = new RegExp(`(?:^|[\\s(\"'\`])([^\\s\\/\\\\:*?\"<>|()]{1,180}\\.${FILE_EXTENSION_SOURCE})(?:$|[\\s),.;:\"'\`])`, 'i');
  const FILE_NAME_PATTERN_GLOBAL = new RegExp(`(?:^|[\\s("'\`])([^\\s\\/\\\\:*?"<>|()]{1,180}\\.${FILE_EXTENSION_SOURCE})(?=$|[\\s),.;:"'\`])`, 'ig');
  const WHOLE_FILE_LABEL_PATTERN = new RegExp(`^[^\\n\\r\\/\\\\:*?\"<>|]{1,180}\\.${FILE_EXTENSION_SOURCE}$`, 'i');

  function extractFileLikeNames(value = '') {
    const text = normalizeText(value);
    if (!text) return [];
    const withoutAction = text
      .replace(/^(?:(?:click|tap|нажмите)\s+(?:to\s+)?|(?:download|save|open|скачать|сохранить|открыть)\s*[:—-]?\s*)+/i, '')
      .trim();
    const extensionHits = withoutAction.match(new RegExp(`\\.${FILE_EXTENSION_SOURCE}(?=$|[\\s),.;:"'\`])`, 'ig')) || [];
    if (WHOLE_FILE_LABEL_PATTERN.test(withoutAction) && extensionHits.length === 1) return [withoutAction];

    const result = [];
    FILE_NAME_PATTERN_GLOBAL.lastIndex = 0;
    let match;
    while ((match = FILE_NAME_PATTERN_GLOBAL.exec(text))) {
      const name = match[1] || '';
      if (name && !result.includes(name)) result.push(name);
      if (match[0] === '') FILE_NAME_PATTERN_GLOBAL.lastIndex += 1;
    }
    return result;
  }

  function extractFileLikeName(value = '') {
    return extractFileLikeNames(value)[0] || '';
  }

  function classifyArtifactPhase(signals = {}) {
    const state = normalizeComparable(`${signals.state || ''} ${signals.text || ''}`);
    if (signals.failed || /(?:^|\b)(?:failed|error|rejected|could not|не удалось|ошибк|отклон)/i.test(state)) return 'FAILED';
    if (signals.busy || signals.progressVisible || signals.disabled || /(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|созда|готовит|обрабаты|загруж)/i.test(state)) return 'GENERATING';
    if (signals.downloadable || signals.downloadActionPresent || signals.href) return 'READY';
    return 'GENERATING';
  }

  function isArtifactLifecycleStateDescriptor(signals = {}) {
    const ariaBusy = String(signals.ariaBusy || '').toLowerCase() === 'true';
    const role = normalizeComparable(signals.role || '');
    if (ariaBusy || role === 'progressbar') return true;
    const attributes = normalizeComparable([
      signals.dataState,
      signals.testId,
      signals.className,
    ].filter(Boolean).join(' '));
    if (/(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|failed|error|rejected|spinner|animate-spin|progress|созда|готовит|обрабаты|загруж|ошибк|отклон)(?:\b|$)/i.test(attributes)) return true;
    const tagName = normalizeComparable(signals.tagName || '');
    if (tagName === 'button' || tagName === 'a') return false;
    const ownText = normalizeComparable(signals.ownText || '');
    return /(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|failed|error|rejected|созда|готовит|обрабаты|загруж|ошибк|отклон)(?:\b|$)/i.test(ownText);
  }

  function artifactBlocksCompletion(artifact = {}) {
    const phase = String(artifact?.phase || 'READY').toUpperCase();
    if (phase === 'READY' || phase === 'FAILED') return false;
    const materializable = Boolean(
      artifact?.downloadActionPresent
      || artifact?.downloadable
      || artifact?.url
      || artifact?.downloadUrl
      || artifact?.src
    );
    if (artifact?.lifecycleObserved === false && !materializable) return false;
    return true;
  }

  function allArtifactsReady(artifacts = []) {
    return !(Array.isArray(artifacts) ? artifacts : []).some(artifactBlocksCompletion);
  }

  function classifyTurnPhase(signals = {}) {
    const role = String(signals.role || '').toLowerCase();
    if (role === 'user') return PHASE.USER;
    if (signals.hasError) return PHASE.ERROR;
    if (signals.needsConfirmation) return PHASE.NEEDS_CONFIRMATION;
    if (signals.needsContinue) return PHASE.NEEDS_CONTINUE;

    if (signals.hasActiveTool && signals.stopVisible) return PHASE.TOOL_RUNNING;
    if (signals.hasFinalNode && signals.stopVisible) {
      return signals.hasPriorVisibleBlocks
        ? PHASE.ASSISTANT_FINAL_STREAMING_WITH_HISTORY
        : PHASE.ASSISTANT_FINAL_STREAMING;
    }
    if (signals.hasFinalNode && !signals.stopVisible && signals.actionBarVisible && !signals.hasActiveTool) {
      return PHASE.ASSISTANT_FINAL;
    }
    if (!signals.hasFinalNode && signals.stopVisible && (signals.hasReasoningMarker || signals.hasVisibleStatusText)) {
      return PHASE.ASSISTANT_REASONING;
    }
    return PHASE.ASSISTANT_PLACEHOLDER;
  }

  function classifyVisibleBlock(block = {}) {
    const text = normalizeText(block.text || '');
    const testIds = Array.isArray(block.testIds) ? block.testIds : [];
    const signal = `${testIds.join(' ')} ${block.role || ''} ${block.state || ''} ${block.ariaBusy || ''} ${text}`;
    if (block.final) return 'final';
    if (/\bcot-v5-|thinking|reasoning|thought|размыш|дума/i.test(signal)) return 'reasoning-summary';
    if (block.hasCode || /stdout|stderr|python|terminal|tool|analysis tool|инструмент/i.test(signal)) return 'tool';
    if (/status|aria-live|progress|loading|working|processing|выполня|обрабаты/i.test(signal)) return 'status';
    return 'unknown';
  }

  function groupVisibleBlocks(blocks = []) {
    const normalized = blocks
      .map((block, index) => ({ ...block, index: block.index ?? index, text: normalizeText(block.text || '') }))
      .filter((block) => block.final || block.text);
    const result = [];

    for (let index = 0; index < normalized.length; index += 1) {
      const current = normalized[index];
      const next = normalized[index + 1];
      const currentKind = current.kind || classifyVisibleBlock(current);
      const nextKind = next ? (next.kind || classifyVisibleBlock(next)) : '';
      const shortStatusLabel = !current.final
        && current.text.length > 0
        && current.text.length <= 80
        && /^(?:проанализировано|анализ|готово|выполняется|running|worked|analyzed|analysis|thinking|думал|размышлял)(?:\s|$)/i.test(current.text);

      if (shortStatusLabel && next && !next.final && (nextKind === 'tool' || next.hasCode)) {
        result.push({
          ...next,
          index: current.index,
          kind: 'tool',
          text: normalizeText(`${current.text}\n${next.text}`),
          label: current.text,
          groupedIndexes: [current.index, next.index],
        });
        index += 1;
        continue;
      }

      result.push({ ...current, kind: currentKind });
    }
    return result;
  }

  function buildSnapshotSignature(snapshot = {}) {
    const blocks = Array.isArray(snapshot.visibleBlocks)
      ? snapshot.visibleBlocks.map((block) => [
          block.kind || '',
          normalizeComparable(block.text || ''),
          Array.isArray(block.testIds) ? [...block.testIds].sort() : [],
          block.state || '',
          block.expanded ?? null,
          Boolean(block.active),
        ])
      : [];
    return JSON.stringify({
      phase: snapshot.phase || '',
      turnId: snapshot.turnKey || snapshot.turnId || '',
      messageId: snapshot.messageId || '',
      modelSlug: snapshot.modelSlug || '',
      conversationId: snapshot.conversationId || '',
      answer: normalizeComparable(snapshot.answer || ''),
      stopVisible: Boolean(snapshot.stopVisible),
      sendVisible: Boolean(snapshot.sendVisible),
      actionBarVisible: Boolean(snapshot.actionBarVisible),
      needsConfirmation: Boolean(snapshot.needsConfirmation),
      needsContinue: Boolean(snapshot.needsContinue),
      hasError: Boolean(snapshot.hasError),
      artifacts: Array.isArray(snapshot.artifacts)
        ? snapshot.artifacts.map((item) => [item.id || '', item.name || '', item.url || item.downloadUrl || '', item.phase || '', Boolean(item.downloadable), item.state || ''])
        : [],
      responseBlocks: Array.isArray(snapshot.responseBlocks)
        ? snapshot.responseBlocks.map((block) => [block.type || '', block.language || '', normalizeComparable(block.markdown || block.text || block.code || '')])
        : [],
      parserAudit: snapshot.parserAudit?.coverage ? [
        Number(snapshot.parserAudit.coverage.visibleTextLeaves || 0),
        Number(snapshot.parserAudit.coverage.unknownLeaves || 0),
        Number(snapshot.parserAudit.coverage.unknownVisualElements || 0),
        Number(snapshot.parserAudit.coverage.duplicateLeaves || 0),
        Number(snapshot.parserAudit.coverage.coveragePercent || 0),
      ] : [],
      blocks,
    });
  }

  function isTerminalResponseSnapshot(snapshot = {}, expectedConversationId = '') {
    if (!snapshot.hasFinalMessage) return false;
    if (snapshot.stopVisible || !snapshot.actionBarVisible) return false;
    if (snapshot.hasActiveTool || snapshot.needsConfirmation || snapshot.needsContinue || snapshot.hasError) return false;
    if (expectedConversationId && snapshot.conversationId && snapshot.conversationId !== expectedConversationId) return false;
    return snapshot.phase === PHASE.ASSISTANT_FINAL;
  }

  function isCompletedSnapshot(snapshot = {}, expectedConversationId = '') {
    return isTerminalResponseSnapshot(snapshot, expectedConversationId)
      && allArtifactsReady(snapshot.artifacts);
  }

  globalThis.ChatGptDomParserCore = Object.freeze({
    PHASE,
    normalizeText,
    normalizeComparable,
    canonicalEffortId,
    normalizeIntelligenceOptions,
    intelligenceOptionMatches,
    resolveCurrentModel,
    normalizeCodeLanguageLabel,
    isKnownCodeLanguageLabel,
    codeLanguageLabelsFromText,
    classifyCodeWidgetChromeText,
    summarizeParserLeafOwnership,
    rankCodeLanguageCandidates,
    selectCodeLanguageCandidate,
    isAssistantAuthorLabel,
    conversationIdFromUrl,
    canonicalConversationUrl,
    verifySessionDeletionTarget,
    artifactPreviewNameFromId,
    artifactNameParts,
    artifactFormatToken,
    artifactFormatLabelToken,
    artifactPreviewActionKind,
    planArtifactPreviewDownload,
    isTextLikeArtifactDescriptor,
    shouldWaitForLateArtifactPreview,
    artifactPreviewReadiness,
    scoreArtifactActionCandidate,
    selectArtifactActionCandidate,
    isConversationDeleteActionDescriptor,
    isConversationDeleteConfirmationDescriptor,
    menuTriggerOwnsMenu,
    selectLatestNewTurnRecord,
    userTurnMatchesExpectedText,
    selectLatestMatchingNewTurnRecord,
    selectFirstTurnAfterRecord,
    textSimilarity,
    reconcileThinkingBlocks,
    extractFileLikeName,
    extractFileLikeNames,
    classifyArtifactPhase,
    isArtifactLifecycleStateDescriptor,
    artifactBlocksCompletion,
    allArtifactsReady,
    classifyTurnPhase,
    classifyVisibleBlock,
    groupVisibleBlocks,
    buildSnapshotSignature,
    isTerminalResponseSnapshot,
    isCompletedSnapshot,
  });
})();
