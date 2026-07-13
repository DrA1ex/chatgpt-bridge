# Спецификация DOM-парсинга файлов и блоков кода ChatGPT

Статус: отдельное дополнение к основной спецификации DOM-парсера. Дата исследования: 11 июля 2026 года.

## 1. Область документа и главный приоритет

Документ описывает:

- открытие меню добавления файлов;
- загрузку одного и нескольких входных вложений;
- состояния загрузки до отправки сообщения;
- привязку вложений к user-turn;
- файлы, созданные ChatGPT;
- несколько выходных файлов в одном assistant-turn;
- ссылки и кнопки скачивания;
- Markdown-код и полноценные code blocks;
- завершение ответа, когда текст уже готов, а файл ещё создаётся.

Документ дополняет `chatgpt-dom-parser-spec.md`. Общие правила turns, reasoning, tool blocks, streaming и завершения из основной спецификации остаются обязательными.

Главный приоритет — не способ вызова системного выбора файла, а разбор результатов, которые ChatGPT создаёт внутри assistant-turn. Входной `input[type=file]` рассматривается лишь как дополнительный источник состояния. Основной объект исследования:

```text
assistant-turn
  reasoning/status/tool history
  final text
  one or more generated artifacts
  fenced code blocks
  inline code
  download actions
```

## 2. Степень подтверждения

Подтверждено в живом авторизованном DOM Chrome:

- кнопка `[data-testid="composer-plus-btn"]` / `#composer-plus-btn`;
- accessible name «Добавить файлы и другое»;
- после открытия меню видны пункты «Прикрепить фото и файлы» и «Загрузить с компьютера»;
- загрузка открывает системный file chooser, а не обычную навигацию;
- текстовый узел «Загрузить с компьютера» не является надёжной самостоятельной кнопкой: клик нужно направлять в его интерактивного предка либо работать с `input[type=file]`/file chooser;
- в ответах code block имеет отдельную кнопку «Копировать»;
- inline code и специальные code-like fragments могут иметь кнопку «Цитирование кода», поэтому наличие `code` само по себе не означает fenced code block.

Точные структуры выходных файлов и code blocks дополнительно подтверждены живым DOM ответа с пятью создаваемыми артефактами. Важный результат: готовые файлы в исследованной версии представлены не ссылками, а кнопками без `href` и без `download`.

Любой селектор с пометкой «кандидат» должен обнаруживаться по DOM конкретной версии и сохраняться в telemetry/fixture до включения в стабильный контракт.

## 2.1. Подтверждённый смешанный fixture

Исследован `conversation-turn-18`:

```html
<section
  data-testid="conversation-turn-18"
  data-turn="assistant"
  data-turn-id="83d4bfa7-291e-43bf-8d3c-a79dbdc3f957"
>
```

Финальный author-node:

```html
<div
  data-message-author-role="assistant"
  data-message-id="d0d1d605-cd9a-4a45-b378-04a7ff210d05"
  data-message-model-slug="gpt-5-6-thinking"
  data-turn-start-message="true"
>
```

Перед final author-node в том же turn сохранились несколько Python/status/tool-блоков: три диагностических статуса и отдельные вызовы создания каждого файла и архива. Следовательно, как и в основной спецификации, `turn.innerText` нельзя считать финальным текстом.

Финальный Markdown-root содержал 14 упорядоченных прямых детей:

```text
p    вводный текст
p    inline code
pre  JavaScript block
pre  Python block
p    пояснение
p    artifact-single.txt button
p    пояснение
p    artifact-table.csv button
p    artifact-data.json button
p    artifact-script.js button
p    пояснение
p    artifact-bundle.zip download button
div  Markdown table
p    FILE_DOM_TEST_COMPLETED
```

У большинства Markdown-блоков присутствовали `data-start` и `data-end`. У последнего параграфа также присутствовали:

```html
data-is-last-node=""
data-is-only-node=""
```

`data-start`/`data-end` полезны для восстановления порядка и идентификации React replacement внутри одного final message, но это offsets исходного сообщения, а не глобальные ID.

## 3. Модель данных

