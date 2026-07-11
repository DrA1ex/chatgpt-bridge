# Спецификация DOM-парсера ChatGPT

Статус: результаты живого исследования авторизованного интерфейса ChatGPT в Chrome, 11 июля 2026 года.

## 1. Назначение и границы

Документ описывает парсинг видимого состояния веб-интерфейса ChatGPT:

- доступные модели и выбранная модель;
- режим/усилие размышления;
- редактор и отправка запроса;
- пользовательские и ассистентские сообщения;
- потоковая генерация;
- временные видимые reasoning-отбивки;
- финальный ответ, ошибки и критерии завершения.

Парсер не может получить скрытую цепочку рассуждений модели. Он может сохранять только содержимое, реально отрисованное в DOM: reasoning summary, статусы инструментов, промежуточные подписи и финальный ответ.

Разметка ChatGPT не является публичным API. Все селекторы должны быть версионированы, иметь fallback и проверяться через семантические инварианты.

## 2. Наблюдавшаяся структура разговора

Turn-контейнер:

```html
<section
  data-testid="conversation-turn-14"
  data-turn="assistant"
  data-turn-id="request-..."
  data-turn-id-container="request-..."
>
  ...
</section>
```

Финальное сообщение:

```html
<div
  data-message-author-role="assistant"
  data-message-id="ef6583b3-..."
  data-message-model-slug="gpt-5-6-thinking"
>
  ...финальный Markdown/HTML...
</div>
```

Сообщение пользователя имеет ту же общую схему с `data-turn="user"` и `data-message-author-role="user"`.

### Приоритет идентификаторов

1. `data-turn-id` — логический turn.
2. `data-message-id` — конкретное сообщение внутри turn.
3. `data-testid="conversation-turn-N"` — удобный контейнер, но `N` не следует сохранять как постоянный ID.
4. Индекс DOM — только временный fallback одного снимка.

## 3. Карта селекторов

| Сущность | Основной селектор | Fallback |
|---|---|---|
| Редактор | `#prompt-textarea[contenteditable="true"]` | `[role="textbox"][aria-label]` внутри composer-form |
| Fallback textarea | `textarea[name="prompt-textarea"]` | `textarea[aria-label]` внутри composer-form |
| Отправка | `[data-testid="send-button"]` | кнопка composer с локализованным `aria-label` отправки |
| Остановка | `[data-testid="stop-button"]` | кнопка composer с локализованным `aria-label` остановки |
| Вложения | `[data-testid="composer-plus-btn"]` | `#composer-plus-btn` |
| Turns | `[data-testid^="conversation-turn-"][data-turn]` | `main section[data-turn]` |
| User turn | `[data-turn="user"]` | контейнер с `[data-message-author-role="user"]` |
| Assistant turn | `[data-turn="assistant"]` | контейнер с `[data-message-author-role="assistant"]` или временным reasoning-блоком |
| Финальный текст | `[data-message-author-role="assistant"]` | содержательный узел assistant-turn после reasoning-фазы |
| Действия готового ответа | `[data-testid="copy-turn-action-button"]` внутри последнего assistant-turn | группа `[role="group"][aria-label]` действий ответа |
| Reasoning-маркер | `[data-testid^="cot-v5-"]` внутри последнего assistant-turn | assistant-turn без `[data-message-author-role="assistant"]`, но с видимым текстом |
| Citation | `[data-testid="webpage-citation-pill"]` | ссылка внутри assistant message |

Не использовать как контракт:

- классы Tailwind и сгенерированные CSS-классы;
- ID `radix-_r_*`;
- `nth-child` и абсолютный путь DOM;
- точный локализованный текст без структурного scope;
- число из `conversation-turn-N` как ID сообщения.

## 4. Модели и усилие размышления

В исследованной сессии picker открывался кнопкой composer с текущим значением `Высокий`. После открытия присутствовал:

```css
[data-testid="composer-intelligence-picker-content"]
```

Основное меню содержало `role="menuitemradio"`:

- `Instant 5.5`, `aria-checked="false"`;
- `Средний`, `aria-checked="false"`;
- `Высокий`, `aria-checked="true"`.

Пункт с `data-has-submenu` открывал список моделей. Во вложенном меню наблюдались:

- GPT-5.6 Sol — выбран;
- GPT-5.5;
- GPT-5.4 — дополнительная подпись «Доступна до 23 июля»;
- GPT-5.3;
- o3.

Список зависит от тарифа, rollout, региона и времени. Его нужно читать из открытого меню, а не держать статически.

### Алгоритм чтения picker

1. Найти composer-form.
2. Найти кнопку, которая раскрывает `[data-testid="composer-intelligence-picker-content"]`.
3. Открыть picker и дождаться группы.
4. В первом меню собрать `menuitemradio` до separator как режимы интеллекта.
5. Найти `menuitem[data-has-submenu]` и открыть submenu.
6. Во вложенном menu собрать `menuitemradio` как модели.
7. Выбранное значение определяется `aria-checked="true"` и/или `data-state="checked"`.
8. Сохранять `rawText` целиком, но отделять основное имя от вторичной подписи.
9. Закрыть меню через Escape, не меняя выбор.

Рекомендуемая структура:

```ts
interface IntelligenceState {
  selectedEffort: string | null;
  efforts: Array<{ label: string; checked: boolean }>;
  selectedModel: string | null;
  models: Array<{
    label: string;
    rawText: string;
    checked: boolean;
    annotation?: string;
  }>;
  capturedAt: number;
}
```

Не выводить выбранную модель только из текста кнопки composer: в reasoning-режиме кнопка показывала `Высокий`, а выбранная модель находилась во вложенном меню. После ответа фактический slug можно дополнительно прочитать из `data-message-model-slug` финального сообщения. Наблюдавшееся значение: `gpt-5-6-thinking`.

## 5. Жизненный цикл длительного запроса

Тест выполнялся с GPT-5.6 Sol и усилием `Высокий`.

Наблюдавшаяся временная шкала:

```text
0.0 с   создан новый assistant-turn; stop-button присутствует
0–34 с  turn содержит видимую reasoning-отбивку
        «Разработал стратегию взвешивания»
        внутри присутствуют testid:
        cot-v5-tool-icon-pile
        cot-v5-native-tool-icon
~34 с   внутреннее содержимое того же turn заменено;
        появился [data-message-author-role="assistant"]
34–45 с финальный текст потоково растёт
~45 с   stop-button исчез;
        появились действия ответа;
        итоговый текст — 6344 символа
```

Критическое наблюдение: reasoning summary и final использовали один и тот же `conversation-turn-14`. Reasoning-блок исчез из конечного DOM. Парсер, который читает DOM только после завершения, потеряет эту отбивку.

## 6. Классификация состояния последнего turn

```ts
type TurnPhase =
  | 'USER'
  | 'ASSISTANT_PLACEHOLDER'
  | 'ASSISTANT_REASONING'
  | 'ASSISTANT_FINAL_STREAMING'
  | 'ASSISTANT_FINAL'
  | 'TOOL_RUNNING'
  | 'NEEDS_CONFIRMATION'
  | 'ERROR';
```

Правила:

```text
data-turn=user
  => USER

data-turn=assistant + stop visible + нет final-author-node + пустой текст
  => ASSISTANT_PLACEHOLDER

data-turn=assistant + stop visible + нет final-author-node
+ есть cot-v5-* или иной status/tool/reasoning UI
  => ASSISTANT_REASONING

data-turn=assistant + есть [data-message-author-role=assistant]
+ stop visible
  => ASSISTANT_FINAL_STREAMING

data-turn=assistant + есть final-author-node
+ stop отсутствует + действия ответа присутствуют + DOM стабилен
  => ASSISTANT_FINAL
```

Наличие `data-message-model-slug` с `thinking` не означает, что текущий текст является reasoning. Это метаданные модели финального сообщения.

## 7. Событийная модель вместо одного снимка

Хранить append-only события:

```ts
interface ChatDomEvent {
  at: number;
  conversationUrl: string;
  turnId: string | null;
  messageId: string | null;
  phase: TurnPhase;
  text: string;
  html?: string;
  signature: string;
  stopVisible: boolean;
  sendVisible: boolean;
  actionBarVisible: boolean;
  visibleBlocks: VisibleBlock[];
}

interface VisibleBlock {
  kind: 'reasoning-summary' | 'tool' | 'status' | 'final' | 'citation' | 'code' | 'unknown';
  key: string;
  text: string;
  html?: string;
  testIds: string[];
  state?: string | null;
  expanded?: boolean | null;
}
```

