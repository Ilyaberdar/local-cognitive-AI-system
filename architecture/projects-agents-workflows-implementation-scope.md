# Scope реализации: проекты, агентный цикл и рабочая папка Workflow

Дата: 2026-09-23. Статус: исходный scope реализован в рабочем дереве; ниже сохранён план и его исходная точка, поэтому формулировки «нужно добавить/изменить» не являются описанием текущего кода. Новый цикл применяется к проектным чатам и агентам Workflow; обычные чаты сохраняют совместимый прежний маршрут. JSON-протокол объединён со схемами в AgentTool.ts, типы checkpoint — в AgentRunStore.ts, инструкции — в AgentLoopRunner.ts. Перепривязка корня существующего проекта отклоняется: новую папку нужно зарегистрировать отдельно. Суммарные лимиты охватывают structured tool loops; финальный debate использует прежний ограниченный маршрут. Итоговое поведение и настройки описаны в README, раздел Projects and task workspaces.

Текущая граница plugin/MCP уточнена 30 сентября в [Plugin module: current implementation](plugin-module-current.md): agent loop предоставляет фиксированные file/command действия; registry plugins выполняются только отдельным compatibility-путём по исходному запросу пользователя после workspace-цикла, а исходящие MCP-инструменты не регистрируются в этом цикле.

Этот scope расширяет `projects-workspace-investigation.md` с учётом уточнения пользователя: самостоятельное исследование файлов агентами и привязка задач Workflow к проекту входят в эту же задачу. Они больше не отложенные дополнения.

## 1. Решения по продукту

### Проекты и чаты

- Проект = имя + существующая рабочая директория; чат принадлежит одному проекту либо остаётся обычным.
- Сайдбар (последнее уточнение пользователя): Projects сверху, Chats с обычными чатами ниже тонкого разделителя; высота по содержимому и общая прокрутка, без деления пополам. Оба раздела сворачиваются до заголовка, состояние сохраняется. Внутри — раскрываемые проекты, компактные однострочные названия без постоянной даты/HTTP; Show more для длинного списка.
- Добавление проекта, переименование, архивирование/восстановление, создание и открытие чатов внутри него. Архивирование не удаляет файлы или историю, не переносит память в общий раздел; запуск новых работ архивированного проекта требует восстановления. Активная работа завершается в сохранённой папке.
- Проект выбирает область работы, а модели и агенты остаются существующими настройками чата/узлов. Отдельно загружать модель для каждого проекта не нужно.

### Задачи и Workflow

- Workflow остаётся переиспользуемым шаблоном действий без закреплённой директории.
- В форме создания задачи после Workflow добавить поле **Project**: список зарегистрированных проектов с именем и путём; пункт **Без проекта — отдельная папка задачи**; действие **Добавить проект…** с выбором папки.
- Произвольный путь не хранить второй независимой настройкой рядом с projectId: выбранная новая папка регистрируется проектом. Иначе появляются два расходящихся источника рабочей директории.
- У задачи сохраняются projectId и режим доступа; их можно изменить до запуска или между завершёнными запусками. На queued/running/waiting-запуске изменение привязки блокируется. Исторический запуск продолжает показывать собственную папку.
- В карточке задачи и Trace показать проект/папку, режим доступа и «Открыть папку». В Details дать редактировать привязку в разрешённых состояниях; сейчас отдельного редактора этих полей нет.
- Расписания получают тот же выбор проекта и режим доступа, потому что создают такие же задачи. Изменение расписания касается будущих срабатываний.

### Задача без проекта

Рекомендуется постоянная управляемая папка:

```text
<appDataDir>/workspaces/tasks/<taskId>/workspace/
```

Это не системная временная папка. Она создаётся при первом запуске, сохраняет результаты после перезапуска, используется при повторном запуске той же задачи. Новые задачи, включая отдельные срабатывания расписания, получают отдельные каталоги.

В форме достаточно пояснения: «Проект не выбран. Файлы будут сохранены в отдельной папке задачи». После создания/запуска показывать реальный путь. Это штатный режим, не ошибка и не дополнительный диалог подтверждения.

Удаление карточки задачи по умолчанию сохраняет результаты. Сохранённый реестр служебных папок позволяет их найти; README описывает расположение. Автоматическое удаление по TTL и отдельный менеджер очистки в этот scope не входят. Обычные чаты без проекта сохраняют текущую файловую область приложения.

## 2. Исходная точка до реализации (историческая)

