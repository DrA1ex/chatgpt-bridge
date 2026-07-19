// Pure, DOM-independent state helpers for the ChatGPT content-script parser.
// Loaded before content.js and exposed as a global because MV3 content scripts
// listed in manifest.json are classic scripts, not ES modules.
(() => {
  'use strict';

  const ARTIFACT_CORE = globalThis.ChatGptArtifactParserCore;
  if (!ARTIFACT_CORE) throw new Error('ChatGptArtifactParserCore must be loaded before domParserCore.js');
  const {
    normalizedDomToken,
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
    extractFileLikeName,
    extractFileLikeNames,
    classifyArtifactPhase,
    isArtifactLifecycleStateDescriptor,
    artifactBlocksCompletion,
    allArtifactsReady,
  } = ARTIFACT_CORE;

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

  function stripTrailingNestedProgressLabels(value = '', labels = []) {
    let output = normalizeText(value);
    const candidates = Array.from(new Set((Array.isArray(labels) ? labels : [])
      .map((label) => normalizeText(label))
      .filter(Boolean)))
      .sort((left, right) => right.length - left.length);

    let changed = true;
    while (output && changed) {
      changed = false;
      for (const label of candidates) {
        const escaped = label
          .split(/\s+/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        const suffix = new RegExp(`(?:^|\\s+)${escaped}\\s*$`, 'iu');
        if (!suffix.test(output)) continue;
        output = normalizeText(output.replace(suffix, ''));
        changed = true;
        break;
      }
    }
    return output;
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

  function selectLatestTurnAfterRecord(records = [], startKey = '', role = 'assistant') {
    const list = Array.isArray(records) ? records : [];
    const startIndex = list.findIndex((record) => record?.key === startKey);
    if (startIndex < 0) return null;
    const expectedRole = String(role || '').trim();
    return list.slice(startIndex + 1).filter((record) => record && (!expectedRole || record.role === expectedRole)).at(-1) || null;
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
        const sameNode = available.find((record) => record.kind === candidate.kind && record.nodeToken && record.nodeToken === candidate.nodeToken);
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
          || record.structuralHint !== candidate.structuralHint;
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


  function classifyTurnPhase(signals = {}) {
    const role = String(signals.role || '').toLowerCase();
    if (role === 'user') return PHASE.USER;
    if (signals.hasError) return PHASE.ERROR;
    if (signals.needsConfirmation) return PHASE.NEEDS_CONFIRMATION;
    if (signals.needsContinue) return PHASE.NEEDS_CONTINUE;

    if (signals.hasActiveTool && (signals.stopVisible || signals.streamingVisible)) return PHASE.TOOL_RUNNING;
    if (signals.hasFinalNode && (signals.stopVisible || signals.streamingVisible)) {
      return signals.hasPriorVisibleBlocks
        ? PHASE.ASSISTANT_FINAL_STREAMING_WITH_HISTORY
        : PHASE.ASSISTANT_FINAL_STREAMING;
    }
    if (signals.hasFinalNode && !signals.stopVisible && !signals.streamingVisible && !signals.hasActiveTool) {
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
      streamingVisible: Boolean(snapshot.streamingVisible),
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
    const hasArtifact = Array.isArray(snapshot.artifacts) && snapshot.artifacts.length > 0;
    if (!snapshot.hasFinalMessage && !hasArtifact) return false;
    if (snapshot.stopVisible || snapshot.streamingVisible) return false;
    if (snapshot.hasActiveTool || snapshot.needsConfirmation || snapshot.needsContinue || snapshot.hasError) return false;
    if (expectedConversationId && snapshot.conversationId && snapshot.conversationId !== expectedConversationId) return false;
    return hasArtifact || snapshot.phase === PHASE.ASSISTANT_FINAL;
  }

  function isCompletedSnapshot(snapshot = {}, expectedConversationId = '') {
    return isTerminalResponseSnapshot(snapshot, expectedConversationId)
      && allArtifactsReady(snapshot.artifacts);
  }

  globalThis.ChatGptDomParserCore = Object.freeze({
    PHASE,
    normalizeText,
    normalizeComparable,
    stripTrailingNestedProgressLabels,
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
    selectLatestTurnAfterRecord,
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
