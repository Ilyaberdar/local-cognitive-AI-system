# Synthesis: облачные модели и параллельные агенты

Дата: 13 октября 2026. Статус: план реализации, имплементация не начата.
Состояние сверено с кодом `main` на `8de231e` и `feature/providers` на `7269d64`.

## 1. Что строим

Flow в Synthesis сможет:

1. Использовать облачные модели по API-ключу (OpenAI, Claude, Gemini, Qwen,
   DeepSeek, OpenRouter, Groq, Perplexity), в том числе вперемешку с локальными.
2. Создавать десятки агентов с инструментами работы с файлами. Права каждого
   агента задаются в коде flow путями: что ему можно читать и куда писать.
   Агентам раздаются подзадачи, они выполняются параллельно, затем результаты
   сводятся в отчёт.

Первая цель — 20–30 облачных агентов и 5–10 локальных на моделях около 2 ГБ.

```lcflow
implement RepoReview using "contract-v1" {
    limit iterations 3, time 30m, concurrency 20;
    policy = "agents-v1";

    lead = await model("deepseek-flash", provider = "deepseek");
    spec = freeze(RepoReview.spec);
    candidate = checkout("review");

    tasks = await lead.split("Review error handling in every module under src/", 20);

    agents = [];
    for (i in range(20)) {
        agents = append(agents, agent(provider = "deepseek", model = "deepseek-flash",
            tools = [files.read("src/**", "docs/**"), files.write("review/notes/**")]));
    }

    results = await parallel_map(agents, tasks, on_error = "collect");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");

    evidence = await evaluate(candidate, spec);
    verdict = verify(spec, evidence);
    if (verdict.status == Pass) { return accept(candidate, evidence); }
    return needs_review(evidence);
}
```

## 2. Решения

| Вопрос | Решение |
| --- | --- |
| Где работаем | Ветка `feature/synthesis-agents` от `feature/providers`, отдельный worktree, коммиты в ветке. В `main` не попадает до слова владельца. |
| Права агента | Задаются в flow через `files.read(...)`, `files.write(...)`, `files.delete(...)`, по путям относительно проекта. |
| Куда пишут агенты | В рабочую копию run. Проект не меняется до Apply. Один общий diff на всех агентов. |
| Два агента правят один файл | Второй получает конфликт версии (`expectedVersion` уже есть в `file.write`) и перечитывает файл. |
| Облако для проекта | Включает только хост, отдельной галочкой в проекте. Устройства через Remote пользуются облаком только там, где хост его включил. |
| Стоимость и лимиты | Пока не обсуждаем. Цены и ограничение по `cost` отложены; токены считаются и показываются. |
| Терминал | Отдельный последний этап, решения по нему согласуем перед ним. |
| Отчёт | Артефакт `REPORT.md` в контракте. Принимается гейтами; новый гейт `Grounded` проверяет ссылки `path:line`. |

## 3. Что мешает сегодня (сверено с кодом)

- Облако запрещено проверкой `SynthesisService.ts:328`, `:338`, `:346`. Synthesis
  получает список моделей только у локальных менеджеров (`buildRuntime.ts:579-583`),
  а `loadModel` всегда локальный (`RuntimeManager.ts:154`). Сам `LLMService`
  уже работает с любым провайдером.
- Интерпретатор выполняет всё по очереди, `await` ничего не делает
  (`Interpreter.ts:57-63`). Потолок 10 000 шагов зашит (`Interpreter.ts:26`).
  Нет `for`, индексов и добавления в массив.
- Каждое событие переписывает весь JSON run, событий не больше 2000
  (`SynthesisService.ts:629-636`). Параллельные сохранения могут лечь не в том порядке.
- `AgentLoopRunner.generate` держит файловую блокировку бюджета на всё время
  инференса (`AgentLoopRunner.ts:257`), поэтому агенты с общим бюджетом идут по одному.
- llama.cpp запускается с `--parallel 1` (`LlamaCppRuntime.ts:101`), планировщик даёт
  один слот на модель (`LocalInferenceScheduler.ts:14`).
- Ошибки HTTP у провайдеров — нетипизированный `Error` с текстом (`OpenAICompatibleProvider.ts:194`).
- Баг: второй `models.list` возвращает и модели прошлых вызовов (`SynthesisService.ts:330-331`).
- Баг: при повторах `generateObject` учитываются токены только последней попытки (`LLMService.ts:103-107`).
- DeepSeek и Perplexity на `feature/providers` без нативных tool calls
  (`ProviderDialect.ts:91,95,108`): агенты работают через JSON-протокол. У Perplexity
  нет и JSON mode, и каждый запрос ищет в вебе.