1. `CognitiveEngine.process()` вызывает модель, затем executeTools(); результатов инструментов в следующем вызове модели нет (`src/core/CognitiveEngine.ts:63,81`).
2. ToolRegistry выбирает инструмент через matchesIntent(rawInput). FileTool/CommandTool извлекают операции из запроса и текстовых маркеров ответа. Для повторяющихся самостоятельных действий нужен структурированный протокол.
3. buildRuntime регистрирует FileTool с глобальными allowedDirectories и CommandTool с process.cwd(); узлы Workflow получают собственные глобальные пути в конструкторах.
4. Формы задач и расписаний **автоматически передают sessionId открытого чата** (`public/assets/app.js:3145,3207`). AgentNodeExecutor затем использует task.sessionId. Это скрытая связь с настройками/историей случайного чата, которую нужно устранить.
5. WorkflowRunStore сохраняет workflowSnapshot, но не workspace, задачу и настройки выполнения как целостный снимок. WorkflowRunner заново читает изменяемую задачу на каждом шаге.
6. WorkflowRunner.review() для permission-required операции сохраняет approvedOperation и ставит тот же узел в queued. Повторный execute() приемлем для узла из одной сохранённой операции, но не для агента, который уже выполнил несколько действий. Агент должен продолжаться из checkpoint.
7. HTTP-approval находится в ProcessRunRegistry в памяти; одновременно разрешён только один pending approval. Workflow использует durable waiting через run.state. Нельзя заменять сохранённую остановку Workflow ожиданием Promise в HTTP-registry.
8. WorldPartitionMemoryAdapter по умолчанию ищет по пользователю/каналу, а не по проекту. Политика файлов не ограничивает автоматически память.

## 3. Целевая схема данных

Имена ниже — контракт для реализации, а не добавленные типы.

```ts
Project {
  id; name; rootPath; createdAt; updatedAt; archivedAt?;
}

SessionSummary {
  // существующие поля
  projectId?: string;
}

Task / CreateTaskInput {
  // title, description, workflowId, attachments и прочее
  projectId?: string;                // отсутствие = управляемая папка задачи
  accessMode: "ask" | "default" | "full";
  sourceSessionId?: string;          // только явное происхождение/legacy, не рабочая сессия
}

Schedule / CreateScheduleInput / UpdateScheduleInput {
  projectId?: string;
  accessMode: "ask" | "default" | "full";
}

WorkspaceSnapshot {
  version: 1;
  kind: "project" | "task" | "legacy-chat";
  projectId?: string;
  taskId?: string;
  projectName?: string;
  rootPath: string;
  outputDir: string;
  allowedDirectories: string[];
  memoryScope: { kind: "project" | "task" | "legacy"; id: string };
}

WorkflowRun {
  // существующий workflowSnapshot и остальная история
  workspace: WorkspaceSnapshot;
  executionSessionId: string;
  executionSnapshot: { task; settings; accessMode };
}
```

Для PATCH явно различать отсутствие projectId («не менять») и null («Без проекта»). Физический путь управляемой папки генерирует сервер по внутреннему taskId. API не принимает workspace snapshot или доверенные корни из metadata модели/клиента.

Run создаёт собственную executionSessionId, например `workflow-<runId>`: все его узлы могут использовать эту историю, но она не смешивается с пользовательским чатом и не появляется автоматически в Chats. Память самостоятельной задачи может быть общей между её запусками через task scope; сообщения конкретного run остаются отдельными.

Привязка определяется только так:

```text
Чат → session.projectId → Project → WorkspaceSnapshot
Задача → task.projectId → Project → WorkspaceSnapshot
Задача без проекта → taskId → ManagedWorkspaceStore → WorkspaceSnapshot
Запуск Workflow → сохранённый WorkspaceSnapshot → каждый узел/агент/инструмент
```

Провайдерные ключи и секреты в executionSnapshot не сохраняются. Фиксируются выбранные targets, настройки генерации/агентов и права, необходимые для воспроизводимого продолжения; подключение провайдера остаётся ответственностью runtime.

## 4. Общая область работы и разрешения

- WorkspaceResolver вычисляет и проверяет область перед стартом. Для проекта: относительные пути, поиск, cwd и outputDir начинаются в его rootPath. Для задачи без проекта — в её папке.
- Workspace не переключается через process.chdir() или изменение общего runtime.config. Одновременно исполняемые проекты получают разные контексты.
- Во время run действуют сохранённые параметры. Перед файловой операцией/продолжением повторно проверяются доступность и канонический путь. Исчезнувшая папка — явная остановка, без подстановки каталога приложения.
- Ask: чтение внутри области без запроса; изменения, удаления, команды и внешние пути с подтверждением. Default: внутренние чтения/правки без запроса; удаления, команды и внешние пути с запросом. Full сохраняет существующее отсутствие подтверждений.
- Task.accessMode — общий предел полномочий для узлов и их агентов. Новый node option `approval: inherit | always` позволяет узлу потребовать дополнительное подтверждение, но не расширить предел задачи.
- Старое node.config.access=`default` нормализовать как дополнительное подтверждение для write/command; `full` — как inherit, **без обхода политики задачи**. Это явное изменение старого обхода; отразить в документации и тестах. Старые workflowSnapshot физически не переписывать.
- Основной кодовый агент может писать и запускать команды по политике задачи/чата. Советники и участники debate сохраняют роль анализа: read/list/search в той же области, без самостоятельной записи. Полномочия роли задаёт сервер, не prompt модели.
- Зафиксировать конкретные аргументы, канонические пути и содержимое до подтверждения. После него проверить версию изменяемого файла и неизменность пути. Одно разрешение относится к одной операции, не ко всему каталогу.
- Команда с cwd внутри проекта всё равно имеет права OS-процесса приложения. Сохраняются существующие подтверждения/timeout/cancel; sandbox ОС не входит в эту задачу.
- Для изменения одного файла двумя запусками использовать очередь по каноническому пути и expectedVersion/hash внутри проверки-и-записи; конфликт возвращать агенту для повторного чтения. Это предотвращает незаметное затирание в операциях приложения, но не является транзакцией для внешних процессов и команд.