Событие добавляется только при изменении сигнатуры. Сигнатура должна включать phase, нормализованный текст, значимые `data-testid`, `data-state`, `aria-expanded`, наличие Stop и action bar. Анимационные class/style в сигнатуру не включать.

## 8. Наблюдение за DOM

`MutationObserver` следует ставить на `main` или найденный контейнер разговора, не на весь `document.body`.

```js
function startChatObserver(onSnapshot) {
  const root = document.querySelector('main');
  if (!root) throw new Error('Chat main container not found');

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      onSnapshot(readChatState());
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'data-testid',
      'data-turn',
      'data-turn-id',
      'data-message-id',
      'data-message-author-role',
      'data-message-model-slug',
      'data-state',
      'aria-expanded',
      'aria-checked',
      'aria-busy',
      'disabled',
    ],
  });

  schedule();
  return () => observer.disconnect();
}
```

Observer сообщает лишь «что-то изменилось». Полное нормализованное состояние следует перечитывать одной функцией `readChatState()`, иначе React replacement приведёт к работе со stale node.

## 9. Референсная функция чтения

```js
function readChatState() {
  const normalize = (s = '') => s.replace(/\s+/g, ' ').trim();
  const turns = [...document.querySelectorAll(
    '[data-testid^="conversation-turn-"][data-turn]'
  )];
  const last = turns.at(-1) || null;
  const finalNode = last?.querySelector(
    '[data-message-author-role="assistant"]'
  ) || null;
  const stopVisible = Boolean(document.querySelector(
    '[data-testid="stop-button"]'
  ));
  const actionBarVisible = Boolean(last?.querySelector(
    '[data-testid="copy-turn-action-button"]'
  ));
  const cotIds = last
    ? [...last.querySelectorAll('[data-testid^="cot-v5-"]')]
        .map(x => x.getAttribute('data-testid'))
    : [];

  let phase = 'ASSISTANT_PLACEHOLDER';
  if (last?.getAttribute('data-turn') === 'user') phase = 'USER';
  else if (finalNode && stopVisible) phase = 'ASSISTANT_FINAL_STREAMING';
  else if (finalNode && !stopVisible && actionBarVisible) phase = 'ASSISTANT_FINAL';
  else if (!finalNode && (cotIds.length || normalize(last?.innerText))) {
    phase = 'ASSISTANT_REASONING';
  }

  return {
    url: location.href,
    turnCount: turns.length,
    last: last && {
      turnId: last.getAttribute('data-turn-id'),
      turnTestId: last.getAttribute('data-testid'),
      role: last.getAttribute('data-turn'),
      phase,
      stopVisible,
      actionBarVisible,
      text: normalize((finalNode || last).innerText),
      messageId: finalNode?.getAttribute('data-message-id') || null,
      modelSlug: finalNode?.getAttribute('data-message-model-slug') || null,
      cotTestIds: cotIds,
    },
  };
}
```

В production нужно расширить классификаторы инструментов, подтверждений, Continue и ошибок на основании отдельных тестовых сценариев.

## 10. Отправка

```js
async function submitPrompt(page, prompt) {
  const editor = page.locator('#prompt-textarea[contenteditable="true"]');
  if (await editor.count() !== 1) {
    throw new Error('Composer editor is missing or ambiguous');
  }

  const before = await page.locator('[data-turn="assistant"]').count();
  await editor.fill(prompt);

  const send = page.locator('[data-testid="send-button"]');
  if (await send.count() === 1) await send.click();
  else await editor.press('Enter');

  return { previousAssistantCount: before };
}
```

Не считать отсутствие `send-button` после ответа ошибкой: при пустом composer интерфейс заменяет кнопку отправки кнопкой голосового режима.

## 11. Критерии завершения

Составной критерий `COMPLETED`:

1. После отправки появился новый assistant-turn.
2. В нём появился `[data-message-author-role="assistant"]`.
3. `stop-button` отсутствует.
4. Внутри turn присутствует action bar / `copy-turn-action-button`.
5. Нормализованные text + значимая структура стабильны не менее 1500 мс.
6. Нет активного tool/status-блока.
7. Нет Continue, ошибки или запроса подтверждения.
8. URL всё ещё соответствует ожидаемому conversation ID.