## 4. Этапы

После каждого этапа: тесты этапа, полный набор тестов, коммит и push в ветку.

### Этап 0. Ветка и подготовка

- Worktree `../local-cognitive-AI-system-agents`, ветка `feature/synthesis-agents`
  от `feature/providers`, `node_modules` ссылкой на основной checkout (как у providers).
  Этот план — первый коммит ветки.
- Исправить два бага: каждый `models.list` возвращает свой список; `generateObject`
  суммирует токены всех попыток.
- Типизированная `ProviderHttpError {status, retryAfterMs, quota}` в OpenAI-compatible,
  Anthropic и Gemini провайдерах; текст ошибки не меняется.
- Один последовательный писатель записи run с прореживанием: новые сохранения
  объединяются, старое не перетирает новое.

Тесты: `synthesis-runtime` (свой список на вызов, порядок сохранений),
`usage-recording` (токены всех попыток), `openaiProvider`/`cloudProviders` (статус и Retry-After в ошибке).

### Этап 1. Облачные модели в Synthesis

- Политика `cloud-files-v1`: те же права на файлы, что у `local-files-v1`, плюс облачные
  провайдеры. `local-files-v1` остаётся строго локальной, облачный провайдер в ней —
  ошибка компиляции, а не выполнения.
- `models.list(provider = "openai")` берёт список из `ModelCatalogService`.
  `model("gpt-5", provider = "openai")` загружает модель по точному id. `models.select`
  для облака принимает `prefer` и `id`; `max_size` для облака — ошибка компиляции.
- Провайдер указывается строкой прямо в коде, чтобы до Run было видно, куда уйдут данные.
  Существование провайдера проверяется при запуске по списку провайдеров хоста.
- Облачная модель не загружается: run проверяет, что провайдер настроен и облако
  для проекта включено. `loadModel` вызывается только для локальных.
- Согласие: флаг облака в проекте, ставит только хост. Без него диагностика
  `SYNTHESIS_CLOUD_CONSENT` до первого запроса.
- UI: панель «Models» вместо «Local models», метка облака, токены run.
  DTO для сервера и устройств несут провайдера и токены.

Файлы: `src/synthesis/language/{types,Parser,semanticAnalyzer}.ts`, `src/synthesis/SynthesisService.ts`,
`src/app/RuntimeManager.ts`, `src/app/buildRuntime.ts`, `src/projects/types.ts`,
`src/runtime/{synthesisOperations,synthesisDto}.ts`, `frontend/synthesis/*`, `docs/lc-language.md`.

Тесты: `synthesis-language` (политики, провайдер строкой, `max_size` для облака),
`synthesis-runtime` (облачная роль не вызывает `loadModel`, смешанные роли, без согласия ноль запросов),
`synthesisOperations` (устройство не включает облако и не выходит за него).
Живая проверка: шаблон Rate limiter с DeepSeek в роли `developer`.

### Этап 2. Язык

- `for (x in list) { }` и `range(n)`. Цикл конечен, стоит шаги, но не тратит `iterations`.
- Массивы с типом элемента; `a[i]` (выход за границы — ошибка run); неизменяемое
  `append(a, x)` вместо `push`.
- `limit steps N` вместо зашитых 10 000.
- `range`, `append`, индекс выполняются в интерпретаторе, без событий и записи run.

Файлы: `src/synthesis/language/{types,Parser,semanticAnalyzer}.ts`, `src/synthesis/Interpreter.ts`, `docs/lc-language.md`.

Тесты: `synthesis-language` (типы `for`, переменная цикла не видна после него, индекс,
смешанный `append`), `synthesis-runtime` (порядок `for`, `range(1000)` в пределах шагов, `limit steps`).

### Этап 3. Агенты

**Язык**
- Политика `agents-v1`: всё из `cloud-files-v1` плюс агенты.
- `agent(provider = "...", model = "...", tools = [...], instructions = "...")` или
  `agent(role, tools = [...])` для уже загруженной модели. Агент — это описание, а не
  процесс; каждая задача запускает свой цикл агента по этому описанию.
- Права: `files.read("src/**", ...)`, `files.write("review/**")`, `files.delete("review/**")`.
  Пути проверяются при компиляции по правилам проекта. Запись разрешена только внутри
  папки `checkout` и только туда, что разрешает контракт.
- Контракт получает `files "notes/**";` в `artifacts`: область, где модели и агенты
  могут создавать файлы. Явные `file "..."` остаются обязательными файлами.