## 5. Самостоятельный агентный цикл — обязательная часть

### Протокол и выполнение

```text
Исходный запрос + проект + история + доступные инструменты
  → модель возвращает tool_call либо final
  → схема и полномочия проверяются сервером
  → точная операция сохраняется, при необходимости ждёт approval
  → операция выполняется, фактический результат добавляется в transcript
  → модель получает результат и выбирает следующий шаг
  → final / остановка / лимит / ошибка
```

Начальный набор инструментов: `file.list`, `file.search`, `file.read`, `file.write`, `file.replace`, `file.append`, `file.mkdir`, `file.delete`, `command.run`. Редактирование существующего файла требует версии/хеша прочитанного содержимого; создание нового — явного условия «файл отсутствует». Поиск/чтение возвращают пути, диапазоны строк, признаки усечения и данные для следующего запроса.

Реализовать общий JSON-протокол поверх существующего LLMService.generateObject(); JSON mode использовать там, где провайдер его объявляет. На первом этапе не требуется переписывать каждый провайдер под его native function calling. Это всё равно реальный цикл действий; обязательна строгая валидация ответа, а качество соблюдения протокола проверяется отдельно на реальной локальной и облачной модели.

Один шаг выдаёт одну операцию либо final. Это упрощает привязку подтверждения и исполнение без повторов. IDs операций назначает сервер. Неизвестные инструменты, некорректные arguments или смешанный ответ не исполняются. Допускается ограниченное исправление формата; нельзя превращать ошибку JSON в запуск текстовой команды.

Служебный structured output и код не пропускать через перевод/нормализацию пользовательского ответа. Финальное сообщение форматировать отдельно. Указания из файлов, результатов поиска, памяти и вложений маркируются как данные: они не изменяют источник пользовательского запроса, выбранную область, список инструментов или права.

### Встраивание в существующие режимы

- General/code получают возможность read → search → edit → verify → final. Модель может сразу завершить обычный разговор без инструментов.
- CodeAgentCoordinator выносит нынешнюю координацию main/advisors из большого buildRuntime.ts и использует AgentLoopRunner. Советники самостоятельно читают/ищут нужные файлы в своих заданиях; основной агент остаётся ответственным за записи и итог.
- Параллельные вызовы моделей допустимы в рамках существующей очереди локальных моделей. Запросы инструментов/подтверждений координируются одной очередью run, поскольку текущий UI показывает одно подтверждение. Сохранённый checkpoint включает фазу координации, завершённые задания и ожидающую операцию каждого участника.
- Hypothesis/support/attack/advisors/judge получают workspace-контекст и ограниченный read/list/search цикл до формирования текущего финального JSON-контракта debate. Существующие verdict/fallback/language проверки сохранить.
- Workflow agent node запускает тот же AgentLoopRunner через движок, с контекстом и политикой своего run.
- После нового цикла **не запускать прежний executeTools() ещё раз по исходному тексту**. Старые маркеры FILE/COMMAND и regex-путь остаются только явно отделённым compatibility-адаптером до миграции существующих тестов/плагинов. Одна операция не должна попадать в оба пути.
- Notion и существующие plugin actions сохранить с прежней политикой и явным пользовательским намерением; не открывать произвольные внешние действия по содержимому прочитанного файла. Подключение всех исходящих MCP-инструментов к агенту не требуется для работы с проектом и в этот scope не входит.

### Ограничения, итог и наблюдаемость

Ввести настраиваемые серверные пределы: суммарное число шагов и вызовов для всего run/его агентов, время активного выполнения, размер чтения/поиска/stdout, объём контекста, число исправлений протокола. Время ожидания пользователя не расходует бюджет активной генерации. Начальные числа выбрать и зафиксировать при реализации по доступному контексту модели; существующий лимит Workflow в 25 узлов не ограничивает шаги внутри Agent node.

Повтор одного безрезультатного запроса учитывается и останавливает зацикливание. Усечённый результат явно сообщает, как запросить следующий диапазон. При переполнении контекста сохранять исходную задачу, workspace, ошибки и последние результаты; не выдавать молчаливое усечение за полное чтение.