```ts
type AttachmentDirection = 'input' | 'output';
type AttachmentPhase =
  | 'LOCAL_SELECTED'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'BOUND_TO_TURN'
  | 'GENERATING'
  | 'READY'
  | 'FAILED'
  | 'REMOVED';

interface ParsedAttachment {
  key: string;
  direction: AttachmentDirection;
  phase: AttachmentPhase;
  fileName: string | null;
  extension: string | null;
  mimeHint: string | null;
  sizeText: string | null;
  href: string | null;
  downloadName: string | null;
  previewUrl: string | null;
  progressText: string | null;
  errorText: string | null;
  removable: boolean;
  downloadable: boolean;
  turnId: string | null;
  messageId: string | null;
  rawAttributes: Record<string, string>;
}

interface ParsedCodeBlock {
  key: string;
  language: string | null;
  code: string;
  copyButtonPresent: boolean;
  downloadButtonPresent: boolean;
  fileName: string | null;
  isInline: boolean;
}
```

## 4. Открытие меню вложений

Подтверждённый основной locator:

```js
const plus = page.locator('[data-testid="composer-plus-btn"]');
```

Fallback:

```js
const plus = page.locator('#composer-plus-btn');
```

Семантический fallback требует локализации:

```js
page.getByRole('button', { name: 'Добавить файлы и другое' });
```

После клика нужно дождаться не произвольного popup, а меню, содержащее обе строки:

```text
Прикрепить фото и файлы
Загрузить с компьютера
```

Текст «Загрузить с компьютера» может находиться внутри generic child. Алгоритм клика:

1. Найти точный текст внутри открытого popup/menu.
2. Подняться до ближайшего интерактивного предка: `button`, `[role=menuitem]`, `[role=button]`, `label` или элемента с управляемым click contract.
3. Проверить уникальность.
4. До клика подписаться на событие `filechooser`.
5. Выполнить клик.
6. Передать файлы через file chooser.

Не ждать file chooser до клика синхронно: событие возникает только в результате пользовательского действия.

```js
const chooserPromise = page.waitForEvent('filechooser');
await uploadMenuItem.click();
const chooser = await chooserPromise;
await chooser.setFiles(paths);
```

Для нескольких файлов передавать массив за один chooser, если `isMultiple()` возвращает `true`. Если `false`, повторять полный цикл меню отдельно для каждого файла.

## 5. Discovery скрытого input

Перед использованием file chooser полезно снять карту:

```js
function discoverFileInputs() {
  return [...document.querySelectorAll('input[type="file"]')].map(input => ({
    accept: input.getAttribute('accept'),
    multiple: input.hasAttribute('multiple'),
    name: input.getAttribute('name'),
    testId: input.getAttribute('data-testid'),
    ariaLabel: input.getAttribute('aria-label'),
    hidden: input.hidden,
    disabled: input.disabled,
  }));
}
```

Не устанавливать `input.files` через обычный JavaScript: браузер запрещает это, а ручная подмена может не вызвать внутреннюю загрузочную логику React. Использовать Playwright file chooser или `setInputFiles` в среде, где он поддерживается.

## 6. Состояние composer после выбора файлов

После выбора каждого файла parser должен наблюдать composer до отправки.

Искомые признаки карточки-кандидата:

- имя файла или расширение;
- кнопка удаления/закрытия;
- preview для изображения;
- индикатор загрузки;
- ошибка формата/размера;
- href/blob URL, если он уже создан;
- `data-testid`, `data-state`, `aria-busy`, progressbar;
- принадлежность composer, а не истории сообщений.

Discovery selector:

```css
form input[type="file"],
form [data-testid],
form [data-state],
form [aria-busy],
form [role="progressbar"],
form button[aria-label],
form img,
form a[href]
```

Нельзя выбирать все элементы формы как готовые attachments. Кандидат должен удовлетворять минимум двум независимым признакам, например:

```text
file-like text + remove button
image preview + file-like text
upload/progress state + file-like text
input file metadata + новая composer card
```

## 7. Один и несколько входных файлов

Перед добавлением сохранить baseline composer:

```ts
{
  inputFileCount,
  candidateCardCount,
  text,
  sendVisible,
  stopVisible
}
```

После выбора двух файлов ожидать:

1. Два различных attachment candidates либо один group с двумя items.
2. Имена/расширения обоих файлов доступны DOM или aria tree.
3. Отсутствуют ошибки.
4. Все элементы перешли из `UPLOADING` в `UPLOADED`.
5. Кнопка отправки активна при наличии prompt либо интерфейс разрешает отправку attachments без текста.

Не считать число видимых кнопок удаления числом файлов: group может иметь общую кнопку, а preview может иметь дополнительные actions.

Для ключа до отправки:

```text
hash(normalizedName + sizeText + previewUrl + insertionOrdinal)
```

После отправки attachment должен получить стабильную привязку к `data-turn-id` user-turn.

## 8. Удаление вложения до отправки

Каждая карточка должна проверяться на scoped remove action.

```js
const card = /* подтверждённая attachment card */;
const remove = card.locator('button[aria-label]');
```

Accessible name локализован и может содержать имя файла. Нужен discovery по семантике remove/close внутри card, а не глобальный поиск `button`.

После клика проверить:

- исчезла именно выбранная card;
- остальные вложения сохранились;
- composer text не изменился;
- `input[type=file]`/внутренняя очередь синхронизировались;
- удалённый файл не появился в отправленном user-turn.

## 9. Отправленный user-turn с файлами

После отправки искать новый `[data-turn="user"]`. Внутри него разделять:

- текст prompt;
- attachment cards;
- изображения/previews;
- file metadata links;
- turn action bar.

Нельзя возвращать `turn.innerText` как prompt: имена файлов попадут в текст. Результат:

```ts
interface ParsedUserTurn {
  promptText: string;
  attachments: ParsedAttachment[];
  turnId: string | null;
}
```

Prompt text брать из `data-message-author-role="user"` после исключения потомков attachment cards либо из специализированного text container, найденного fixture-анализом.

## 10. Ответ ChatGPT с созданным файлом

Выходной файл может появиться:

- внутри final assistant message;
- как отдельный sibling tool/result block;
- сначала как status «создание файла», затем как download card;
- после того как основной текст уже начал streaming.

Parser должен искать внутри всего assistant-turn, а не только внутри `[data-message-author-role="assistant"]`.

Discovery selector:

```css
[data-turn="assistant"] a[href],
[data-turn="assistant"] [download],
[data-turn="assistant"] button[aria-label],
[data-turn="assistant"] [data-testid],
[data-turn="assistant"] [data-state],
[data-turn="assistant"] [role="progressbar"]
```

Кандидат output attachment подтверждается по нескольким сигналам:

- file-like filename/extension;
- `href` или download action;
- атрибут `download`;
- файловая иконка/preview;
- sibling text «Скачать»/download;
- tool result, который перешёл в ready;
- blob/sandbox/temporary file URL.

Не считать обычную citation link вложением.

## 11. Отличие attachment от ссылки и citation

```js
function classifyLink(anchor, context) {
  const href = anchor.getAttribute('href') || '';
  const download = anchor.getAttribute('download');
  const text = (anchor.innerText || '').trim();
  const citation = anchor.closest('[data-testid="webpage-citation-pill"]');

  if (citation) return 'citation';
  if (download !== null) return 'attachment';
  if (context.hasFileCard && context.hasFileLikeName) return 'attachment';
  if (/^blob:|\/files?\/|download/i.test(href) && context.hasFileLikeName) {
    return 'attachment-candidate';
  }
  return 'link';
}
```

Расширение в тексте (`report.csv`) само по себе недостаточно: модель может упомянуть имя в обычном параграфе или code block.

## 12. Несколько выходных файлов

Модель данных должна допускать:

- несколько отдельных file cards;
- один group/container с несколькими downloadable children;
- один архив плюс отдельные исходные файлы;
- повторное имя файла с разными URL/версиям;
- файл, заменённый в ходе tool execution.

Дедупликация:

```text
primary key: stable data-id, если есть
fallback: normalized filename + canonicalized href + turnId
streaming fallback: structural path inside stable turn + insertion timestamp
```

Не дедуплицировать только по имени: два файла могут иметь одинаковое имя.

При React replacement переносить историю phase по совпавшему key:

```text
GENERATING → READY
GENERATING → FAILED
READY(old href) → READY(new href, revision++)
```

## 13. Скачивание результата

Для автоматизации использовать locator конкретного attachment card.

Если файл является ссылкой с обычной навигацией, читать `href` и скачивать разрешённым способом. Если клик инициирует browser download:

```js
const downloadPromise = page.waitForEvent('download');
await cardDownloadAction.click();
const download = await downloadPromise;
```

Не нажимать все кнопки «Скачать»: scope должен быть attachment card. Не считать доступность URL постоянной — blob/signed URLs могут истечь.

### 13.1. Preview для текстовых и табличных файлов

Подтверждены три живых DOM-варианта, в которых первый клик по artifact action открывает просмотр вместо немедленной загрузки.