Промежуточное состояние `QUIET` не является завершением: reasoning summary в тесте не менялся десятки секунд, но Stop оставался активен.

Рекомендуемые терминальные состояния:

```text
COMPLETED
FAILED
INTERRUPTED
NEEDS_CONFIRMATION
NEEDS_CONTINUE
RATE_LIMITED
AUTH_REQUIRED
CONVERSATION_CHANGED
TIMEOUT_WITH_PARTIAL_STATE
```

## 12. Полное состояние парсера

```ts
interface ChatState {
  capturedAt: number;
  url: string;
  conversationId: string | null;
  intelligence: IntelligenceState | null;
  composer: {
    present: boolean;
    text: string;
    sendVisible: boolean;
    stopVisible: boolean;
    attachments: unknown[];
  };
  turns: ParsedTurn[];
  activeTurnId: string | null;
  lifecycle: string;
  errors: ParsedUiError[];
  confirmation: unknown | null;
}

interface ParsedTurn {
  turnId: string | null;
  messageId: string | null;
  author: 'user' | 'assistant' | 'unknown';
  phase: TurnPhase;
  modelSlug: string | null;
  text: string;
  html: string;
  reasoningHistory: VisibleBlock[];
  currentVisibleBlocks: VisibleBlock[];
  citations: unknown[];
  codeBlocks: unknown[];
  completed: boolean;
}
```

`reasoningHistory` заполняется из событийного журнала. Его нельзя реконструировать из конечного DOM.

## 13. Защита от изменений верстки

Каждый запуск должен выполнять self-check:

- composer найден ровно один раз;
- у turns есть `data-turn` или распознаваемый author-node;
- после тестовой отправки появляется новый turn;
- Stop наблюдается хотя бы один раз для достаточно длинного запроса;
- финальный author-node и action bar появляются после завершения;
- неизвестные `data-testid` внутри активного turn логируются как telemetry, а не игнорируются;
- если основной селектор пропал, parser сообщает `DOM_SCHEMA_CHANGED`, а не возвращает ложный `COMPLETED`.

Рекомендуется хранить обезличенные fixture-снимки для фаз placeholder, reasoning, final-streaming, completed, tool-running, confirmation и error. Тесты должны проверять классификацию по fixture без реального запроса к ChatGPT.

## 14. Ограничения исследования

Проверены обычный короткий ответ и длинный reasoning-ответ. В длинном тесте обнаружена одна видимая агрегированная reasoning-отбивка, которая затем была заменена final-потоком. Интерфейс сам определяет частоту и содержание таких отбивок; prompt не гарантирует появление нескольких отдельных summary-блоков.

Необходимо отдельно получить fixtures для web search, tool call, подтверждения действия, Stop, Continue, network error и rate limit. Архитектура выше уже допускает эти блоки как отдельные события и состояния.

## 15. Диагностическая симуляция без предметной задачи

Дополнительно ChatGPT был прямо попрошен сымитировать жизненный цикл для DOM-парсера: создать несколько промежуточных отбивок, затем длинный final streaming и завершить специальным маркером.

Модель действительно создала пять последовательных Python tool-блоков:

```text
Проанализировано
Python print("diagnostic-step-1")
STDOUT/STDERR diagnostic-step-1

...

Проанализировано
Python print("diagnostic-step-5")
STDOUT/STDERR diagnostic-step-5
```

Фактическая временная шкала:

```text
0.0 с    видны tool steps 1–3, final author-node отсутствует
4.6 с    появляется выполняющийся step 4
7.7 с    step 4 завершён
13.1 с   появляется выполняющийся step 5
15.4 с   step 5 завершён
16.9 с   появляется [data-message-author-role=assistant], начинается final
43.4 с   stop-button исчезает, появляются действия ответа
```

В отличие от первого reasoning-теста, промежуточные tool-блоки не исчезли после завершения. Они остались прямыми соседями final message внутри общего message-stack.

Наблюдавшаяся логическая структура:

```html
<div class="... grow ... gap-4">
  <span>Проанализировано</span>
  <div>Python ... step-1 ... STDOUT/STDERR ...</div>

  <span>Проанализировано</span>
  <div>Python ... step-2 ... STDOUT/STDERR ...</div>

  ...

  <div
    data-message-author-role="assistant"
    data-message-id="621be488-..."
    data-message-model-slug="gpt-5-6-thinking"
    data-turn-start-message="true"
  >
    Диагностический финальный ответ...
  </div>
</div>
```