Progress показывает наблюдаемые действия: поиск, чтение файла, ожидание разрешения, запись, запуск проверки, итог. Сохранять результаты инструментов и diff независимо от успеха финального LLM-ответа. После частично выполненной работы ошибка/Stop не означает откат: UI перечисляет уже выполненное и оставшееся. Итоговые usage/metrics суммируют весь цикл и участников; промежуточные JSON-запросы не создают десятки отдельных сообщений чата.

## 6. Workflow: пауза, подтверждение и продолжение

Нужны AgentRunStore (transcript/checkpoint) и общий OperationStore (журнал реальных операций). WorkflowRun/NodeRun хранят ссылки на agentRunId, не копии всего transcript в каждой записи nodes.json.

Состояние операции: prepared → waiting_approval / approved → executing → completed / failed; отдельно cancelled/unknown. Проверка и переход статуса выполняются под блокировкой. Сохраняются owner run/agent, аргументы, hash, workspace, результат и одноразовое решение пользователя.

- HTTP-чат может ожидать существующий requestApproval() в текущем процессе; координация нескольких агентов сериализует запросы. При закрытии соединения/Stop отменяются все pending операции этого запроса. После перезапуска чат не должен сам выполнять ранее ожидающую операцию.
- Workflow агент сохраняет checkpoint и возвращает `needs_input`, переводя run в waiting без живого Promise. Trace показывает точную операцию.
- Approve продолжает тот же agentRun с ожидающей операцией; не повторяет ранее завершённые шаги модели/инструментов и не пересоздаёт план.
- API review принимает approvalId/operationId (для human_review — идентификатор ожидающего node run), чтобы запоздалый повторный клик не подтвердил уже следующую операцию. Текущее `{approved:true}` без идентификатора для многошагового агента недостаточно.
- Reject для agent operation возвращает агенту отрицательный результат; он может выбрать разрешённый альтернативный шаг или завершиться. Отказ не даёт права повторять тот же запрос бесконечно. Семантика отдельного human_review узла и его переходов сохраняется.
- Step для Agent node означает выполнение внутреннего цикла до final/approval/лимита, а не один LLM-запрос. При waiting граф Workflow не переходит к следующему узлу.
- После рестарта waiting checkpoint можно продолжить. Running без незавершённого эффекта переводится в interrupted с явным Resume. Если процесс упал между выполнением команды и сохранением результата, операция становится unknown; её нельзя автоматически повторить. Полную exactly-once гарантию для произвольной команды обеспечить таким журналом нельзя.
- ScheduleRunner не должен автоматически дублировать неопределённую операцию при восстановлении срабатывания. Состояние waiting/interrupted/unknown остаётся видимым пользователю.

## 7. Память, просмотр файлов и совместимость

- Scope долговременной памяти: пользователь + канал + projectId; для отдельной задачи — taskId. История сообщений остаётся по executionSessionId/sessionId. Совпадение папок или имён не объединяет память разных сущностей.
- Обычные чаты не получают проектную память автоматически. Старые записи без scope остаются в legacy-области. В этот релиз не включать перенос существующих чатов между проектами, чтобы не требовать неоднозначной массовой перемаркировки памяти.
- WorldPartitionMemoryAdapter/Store обновляют partition/query/delete вместе: удалённые записи не должны оставаться доступными через общий проектный индекс. LocalJsonMemoryAdapter проверяет scope вместе с actor. OpenMemory сейчас не реализует query/recent — сохранить это ограничение, не обещать полноценный recall через него.
- Review/Open in editor/Reveal разрешают путь по владельцу sessionId либо runId/taskId. Не добавлять все зарегистрированные проекты в общий allowlist. Завершённая разрешённая операция вне корня остаётся основанием просмотра именно для своего владельца.
- Новые задачи не наследуют активный чат. Для старых task.sessionId сохранить происхождение в sourceSessionId; выбранные модели/настройки можно перенести в отдельную execution-сессию при первом новом run, но не общую историю, workspace или неявный Full. В UI отметить старую связь, если она показывается.
- Старые завершённые run остаются историей без выдуманного workspace. Старые незавершённые run без снимка не продолжать автоматически в новом каталоге: показать «Нужно выбрать рабочую папку», сохранить ранее записанные absolute approvals и потребовать новое разрешение, если операция/область изменились. Старые queued задачи получают явный выбор/managed default на следующем новом запуске.
- Изменение Project.rootPath не перемещает файлы. Разрешать замену папки только при отсутствии незавершённых привязанных запусков; недоступную старую папку показать как ошибку. Снимки прошлых run неизменяемы.

## 8. Файлы реализации — добавить

Все пути в этой секции — **планируемые новые файлы**, не уже существующая реализация.