Fullscreen dialog:

```text
[role="dialog"]
header > h2                         # полное имя файла
header button[aria-label]           # download, close
[id^="artifact-text-preview-"]      # CodeMirror readonly content
```

Library/content panel:

```text
[slot="content"]
header span.text-token-text-primary...truncate  # имя файла или display title
header button[aria-label]                    # download
header button[data-testid="close-button"]    # preferred close
[id^="artifact-text-preview-"]               # CodeMirror readonly content when present
```

Spreadsheet/table (`popcorn`) panel:

```text
[slot="content"]
[data-testid="popcorn-toolbar"]
[data-testid="popcorn-file-title"]
  span                              # display title, может быть без расширения
  span                              # format label, например CSV
[data-testid="popcorn-toolbar-actions"]
  button[aria-label]                # localized download
  button[data-testid="close-button"]
```

Display title не обязан быть именем файла. Например, ожидаемый `test_data.csv` может отображаться как `test_data` + `CSV`, а ZIP может называться `Release bundle` без `.zip`.

Иерархия identity:

1. Полное имя файла совпало точно.
2. Display title совпал с полным ожидаемым именем.
3. Display title совпал со stem ожидаемого имени, а соседний format label совпал с расширением/MIME (`test_data` + `CSV` -> `test_data.csv`).
4. Произвольный display title допускается только после клика по уже точно выбранному artifact action и только когда артефакт этого формата единственный среди `READY`-артефактов исходного assistant-turn.
5. Если одного формата несколько и title не связывается со stem/filename, preview считается неоднозначным и materialization завершается fail-closed.

Алгоритм materialization:

1. Сначала оставить активными прямые Blob/URL/`chrome.downloads` capture paths. ZIP, бинарные и большие файлы обычно завершаются этим путём и не должны ждать preview.
2. До клика закрыть только уже открытые распознанные file-preview containers.
3. Найти один точный scoped artifact action исходного assistant-turn и нажать его один раз.
4. Искать новый `role=dialog` или `[slot=content]`; применить указанную выше identity hierarchy. Само появление loader/container не является готовностью.
5. Ждать исчезновения loader и появления фактической usable download-кнопки. Для CodeMirror text preview дополнительно ждать смонтированный content node; для table/CSV достаточно доказанной identity и готового toolbar action.
6. Предпочитать `a[download]`/download `data-testid`. Пока ChatGPT не даёт стабильного идентификатора, допустим временный fallback по `aria-label`, но только внутри уже identity-bound container. Поддерживаются English, Russian, French, German, Spanish, Italian, Portuguese, Dutch, Polish, Turkish, Japanese, Korean, Simplified и Traditional Chinese варианты.
7. Close предпочитает `data-testid="close-button"`; fallback по локализованному `aria-label` также разрешён только внутри того же container. Escape остаётся последней резервной веткой.
8. После доказанной preview identity зарегистрировать display title как временный expected-name alias для page/browser capture. Расширение добавляется из ожидаемого artifact descriptor (`test_data` -> `test_data.csv`). Исходное ожидаемое имя остаётся допустимым; alias действует только для текущего capture и не переносится на следующий файл.
9. Если прямой text URL capture завершился раньше, чем preview появился, ждать только короткое bounded окно и закрыть запоздавший preview. Если открывается foreign/ambiguous preview, закрыть его и немедленно завершить identity-ошибкой; повторный слепой клик запрещён.
10. Если browser download не материализовался быстро, readonly CodeMirror text может быть возвращён как UTF-8 bytes без нормализации `textContent`. Для table/CSV DOM-реконструкция не используется: должна завершиться реальная загрузка.

Глобальный поиск по словам «Скачать»/`Download` запрещён. Локализованная строка допустима только после доказанной привязки контейнера к конкретному artifact. Неоднозначные identity/download/close controls должны завершаться fail-closed.

Parser обязан вернуть метаданные файла и возможность скачивания отдельно:

```ts
{
  fileName,
  href,
  downloadable,
  downloadActionPresent,
  urlMayExpire: true
}
```

## 14. Блоки кода

Минимальная классификация:

```text
inline code: code, не находящийся внутри pre
fenced block: pre code или специализированный code viewer
tool input code: code editor/viewer внутри tool block
tool output: pre/output container рядом с tool input
file preview code: code viewer внутри attachment/file card
```

Не смешивать эти типы.

### Discovery code block