- `await parallel_map(agents, tasks, concurrency = N, on_error = "collect")`. Задача `i`
  идёт агенту `i` по кругу. Результаты в порядке задач: `.ok`, `.output`, `.error`,
  `.task`, `.files`. `on_error = "fail"` останавливает всех при первой ошибке.
- `await lead.split(goal, n)` — список подзадач от модели.
- `await lead.synthesize(candidate, spec, results, file = "REPORT.md")` пишет отчёт
  в рабочую копию. Если результаты не помещаются в контекст модели, сводит их деревом.

**Рантайм**
- Новый `src/synthesis/agents/`:
  - `SynthesisFileTools`. Исполнитель операций `file.list/search/read/write/replace/append/mkdir/delete`
    поверх слоя: чтение из проекта по разрешённым путям, запись в рабочую копию run.
    Чтение уже записанного файла возвращает версию из копии. Всё остальное — отказ
    без запроса подтверждения.
  - `AgentPool`. Очередь задач на K воркеров (`concurrency`); отдельный лимит одновременных
    запросов на провайдера; на 429 с Retry-After пауза и повтор шага, на 429 из-за квоты
    остановка всех агентов. Отмена run останавливает всех.
  - `reduce`. Сведение результатов деревом для `synthesize`.
- `AgentLoopRunner`: опция со списком разрешённых инструментов (только `file.*` из прав);
  у каждого агента свой `budgetId`, чтобы агенты не ждали друг друга; хранилище циклов
  в папке run (`runs/<id>/agents/`).
- Diff и Apply работают с любым числом файлов в области и с удалениями
  (`after: null`), с той же проверкой baseline.
- В записи run счётчики `agents {total, queued, running, done, failed}` и несколько вех
  вместо событий каждого шага. События каждого агента остаются в его файле.

**UI, сервер, Remote**
- Панель «Agents»: счётчики, таблица агентов (задача, модель, статус, шаги, токены,
  записанные файлы), просмотр шагов одного агента.
- Постраничные запросы `synthesis.runs.agents` и `synthesis.runs.agent` для desktop, сервера и устройств.
- Устройство запускает агентов только в своих проектах и только с облаком, которое
  включил хост. Отмена и удаление доступны, как сейчас.

Файлы: `src/synthesis/agents/*` (новые), `src/synthesis/{SynthesisService,types,paths}.ts`,
`src/synthesis/language/*`, `src/agents/runtime/AgentLoopRunner.ts`, `src/tools/AgentTool.ts`,
`src/runtime/{synthesisOperations,synthesisDto}.ts`, `src/api/synthesisControllers.ts`,
`frontend/synthesis/SynthesisAgents.tsx` (новый), `public/assets/server-synthesis.js`, `docs/lc-language.md`.

Тесты: новый `synthesis-agents.test.ts` с поддельными моделями, где ответы приходят в
перемешанном порядке. Проверяется:
- одновременно не больше `concurrency`;
- результаты в порядке задач;
- `collect` и `fail`;
- отмена останавливает всех;
- чтение и запись вне прав отклоняются без запроса подтверждения;
- запись не трогает проект до Apply;
- конфликт версии при записи двумя агентами;
- проект не меняется до Apply, а Apply применяет файлы и удаления;
- запись run остаётся маленькой при 30 агентах.

Ещё тесты:
- `agent-loop`: разные бюджеты идут параллельно; список инструментов ограничивается.
- `synthesis-language`: `agent`, права, `files` в контракте, политика.
- `synthesisOperations`: правила для устройств.

### Этап 4. Локальные агенты: слоты

- `models.load(selected, slots = 6, context = 8192)`: llama-server запускается с `--parallel 6`
  и `--ctx-size 6×8192`. Проверка памяти (`planPlacement`) учитывает весь контекст.
  Если не помещается, ошибка run с понятным текстом.
- `LocalInferenceScheduler`: N слотов на модель вместо одного.
- Разные локальные модели одновременно уже возможны через `LocalRuntimePool`; агент
  получает свою модель по `agent(role, ...)`.

Файлы: `src/local/{LlamaCppRuntime,LocalInferenceScheduler,LocalRuntimePool}.ts`, `src/synthesis/SynthesisService.ts`.

Тесты: планировщик (N запросов одновременно на модель, не больше N), аргументы запуска
(`--parallel`, `--ctx-size`), отказ при нехватке памяти. Живая проверка на Mac:
5–10 агентов на модели около 2 ГБ.

### Этап 5. Гейт `Grounded` и шаблон

- `hard grounded = Grounded("REPORT.md")`: каждая ссылка `path` или `path:line` в отчёте
  существует в проекте, и строка в пределах файла. Неверные ссылки уходят обратно
  модели как замечания.