| Новый файл | Ответственность |
| --- | --- |
| `src/projects/types.ts` | Project, входные данные/ошибки/статус архива. |
| `src/projects/ProjectStore.ts` | projects.json, атомарные записи/очередь, чтение старой/повреждённой структуры без потери данных. |
| `src/projects/ProjectService.ts` | Проверка имени/realpath/директории, уникальность канонической папки, rename/archive/restore/relink и блокировки активных запусков. |
| `src/workspace/types.ts` | WorkspaceSnapshot, ссылки владельца, memory scope, политика выполнения. |
| `src/workspace/WorkspaceResolver.ts` | Разрешение контекста чата/задачи, проверка снимка run; без изменений глобального cwd. |
| `src/workspace/ManagedWorkspaceStore.ts` | Стабильная папка задачи, реестр созданных папок и их владельцев, сохранение пути после удаления карточки. |
| `src/api/projectControllers.ts` | Проектные API; bootstrap использует тот же сервис. |
| `src/agents/runtime/types.ts` | AgentTurn, AgentRun, transcript, checkpoint, budget, outcome, ссылки на операции. |
| `src/agents/runtime/AgentTurnProtocol.ts` | JSON-схемы tool_call/final, сериализация результатов модели, bounded repair; без эвристического исполнения текста. |
| `src/agents/runtime/AgentLoopRunner.ts` | Цикл вызовов, фактические результаты, лимиты, остановка, checkpoint/resume, финальный outcome. |
| `src/agents/runtime/AgentRunStore.ts` | Сохранение состояния/трассы по runId, версия формата, восстановление после перезапуска. |
| `src/agents/code/CodeAgentCoordinator.ts` | Нынешняя координация main/advisors, адаптированная к циклам и сохранению фаз. |
| `src/prompts/agentLoopPrompts.ts` | Инструкции протокола, общий workspace-блок, отделение файловых данных от запроса, описания capabilities. |
| `src/tools/AgentTool.ts` | Типизированные схемы действий/результатов, role capabilities и ошибки, независимые от текстового ответа. |
| `src/tools/WorkspaceFileService.ts` | Общие list/read/search/write/replace/append/mkdir/delete, лимиты, версии, diff; используется чатом и Workflow. |
| `src/tools/OperationExecutor.ts` | Подготовка точной операции, доступ/подтверждение, последовательность эффектов, revalidation и журнал. |
| `src/tools/OperationStore.ts` | Prepared/approved/executing/completed/unknown; одноразовые решения и результаты для восстановления. |
| `public/assets/projects-ui.js` | Секция Projects, диалог создания/редактирования, общий селектор проекта для задачи/расписания. |
| `public/assets/projects.css` | Компактные строки, вложенность, секции, форма/селектор и адаптивные состояния. |

Не создавать вторую независимую систему файловых разрешений для агентного цикла. OperationExecutor использует существующий AccessPolicy, расширенный на общий ExecutionPolicy.

## 9. Файлы реализации — изменить

### Данные, runtime и API

| Существующий файл | Конкретная доработка |
| --- | --- |
| `src/types/index.ts` | projectId у сессии/actor, workspace/policy у ExecutionContext, внутренний execution origin у ProcessInput, agent/tool progress, ссылки на сохранённую трассу и partial outcome. |
| `src/session/SessionIndexStore.ts` | get(), сохранение projectId на create/touch/rename, атомарная запись; старые чаты без проекта. |
| `src/session/SessionSettingsStore.ts` | Создание независимых настроек execution-сессий, наследование без переноса workspace/скрытого Full из другого проекта. |
| `src/config/config.ts` | Корень managed workspaces/agent runs и серверные лимиты; appDataDir по-прежнему источник хранения. |
| `src/index.ts`, `src/mcp.ts` | Оба entry point создают/получают общие stores/resolver до сборки engine; корректно восстанавливать interrupted/waiting операции, не запускать эффекты автоматически из MCP bootstrap. |
| `src/app/RuntimeManager.ts` | Сохранить application-lifetime stores/исполнения при пересборке runtime; не сбрасывать проекты/checkpoints. |
| `src/app/buildRuntime.ts` | Внедрение resolver/runner/executor, общий FileService для чата/Workflow, вынести code coordinator; не привязывать инструменты к process.cwd(). |
| `src/api/controller.ts` | bootstrap.projects, создание project session, agent progress/partial results, файловые действия по owner context. |
| `src/api/routes.ts` | Подключить project routes, owner-aware file/task workspace/trace/resume API. |
| `src/api/ProcessRunRegistry.ts` | Очередь approval через execution coordinator, несколько последовательных операций, привязка к run/agent/op; корректный Stop всей группы. |
| `src/api/workspaceReview.ts` | Разрешение/просмотр/редактор по session либо Workflow run, общий canonical path и операция-основание. |
| `electron/main.cjs` | Отдельный project directory picker с assertAppSender; cwd приложения при переключении проектов не менять. |
| `electron/preload.cjs` | Узкий desktopProjects bridge выбора директории; не давать renderer универсальный FS/command API. |

### Модели, инструменты и память