У tool wrappers в этом сценарии не было `data-testid`, роли или стабильного `data-*`. Поэтому нельзя полагаться только на `[data-testid]`. Рекомендуемая стратегия разделения блоков:

1. Найти общий message-stack внутри assistant-turn.
2. Его прямой дочерний узел с `data-message-author-role="assistant"` классифицировать как final.
3. Прямых содержательных соседей до final классифицировать как `status-or-tool`.
4. Соседние короткий status-label и следующий крупный tool-container объединять в один логический блок.
5. Для дедупликации использовать структурный fingerprint и нормализованный текст, а не индекс.
6. В момент появления final не удалять ранее сохранённые блоки: они относятся к тому же turn.

Пример извлечения верхнеуровневых блоков:

```js
function readAssistantBlocks(turn) {
  const final = turn.querySelector(
    ':scope [data-message-author-role="assistant"]'
  );
  const stack = final?.parentElement || findMessageStack(turn);
  if (!stack) return [];

  return [...stack.children]
    .map((element, index) => ({
      index,
      kind: element.matches('[data-message-author-role="assistant"]')
        ? 'final'
        : 'status-or-tool',
      text: (element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim(),
      html: element.outerHTML,
      attributes: Object.fromEntries(
        [...element.attributes]
          .filter(a =>
            a.name.startsWith('data-') ||
            a.name === 'role' ||
            a.name.startsWith('aria-')
          )
          .map(a => [a.name, a.value])
      ),
    }))
    .filter(block => block.text || block.kind === 'final');
}
```

`findMessageStack` не должен зависеть от класса `grow gap-4`: это наблюдавшийся, но нестабильный CSS. Надёжнее начать от final-node и выбрать ближайшего предка внутри turn, у которого есть содержательные прямые siblings перед final. До появления final временный stack определяется как наиболее узкий контейнер, объединяющий видимые status/tool-блоки; после появления final ранее найденный stack сверяется и переиндексируется.

### Уточнённая классификация

```text
ASSISTANT_REASONING
  assistant-turn без final author-node;
  видимый summary/status текст и/или cot-v5-*.

TOOL_RUNNING
  assistant-turn без final author-node или с ним;
  присутствует незавершённый tool-container/status-label;
  stop-button виден.

ASSISTANT_FINAL_STREAMING_WITH_HISTORY
  final author-node уже появился;
  его предыдущие siblings являются сохранёнными reasoning/tool events;
  stop-button виден.

ASSISTANT_FINAL
  final author-node присутствует;
  stop-button отсутствует;
  action bar присутствует;
  состояние стабильно.
```

Важный вывод из двух тестов: существуют по меньшей мере два поведения промежуточных данных.

- Reasoning-summary может быть заменён final и исчезнуть — нужен realtime event log.
- Tool/status blocks могут остаться siblings финального ответа — нужен раздельный парсинг блоков, иначе `turn.innerText` смешает reasoning/tool output с финальным ответом.

## Реализационное уточнение v59: логические thinking-блоки

Наблюдавшиеся классы `loading-shimmer-tertiary` и `text-token-text-tertiary` используются только как candidate signals, а не как самостоятельный долгосрочный контракт. Кандидат принимается лишь внутри текущего assistant-turn и при наличии reasoning-контекста: shimmer, `cot-v5-*`, transition wrapper либо положение перед финальным Markdown. Action bar, composer, citations, code blocks и file cards исключаются.

DOM-узел и текст не являются ID шага. Stateful reconciler сопоставляет снимки по следующему приоритету:

```text
тот же DOM node
тот же transition/structural slot + совместимый lifecycle/text
тот же kind + идентичный текст
активный шаг того же kind + высокая смысловая близость
```

Переход active shimmer → completed `cot-v5` button сохраняет ID. Повторная React-замена завершённой кнопки не создаёт событие. Повторное использование завершённого slot новым активным текстом создаёт новый ID. Исчезнувший активный блок завершается после подтверждённого исчезновения или появления final.

Обычный UI показывает активный шаг только в Live-области. Завершённый шаг добавляется в transcript один раз по `turnId + item.id`; forced snapshot и повторные MutationObserver reads обновляют revision, но не дублируют вывод.