- Шаблон «Repository review» в New module: контракт, flow и тесты.

Файлы: `src/synthesis/checks/*`, `src/synthesis/templates.ts`, `docs/lc-language.md`.
Тесты: `synthesis-contracts` (верные и неверные ссылки, строка за концом файла, путь вне проекта).

### Этап 6. Живой тест

- Ключи DeepSeek и Perplexity уже лежат в `~/.config/local-cognitive/provider-keys.env`
  (права 600). Ключи в чат не передаются.
- Скрипт `scripts/test-synthesis-agents.mjs`: запускает flow на копии проекта и печатает
  таблицу: агенты готово/ошибка, шаги, токены, время, записанные файлы, вердикт.
  Ключи в выводе скрыты.
- Прогоны:
  1. 20 агентов DeepSeek в цикле `for`, задача — обзор модулей `src/` с заметками
     в `review/notes/` и итоговым `REPORT.md`.
  2. То же с Perplexity (JSON-протокол без JSON mode, с поиском в вебе); сравнение с DeepSeek.
  3. Смешанный: часть агентов DeepSeek, часть Perplexity.
  4. 5–10 локальных агентов на модели около 2 ГБ со слотами.
- Тот же flow в приложении: панель Agents, diff, Apply. Скриншоты.

### Этап 7. Терминал (позже, отдельно согласуем)

Своя папка для записи у каждого агента, затем `terminal` в существующей песочнице
(`src/synthesis/checks/sandbox.ts`): без сети, проект только на чтение. На Windows
песочницы нет, поэтому терминала там не будет.

## 5. Риски

- Агенты DeepSeek и Perplexity работают через JSON-протокол, а не нативные tool calls,
  поэтому возможны ошибки формата. Цикл агента уже умеет их исправлять. Нативные
  tool calls через chat completions — шаг 4 плана провайдеров; когда он появится,
  агенты перейдут на них сами, так как протокол выбирается по возможностям провайдера.
- `feature/providers` ещё меняется. Ветка агентов периодически вливает её в себя.
- Рабочая копия хранится в записи run. Для 20–30 агентов с заметками это сотни
  килобайт; если вырастет, файлы копии уедут в отдельную папку run.
- Отчёт без гейта, который может его проверить, заканчивается `needs_review`,
  и Apply для него недоступен, как и сейчас.

## 6. Состояние на 14 октября 2026

Сделано в ветке `feature/synthesis-agents`: этапы 0–6 и сверх плана.

- **Облачные модели.** `cloud-files-v1`, провайдер строкой, согласие проекта (ставит только хост), проверка ключа и согласия перед каждым вызовом.
- **Язык.** `for (x in list)`, `range`, `a[i]`, `append`, `limit steps`.
- **Агенты.** `agents-v1`, `agent(...)`, права `files.read/write/delete`, `parallel_map`, `split`, `synthesize` (с `feedback` для цикла исправления отчёта), области `files "notes/**"`, гейт `Grounded`, вкладка Agents (и на подключённом устройстве), шаблон Repository review.
- **Локальные агенты.** `models.load(..., slots = N, context = C)`: llama.cpp с `--parallel N`, очередь на N запросов к модели.
- **Провайдеры.** Очередь на провайдера: при 429 меньше одновременных запросов и повтор без траты шага. Одна очередь на все run. Запрос агента может длиться до 10 минут.
- **Гонки.**
  - одна блокировка пути без учёта регистра;
  - проверка правил прямо перед записью;
  - снимок версий файлов проекта на run;
  - слоты модели не меняются под работающими агентами;
  - отмена ждёт только свой слот.
- **Смысловые гонки.**
  - Владение: `files.write(..., own = true)`.
  - Checkout, как в Perforce: `file.checkout` / `file.submit` / `file.revert`. Захват всего набора или ничего. Изоляция незаконченных правок. Автоотправка у закончившего агента и откат у упавшего. Режим `checkout = "required"`. Ждать может только тот, кто ничего не держит.
- **Безопасность** (из фоновой проверки):
  - контракт и тесты закрыты для агентов в любом месте и в любом регистре;
  - ссылки по пути не уводят из проекта;
  - шаблоны поиска сопоставляются за линейное время, у чат-агентов тоже.

Живые проверки (`scripts/test-synthesis-live.mjs`, приложение через Playwright):