| Существующий файл | Конкретная доработка |
| --- | --- |
| `src/core/CognitiveEngine.ts` | Подготовка workspace/policy/memory до вызова агента; AgentLoopRunner вместо post-response файлового исполнения; сохранить фактические инструменты при частичном сбое; одна финальная запись и ответ по requestId. |
| `src/core/Router.ts` | Расширить контракт ModeHandler на outcome с финальным результатом, tool trace или сохранённой паузой; не смешивать paused с ошибкой модели. |
| `src/core/ToolRequestBuilder.ts` | Оставить совместимость явно вызываемых старых plugins; не использовать текст ответа как новый план файловых действий. |
| `src/core/AgentProgressReporter.ts`, `src/core/ResponseFormatter.ts` | Шаги/ожидание/частичные результаты и суммарные метрики без ложного «всё выполнено». |
| `src/tools/Tool.interface.ts`, `src/tools/ToolRegistry.ts` | Регистрировать и разрешать структурированные действия с валидацией/capabilities; старый matchesIntent отделить от нового протокола. |
| `src/tools/FileTool.ts` | Тонкий адаптер к WorkspaceFileService/OperationExecutor, сохранить review/diff-совместимость; удалить глобальные допущения для текущей папки/scaffold. |
| `src/tools/CommandTool.ts`, `src/utils/runCommand.ts` | Structured command с executable/args/cwd из workspace, ограничения вывода/timeout/cancel; вывод возвращается модели; сохранённую команду не повторять после unknown. |
| `src/tools/AccessPolicy.ts` | Общая policy без обязательного чтения sessionSettings, canonical path, Ask/Default/Full, дополнительное подтверждение узла. |
| `plugins/file/index.ts` | Не перерегистрировать FileTool с глобальными root; использовать тот же общий сервис/контекст. |
| `src/plugins/types.ts`, `src/plugins/PluginLoader.ts` | Передать общие tool services через PluginContext/регистрацию и сохранить совместимость старых plugins; не позволять второй регистрации вернуть глобальные пути файловому инструменту. |
| `src/prompts/common.ts`, `src/prompts/codeAgentPrompts.ts` | Workspace-контекст и агентный протокол; финальное форматирование отдельно от инструментов; сохранить пользовательский язык. |
| `src/agents/HypothesisAgent.ts`, `src/agents/SupportAgent.ts`, `src/agents/AttackAgent.ts`, `src/agents/HypothesisAdvisorAgent.ts`, `src/judge/Judge.ts` | Read/search-фаза с общим runner и той же областью; сохранить существующие structured debate результаты/fallback. |
| `src/llm/LLMService.ts` | Отдельный путь структурированного agent turn с сохранением сырого ответа для валидатора, не переведённого/искажённого action payload. |
| `src/llm/OutputSanitizer.ts`, `src/llm/LanguageEnforcer.ts` | Чётко отделить финальный текст от JSON действий/файлов: изменение реализации только если требуется для этого разделения. |
| `src/memory/MemoryService.ts`, `src/memory/MemoryAdapter.ts` | Scope в retrieve/save/recent/delete; инструментальная трасса не заменяет долговременную память и не загружается целиком в каждый prompt. |
| `src/memory/WorldPartitionMemoryAdapter.ts`, `src/memory/WorldPartitionStore.ts` | Проектные/task partitions, фильтрация legacy и удаление по сессии внутри общего partition. |
| `src/memory/LocalJsonMemoryAdapter.ts`, `src/memory/OpenMemoryAdapter.ts` | Scope-aware сохранение/выборка; сохранить объявленные ограничения OpenMemory. |

Провайдерные adapters OpenAICompatible/Anthropic/Gemini/Ollama/LlamaCpp и загрузчики моделей не требуют общей переписи: первый протокол строится поверх их существующего текстового/JSON интерфейса. Корректировки конкретного adapter делать только при обнаруженной несовместимости и с проверкой на нём.

### Tasks, Workflow и расписания