```js
function readCodeBlocks(turn) {
  const candidates = [...turn.querySelectorAll('pre')];

  return candidates.map((pre, index) => {
    const code = pre.querySelector('code') || pre;
    const container = findSmallestCodeContainer(pre, turn);
    const copyButton = findScopedAction(container, ['copy']);
    const downloadButton = findScopedAction(container, ['download']);
    const language = discoverLanguage(container, code);

    return {
      key: `${turn.getAttribute('data-turn-id')}:code:${index}`,
      language,
      code: code.textContent || '',
      copyButtonPresent: Boolean(copyButton),
      downloadButtonPresent: Boolean(downloadButton),
      fileName: discoverFileName(container),
      isInline: false,
    };
  });
}
```

`innerText` может визуально нормализовать пробелы. Для исходного кода предпочтителен `textContent`, сохраняя `\n`, отступы и завершающую новую строку.

### Язык блока

Искать в порядке:

1. стабильный `data-language`/`data-lang`;
2. class `language-*` на `code`;
3. видимая подпись header (`JavaScript`, `Python`, `Bash`);
4. `null`, без попытки угадывать язык по содержимому.

### Кнопка копирования

В живом DOM кнопка имела accessible name «Копировать». Таких кнопок много, поэтому locator должен быть scoped к code container.

Нельзя проверять наличие code block только по кнопке «Копировать»: такая же кнопка используется у таблиц и других компонентов.

## 15. Потоковый code block

Во время streaming возможны:

- сначала появляется `pre`, затем `code`;
- язык появляется позже header;
- code text растёт characterData mutations;
- syntax highlighter заменяет внутренние spans;
- copy button появляется только после стабилизации;
- незакрытый Markdown fence временно отображается обычным текстом.

Fingerprint code block должен строиться по итоговому `textContent`, language и стабильному контейнеру, но event log обязан хранить изменения.

Состояния:

```text
CODE_TEXT_PENDING
CODE_BLOCK_STREAMING
CODE_BLOCK_READY
CODE_BLOCK_REPLACED
```

## 16. Завершение ответа с файлами

Обычный критерий завершения нужно усилить.

Ответ не `COMPLETED`, если:

- Stop ещё виден;
- final text стабилен, но output attachment имеет `GENERATING`;
- виден progressbar/aria-busy;
- download link ещё не появился;
- карточка файла меняет `data-state`;
- есть tool block без результата;
- filename появился, но action недоступен;
- присутствует ошибка создания/загрузки файла.

Составной критерий:

```js
const completed =
  hasNewAssistantTurn &&
  hasFinalAssistantNode &&
  !stopVisible &&
  actionBarVisible &&
  activeToolCount === 0 &&
  attachments.every(x => x.phase === 'READY') &&
  stableForMs >= 1500 &&
  !continueVisible &&
  !errorVisible &&
  !confirmationVisible;
```

Если модель обещала файл в тексте, но attachment card так и не появился, parser не должен бесконечно ждать без UI-сигнала. Бизнес-ожидание «должен быть файл» задаётся отдельно от DOM lifecycle и заканчивается `COMPLETED_WITH_MISSING_EXPECTED_ARTIFACT`.

## 17. Ошибки входных файлов

Отдельно классифицировать:

```text
UNSUPPORTED_TYPE
FILE_TOO_LARGE
UPLOAD_FAILED
UPLOAD_TIMEOUT
MALWARE_OR_POLICY_REJECTED
TOO_MANY_FILES
AUTH_REQUIRED
QUOTA_OR_RATE_LIMIT
REMOVED_BY_USER
```

Источник истины — видимый error/status в composer или turn. Не выводить причину только из HTTP-кода, если parser работает на уровне DOM.

## 18. Полный снимок файлового состояния

```ts
interface FileAwareChatState {
  composer: {
    text: string;
    attachments: ParsedAttachment[];
    canSubmit: boolean;
    errors: string[];
  };
  turns: Array<{
    turnId: string | null;
    author: string;
    text: string;
    inputAttachments: ParsedAttachment[];
    outputAttachments: ParsedAttachment[];
    codeBlocks: ParsedCodeBlock[];
    toolBlocks: unknown[];
  }>;
  activeUploads: number;
  activeGeneratedFiles: number;
  lifecycle: string;
}
```

## 19. Fixture-матрица

Для завершения реализации нужны отдельные fixtures:

1. Один `.txt` до отправки: uploading и uploaded.
2. Два файла разных типов до отправки.
3. Удаление одного из двух файлов.
4. User-turn с одним файлом.
5. User-turn с несколькими файлами.
6. Ошибка неподдерживаемого типа.
7. Ошибка слишком большого файла.
8. Assistant-turn с одним созданным файлом.
9. Assistant-turn с двумя созданными файлами.
10. Файл, создающийся после начала final text.
11. Неудачное создание output file.
12. Один fenced code block.
13. Несколько code blocks разных языков.
14. Inline code рядом с fenced block.
15. Tool input/output code плюс финальный code block.
16. Code block, предлагаемый как скачиваемый файл.

Для каждого fixture сохранять:

- DOM активного turn/composer;
- список значимых атрибутов;
- accessible snapshot;
- события MutationObserver;
- нормализованный ожидаемый результат parser;
- screenshot только для ручной сверки, не как источник данных.

## 20. Диагностический prompt для получения fixtures

После успешной загрузки двух синтетических файлов использовать запрос:

```text
Это диагностический тест DOM-парсера. Прочитай оба вложения. Затем:
1) покажи один fenced code block JavaScript;
2) покажи второй fenced code block Python;
3) создай два отдельных скачиваемых файла: result-summary.txt и result-table.csv;
4) не объединяй их в архив;
5) перед финалом выполни несколько видимых tool/status этапов;
6) в самом конце напиши FILE_DOM_TEST_COMPLETED.
Не включай содержимое файлов в имя ссылки и не заменяй реальные файлы обычными Markdown-ссылками.
```

Наличие маркера не является критерием завершения само по себе. Он нужен только для контроля полноты финального текста.

### Серия запросов без входных вложений

Эти запросы предназначены именно для того, чтобы ChatGPT сам придумал содержимое и создал разные выходные структуры.

#### Fixture A: один файл

```text
Это диагностический тест DOM-парсера ChatGPT. Придумай произвольный небольшой набор данных и создай один реальный скачиваемый файл artifact-single.txt. Не заменяй его Markdown-ссылкой и не помещай содержимое только в code block. Перед файлом дай короткий текст, после готовности файла напиши ARTIFACT_SINGLE_READY.
```

#### Fixture B: несколько файлов

```text
Это диагностический тест DOM-парсера ChatGPT. Придумай любые тестовые данные и создай три отдельных реальных скачиваемых файла: artifact-a.txt, artifact-b.csv и artifact-c.json. Не объединяй их в архив. Каждый файл должен быть отдельным артефактом интерфейса. Добавь короткое описание каждого и в самом конце напиши ARTIFACT_MULTI_READY.
```

#### Fixture C: файлы плюс code blocks

```text
Это диагностический тест DOM-парсера ChatGPT. Создай смешанный ответ со следующей структурой:
1) обычный вводный параграф;
2) fenced code block JavaScript;
3) реальный скачиваемый файл example.js с тем же кодом;
4) fenced code block Python;
5) два отдельных реальных файла data.csv и metadata.json;
6) inline code внутри заключительного параграфа;
7) маркер MIXED_ARTIFACTS_READY в самом конце.
Файлы должны быть настоящими UI-артефактами, а не только Markdown-ссылками или текстом.
```

#### Fixture D: длительное создание

```text
Это диагностический тест жизненного цикла файлового DOM. Сам придумай содержимое. Выполни несколько видимых tool/status этапов, затем начни потоковый текстовый ответ, после этого создай два отдельных скачиваемых файла delayed-one.txt и delayed-two.csv. Постарайся, чтобы файлы появлялись не одновременно. В самом конце напиши DELAYED_FILES_READY. Цель — проверить, что стабильный текст ещё не означает завершение создания артефактов.
```

#### Fixture E: архив и исходники

```text
Это диагностический тест DOM-парсера. Создай два отдельных исходных файла source-one.txt и source-two.json, а также отдельный archive.zip, содержащий их копии. Покажи один fenced code block со списком имён файлов. Не заменяй файлы обычными ссылками. В конце напиши ARCHIVE_AND_SOURCES_READY.
```

Для каждого запроса начинать запись DOM до отправки и завершать только после составного terminal condition. Маркеры помогают проверять полноту final text, но не заменяют UI-критерии.

## 20.1. Discovery output DOM без заранее известных testid

Пока точные атрибуты file cards не закреплены fixture, parser должен строить карту всех прямых и вложенных блоков последнего assistant-turn:

```js
function discoverAssistantArtifacts(turn) {
  const project = element => ({
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500),
    href: element.getAttribute('href'),
    download: element.getAttribute('download'),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    testId: element.getAttribute('data-testid'),
    state: element.getAttribute('data-state'),
    busy: element.getAttribute('aria-busy'),
    author: element.getAttribute('data-message-author-role'),
    messageId: element.getAttribute('data-message-id'),
  });

  const selector = [
    'a[href]',
    '[download]',
    'button',
    '[role]',
    '[data-testid]',
    '[data-state]',
    '[aria-busy]',
    'pre',
    'code',
    'img',
  ].join(',');

  return {
    turn: project(turn),
    directChildren: [...turn.children].map(project),
    candidates: [...turn.querySelectorAll(selector)]
      .slice(0, 300)
      .map(project),
  };
}
```

Снимать эту карту:

```text
T0 новый пустой assistant-turn
T1 первый reasoning/tool/status block
T2 начало final text
T3 появление первого file candidate
T4 первый file READY
T5 появление второго file candidate
T6 все файлы READY, Stop ещё виден
T7 Stop исчез и action bar появился
T8 контрольный стабильный снимок
```

## 20.2. Нормализация смешанного assistant-turn

Итог parser не должен возвращать единый `innerText`. Рекомендуемый результат:

```ts
interface MixedAssistantResult {
  finalText: string;
  generatedFiles: ParsedAttachment[];
  codeBlocks: ParsedCodeBlock[];
  inlineCode: string[];
  toolAndStatusHistory: VisibleBlock[];
  ordinaryLinks: ParsedLink[];
  citations: ParsedCitation[];
  completion: {
    state: string;
    stableForMs: number;
    allArtifactsReady: boolean;
  };
}
```

Порядок блоков необходимо сохранять отдельным массивом:

```ts
type OrderedContentBlock =
  | { kind: 'paragraph'; key: string; text: string }
  | { kind: 'code'; key: string; codeBlockKey: string }
  | { kind: 'file'; key: string; attachmentKey: string }
  | { kind: 'tool'; key: string; toolKey: string }
  | { kind: 'citation'; key: string; citationKey: string };
```

Это позволит восстановить семантический порядок «текст → код → файл → текст», даже если файлы технически отрисованы siblings вне final author-node.

## 21. Рекомендации модели-разработчику

1. Сначала реализовать discovery и telemetry, затем закреплять подтверждённые `data-testid`.
2. Никогда не смешивать prompt text, attachment names, tool output и final text через общий `turn.innerText`.
3. Хранить realtime history: временные upload/tool/status блоки могут исчезать.
4. Парсить output files по всему assistant-turn.
5. Scope всех generic actions (`Копировать`, `Скачать`, `Удалить`) к конкретной карточке.
6. Не считать стабильность текста завершением файлового ответа.
7. При неизвестной структуре возвращать `DOM_SCHEMA_CHANGED` с telemetry, а не пустой список файлов.
8. Версионировать fixtures по дате, locale, plan и model slug.


## Delayed fullscreen preview readiness

A `role=dialog` shell or `[slot=content]` panel can be visible while a loader still owns the body. Materialization must keep re-reading the identity-bound container until the download control is visible/enabled. CodeMirror viewers additionally require their code node; CSV/table `popcorn-toolbar` viewers do not. A direct ZIP/binary/browser download remains authoritative and bypasses this wait. For text URL captures, a bounded late-preview cleanup prevents a preview from appearing during the next file operation.

## Exact artifact action identity and bounded materialization

Generated-file buttons in one assistant turn may expose the same generic CSS path. A stored selector hint therefore cannot identify a file. Resolution must enumerate live actions in the exact `sourceTurnKey`, derive each candidate filename and block/action locator, and accept only one unique candidate. Exact filename is strongest; generic actions may fall back to matching block offsets/test id plus action ordinal/stable metadata. A tie or mismatch is fail-closed.

The browser-side materialization budget is 45 seconds, with a 60-second server command envelope. Waiting is phase-specific: action appearance uses bounded exponential backoff without repeated clicks; preview waits for filename, loader completion, a usable download control, and mounted text content; direct page/browser capture remains active for ZIP, binary, and large files. When a foreign filename preview appears, it is closed and reported immediately as `ARTIFACT_ACTION_TARGET_MISMATCH`, while all unused captures are cancelled.