| Прогон | Итог |
| --- | --- |
| 20 агентов DeepSeek в цикле `for` | Accepted: 18 из 20, 15 заметок |
| 10 моделей (DeepSeek и модели через Perplexity) | Лучший: 18 из 20, тесты отчёта прошли, `Grounded` нашёл 2 плохие ссылки из 130 |
| 6 локальных агентов, Qwen3.5-4B, 6 слотов | `Grounded` прошёл, заметок меньше, чем требует контракт |
| 6 агентов на одном файле под `checkout = "required"` | 5 разделов, ни один не затёрт |
| Приложение: 5 агентов DeepSeek | Accepted на второй итерации цикла исправления |

Этап 7, терминал, сделан (deadade, f2064b3):
- `terminal(allow = [...])`: node, npm, npx, python3, git (только чтение), rg, ls, cat;
- копия файлов, которые агент может читать, с его правками; без сети, до 120 с на команду;
- копию пишет процесс внутри той же песочницы, поэтому ссылки, которые подкладывает команда, наружу не ведут;
- самопроверка песочницы (чтение, запись, сеть) прежде, чем ей доверять, и для тестов контракта тоже;
- живой прогон BugFix: три агента сами гоняли тесты в терминале, run принят за 15–20 с.

Проверка на сервере fedora (15 октября, коммит 8053064): Fedora 43, ядро 7.1, SELinux Enforcing, bubblewrap 0.11, GTX 1070 Ti. Всё шло от обычного пользователя во временной папке, сервис 0.1.6 не трогали, после проверки папки удалены.

| Проверка | Итог |
| --- | --- |
| Тесты песочницы и агентов | 72: 59 прошли, 0 упали, 13 пропущены (C++: на сервере нет g++) |
| Полный набор | 1201: 1172 прошли, 0 упали, 29 пропущены (C++, Cloud без базы, модели без явного пути) |
| BugFix, 3 агента DeepSeek с терминалом в bubblewrap | Accepted за 23,5 с, тесты 5 из 5 |
| LocalReview, 6 агентов на Qwen3.5-4B, 6 слотов, CUDA | Accepted за 132,7 с: llama.cpp с `--parallel 6`, все слои на GPU, 5,8 ГБ VRAM; `Grounded`: 13 ссылок |
| RepoReview, 20 агентов DeepSeek | Accepted за 307 с: 20 из 20, 18 заметок; цикл исправления убрал 2 плохие ссылки из 87 |

Ночь на 15 октября: fedora на тестовой сборке 0.1.7-test.2 (коммит c31e8b5, поставлена `update`; откат `sudo local-cognitive-server rollback`).

- Все облачные провайдеры на сервере: из файла окружения (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `PERPLEXITY_API_KEY`, свои `LOCAL_COGNITIVE_PROVIDER_<ID>_BASE_URL`) и «Add provider» с компьютера (`providers.discover`, `providers.add`; адрес только серверный).
- npm в Node сервера; `deps <project>` (npm ci в рабочей папке сервера, lock проверяется, `.npmrc` проекта не читается).
- Найдено новыми тестами и исправлено: агент с терминалом без прав записи не мог запускать команды; `npm test` в терминале не работал на Mac; редкое падение теста зависшего процесса (EPERM); формы страниц Settings для сервера не подключались.

| Проверка на fedora | Итог |
| --- | --- |
| Полный набор с Node из пакета (вне домашней папки) | 1225: 1196 прошли, 0 упали, 29 пропущены |
| 10 повторов: песочница, агенты, runCommand, deps, UI Synthesis и Settings | 0 падений |
| Под systemd через сервис: `deps`, 3 агента на Qwen3.5-4B со слотами на CUDA, `npm test` в терминале | `deps` поставил зависимости; агенты запускали `npm test` в песочнице; модель починила 1 из 5 тестов (Needs review) — это качество 4B, не система |

Осталось:

- Песочница для Windows (помощник AppContainer + Job Object): отдельный этап, с проверкой на Windows-машине владельца.
- ~~Облако в Synthesis на сервере~~: сделано командой `sudo local-cognitive-server cloud-models [allow|deny <project>]` (через управляющий сокет, по id, имени или папке; есть в консоли). Устройство видит «Cloud models: on/off» (`synthesis.cloud.get`), изменить не может. Согласие проверяется перед каждым запросом агентов, `split`, `synthesize` и каждого файла `revise`.
- Ubuntu с AppArmor (`bwrap-userns-restrict`) не проверена: нужна настоящая машина.
- Если Apple уберёт `sandbox-exec`: помощник на том же Seatbelt (`sandbox_init_with_parameters`), строгий режим на Apple Containerization.
- Слияние в `main`: по слову владельца. Ветка трогает `OpenAICompatibleProvider` (Perplexity без веб-поиска для агентов) и при слиянии с `feature/providers` может дать небольшой конфликт.