| Существующий файл | Конкретная доработка |
| --- | --- |
| `src/tasks/types.ts` | projectId, accessMode, sourceSessionId и типизированный PATCH с null для отвязки. |
| `src/tasks/TaskStore.ts` | Сохранять новые поля, нормализация legacy, не позволять изменять execution привязку активного run. |
| `src/tasks/TaskService.ts` | Валидация проекта/статуса, общий lock при изменении и старте, managed workspace, удаление карточки без удаления результатов. |
| `src/api/taskControllers.ts` | Принимать/обновлять projectId/accessMode; endpoint получения/открытия рабочей папки по taskId, без клиентского доверенного rootPath. |
| `src/workflows/types.ts` | workspace/executionSnapshot/executionSessionId, agentRunId у node trace, ожидание точной операции и interrupted/unknown представление. |
| `src/workflows/WorkflowRunStore.ts` | Атомарный снимок исполнения при createRun, ссылки на checkpoints и идентичность ожидания. |
| `src/workflows/WorkflowRunner.ts` | Контекст из снимка, продолжение agent checkpoint при approval, восстановление, защита от повторного эффекта; workflow-граф продолжается после завершения Agent node. |
| `src/workflows/nodes/NodeExecutor.ts` | Workspace/policy/operation owner и checkpoint hooks в NodeExecutionContext. |
| `src/workflows/nodes/AgentNodeExecutor.ts` | Собственная execution-сессия run, общий loop, возвращение needs_input вместо permission failure, resume по agentRunId. |
| `src/workflows/nodes/FileSearchNodeExecutor.ts` | Использовать общий поиск в context.workspace; убрать root из глобального конструктора, вернуть прежний формат matches. |
| `src/workflows/nodes/SaveFileNodeExecutor.ts` | Общие запись/версия/разрешение; сохранить template/path/append и artifacts. |
| `src/workflows/nodes/CommandNodeExecutor.ts` | Общий исполнитель команд; cwd из snapshot, frozen proposal и вывод для следующих узлов. |
| `src/workflows/nodes/WorkflowPathPolicy.ts` | Тонкий wrapper общего canonical policy либо удалить после переноса вызовов; отдельной лексической проверки не оставлять. |
| `src/workflows/template.ts` | Переменные workspace.rootPath, workspace.outputDir, project.id/name; task берётся из executionSnapshot. |
| `src/workflows/WorkflowStore.ts`, `src/workflows/defaultWorkflows.ts` | Валидация новых node approval полей, limits/настроек Agent node; совместимость существующих графов и переходов. |
| `src/api/workflowControllers.ts` | Review с идентификатором ожидания, trace внутреннего агента, Resume interrupted run; различать human review и tool approval. |
| `src/schedules/types.ts`, `src/schedules/ScheduleStore.ts` | Сохранение projectId/accessMode и явной legacy-нормализации. |
| `src/schedules/ScheduleService.ts` | Валидация проекта и перенос projectId/accessMode в каждую созданную задачу, независимая execution-сессия. |
| `src/schedules/ScheduleRunner.ts`, `src/api/scheduleControllers.ts` | Восстановление без повторов unknown, новые create/update поля и состояния ожидания. |
| `src/transports/shared/runtimeActions.ts` | Разрешать workspace на сервере по session, сохранять связь при touch, не доверять metadata. |
| `src/transports/mcp/tools.ts`, `src/transports/telegram/TelegramBotTransport.ts` | Использовать тот же engine/context и отображать permission-required при отсутствии UI; не исполнять действия без обработчика approval автоматически. |

### Интерфейс и документация

| Существующий файл | Конкретная доработка |
| --- | --- |
| `public/assets/app.js` | Projects state/bootstrap, contextual new chat, empty project, компактный sidebar; Task/Schedule selector и права; убрать автоматический activeSessionId; редактирование project в Details; trace/approval/resume/папка результатов. |
| `public/assets/app.css`, `public/assets/liquid-glass.css` | Согласовать старые sidebar-переопределения с projects.css; общая прокрутка stacked секций, длинные названия, keyboard focus/scale. |
| `public/index.html` | Подключить projects.css; JS импортируется из app.js. |
| `public/assets/review-panel.js` | При необходимости передавать owner run/task для просмотра файлов из Trace; сохранить chat-local состояние. |
| `frontend/workflow/WorkflowEditor.tsx` | Подсказки «папка берётся из задачи», переменные workspace, agent limits/approval inheritance; выбор проекта в редактор графа не добавлять. |
| `frontend/workflow/types.ts`, `frontend/workflow/workflowAdapter.ts` | Передать новые trace/approval поля только там, где использует редактор; не сохранять конкретную папку в graph definition. |
| `README.md` | Проекты/managed folders, работа цикла, режимы прав задач, waiting/resume/unknown, совместимость старых узлов. |

`frontend/workflow/workflow.css` менять только при необходимости новых элементов inspector. Текущие сторонние незакоммиченные правки не откатывать.

## 10. API-контракт первого релиза

| Метод/маршрут | Назначение |
| --- | --- |
| GET/POST `/projects` | Список / регистрация папки проекта. |
| PATCH `/projects/:id` | Имя, архив/восстановление, проверяемая замена папки без активных запусков. |
| POST `/sessions` | `{title, projectId?}`; связь фиксируется сервером. |
| POST/PATCH `/tasks[/:id]` | projectId/null, accessMode; sourceSessionId только как явно заданное происхождение. |
| GET `/tasks/:id/workspace`, POST `/tasks/:id/workspace/reveal` | Показать место результатов/открыть папку; до первого запуска вернуть planned path, при открытии можно создать её явно. |
| POST/PATCH `/schedules[/:id]` | projectId/null, accessMode для будущих запусков. |
| GET `/workflow-runs/:id` | Снимок workspace, состояние и компактная трасса со ссылкой на агентные шаги. |
| GET `/workflow-runs/:id/agent-runs/:agentRunId` | Постраничные наблюдаемые шаги/результаты; проверить принадлежность run. |
| POST `/workflow-runs/:id/review` | approved + waiting/operation ID; повтор не подтверждает следующую операцию. |
| POST `/workflow-runs/:id/resume` | Продолжить проверенный checkpoint; unknown-effect требует разрешения неопределённости, а не автоматического повторного исполнения. |

Существующие `/process`, progress/cancel/review маршруты чата сохраняются с расширением данных. Финальное имя новых маршрутов можно уточнить при кодировании, сохранив описанную семантику.

## 11. Порядок работ и критерии готовности

1. **Project/Workspace foundation.** Stores/types/API, resolver, managed task folders, snapshots и legacy-нормализация. Готово: два проекта и задача без проекта сохраняют разные стабильные корни после перезапуска.
2. **Общие инструменты/доступ.** Typed operations, единые пути, journal, file versions и approval. Готово: чат и отдельный Workflow file/command node применяют одну область и не обходят политику задачи.
3. **Agent loop.** Протокол, runner/store/coordinator, все нужные режимы и роли, progress/limits. Готово: агент на fixture сам находит и читает файл, делает обусловленную прочитанным правку, получает проверку и формирует итог.
4. **Workflow integration.** Run snapshot/session, checkpoint-based waiting/resume, Task/Schedule project propagation, recovery. Готово: approval внутри третьего шага агента не повторяет первые два, включая перезапуск приложения.
5. **UI.** Projects/sidebar/dialog, Task/Schedule selector, managed-folder hints, trace/approve/resume и просмотр результатов. Готово: все пути пользовательского выбора доступны без обращения к API вручную.
6. **Память/миграция/приёмка.** Scope уже должен передаваться с этапа 1; здесь завершаются migration/delete/recovery и проверки всей цепочки. Не выпускать промежуточный вариант с общей памятью проектов.

Части можно оформлять отдельными последовательными PR/коммитами, но завершение текущего scope требует всех шести этапов. Число новых файлов не является оценкой трудоёмкости: наиболее сложны протокол цикла и безопасное продолжение после эффектов.

## 12. Проверки

Добавить целевые suites:

- `test/projects.test.ts`: stores/API, create/archive/relink, старая схема сессий, realpath/дубликаты/недоступная папка.
- `test/workspace-context.test.ts`: параллельные A/B, managed task root, переключение UI, отсутствие доверия metadata, runtime reload.
- `test/agent-loop.test.ts`: scripted provider → list/search/read → edit → verification → final; ошибки schema/tool, лимиты, отказ, Stop, частичный результат и правильная сумма usage.
- `test/agent-recovery.test.ts`: completed действия не повторяются, waiting переживает рестарт, дубли review не подтверждают следующий шаг, executing без результата становится unknown.
- `test/project-workflow.test.ts`: один шаблон для A/B/без проекта, snapshot между шагами, собственная session, все file/command nodes, расписания, ожидание внутри Agent node.
- `test/project-memory.test.ts`: project/task scope, legacy isolation, удаление сессии из project partition, отсутствие доступа обычного чата к проектным данным.
- `test/projects-ui.test.ts`: создание/выбор/архив, компактные строки, Show more/less, общая прокрутка и сохранение collapse/focus/mobile menu; Task/Schedule selection и hint; отсутствие неявного activeSessionId.

Расширить существующие `chat-access`, `review-panel`, `engine`, `prompts`, `process-run`, `workflowToolNodes`, `workflows`, `orchestration-regressions`, `schedules`, `worldPartitionMemory`, `runtimeManager`, `chat-ui-regressions` проверки. Существующие voice/attachments/model tests должны оставаться зелёными.

После локальных целевых проверок — `npm test`. Затем визуальная проверка Electron и browser на реальной форме/сайдбаре: длинные названия, пустые проекты, увеличенный шрифт, переключение с диктовкой/черновиком, pending approvals, просмотр результатов.

Отдельная реальная приёмка на одной установленной локальной модели и одном настроенном облачном провайдере: несколько шагов инструментов, отказ/сбой, итог по реально выполненным действиям. Если доступного провайдера нет, отметить эту проверку как не выполненную; scripted тесты не доказывают качество поведения модели.

## 13. Что не входит

Git worktrees/branches, автоматическое создание/клонирование репозиториев, sandbox ОС, отдельная модель на каждый проект, синхронизация проектов, массовый перенос старых чатов между проектами, автоматическая очистка результатов, native tool calling для каждого провайдера и подключение всех сторонних MCP-tools.

Scope покрывает реальные локальные действия и самостоятельное исследование проекта; он не обещает полный набор возможностей Codex.

Исследование выполнено по исходному коду и существующим тестам. В этом ходе добавлен документ и ссылка из предыдущего исследования. Код приложения и тесты не запускались/не изменялись.
