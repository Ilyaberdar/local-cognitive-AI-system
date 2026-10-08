# Local Cognitive: аккаунт, Remote Connection, Usage, баг-репорты и обновления

Дата: 7 октября 2026. Статус: единый план реализации по запросу владельца продукта.
Текущее состояние сверено с кодом на `4671a02`; описанные ниже новые возможности
не считаются реализованными. Команды новой CLI и новые пути — целевой контракт.

Этот документ заменяет прежние разрозненные планы по account login и Remote.
Он определяет следующую поставку; ограничения исторического Settings scope
«account/remote unavailable» не запрещают описанные здесь работы.

## 1. Что именно строим

Пользователь устанавливает **Local Cognitive Server** на мощную домашнюю
AI-станцию либо арендованную GPU-машину. Сервер работает без Electron и экрана,
показывает одноразовый ключ подключения. На другом компьютере пользователь
входит в аккаунт Local Cognitive, нажимает отдельную кнопку **Remote → Connect**
и вставляет ключ. Привычный UI начинает управлять выбранным сервером.

Модели скачиваются на сервер, занимают его RAM/VRAM и выполняют inference там.
Там же находятся чаты, проекты, файлы, агенты, workflow/FSM, задачи, расписания,
плагины и их credentials. Клиент отображает состояние и отправляет команды.
Закрытие клиента или потеря сети не отменяет принятую сервером работу.

Это удалённое управление приложением Local Cognitive через его API. Передача
изображения рабочего стола ОС, RDP/VNC и отдельный SSH-клиент не требуются.
Обычного доступа к чужому LLM API недостаточно: на выбранной машине должен
работать наш backend, владеющий всем перечисленным состоянием.

| Решение | Принято для плана |
| --- | --- |
| Вход | Email + пароль с подтверждением адреса и Google. Под «Gmail» понимается вход через Google, без разрешений на почтовый ящик |
| Apple | Следующий auth-provider после настройки Apple Developer; не блокирует первый сквозной Remote |
| Доступ к Remote | Только после входа в аккаунт; Local работает без аккаунта |
| Первый клиент | Существующее desktop-приложение с отдельной кнопкой Remote |
| Поставки | Два desktop-билда (macOS и Windows) и Linux server daemon. UI в обычном браузере на localhost не поддерживается: UI живёт только в Electron |
| Связь UI и локального runtime | IPC: renderer → preload → main → тот же диспетчер операций, что обслуживает Remote. Отдельный HTTP-порт приложения для UI не нужен |
| Первый сервер | Headless Linux x64 на машине с одной или несколькими NVIDIA GPU, включая проверенный CUDA inference; native Node/systemd и Docker GPU |
| GPU | Минимальная реализация: приоритет всегда GPU, CPU как остаток или fallback; несколько одновременно загруженных моделей распределяются по GPU (раздел 5.1) |
| Сеть | Исходящие WSS/443 от клиента и сервера к нашему relay, без настройки port forwarding |
| Доверие | Одноразовое приглашение, проверка ключа host, ключ устройства и отзываемый grant |
| Содержимое туннеля | E2EE между устройством и host; Cloud хранит аккаунты и метаданные доступа |
| Полнота | Все поддерживаемые сервером предметные экраны приложения; платформенные действия описаны в разделе 8 |
| Дальнейшие клиенты | Mobile позже использует тот же RuntimeClient и протокол; мобильное приложение сейчас не разрабатываем. Web-клиент не планируется |
| Дополнительные механики | Usage, завершение OAuth плагинов, Report a bug, desktop/server updates включены в этот план |
| Хосты (8 октября) | Приоритет — headless Linux-сервер (проверка на машине с Fedora). Обычное desktop-приложение как хост для Windows/macOS (переключатель «Разрешить удалённое подключение», трей, автозапуск, готовая Windows CUDA-сборка llama.cpp) — следующий шаг, чтобы пользователю не требовались WSL или отдельный Linux |
| Решения 8 октября | Собственная реализация Noise для production **не одобрена**: E2EE строится на проверенной реализации, вариант выбирается в начале R3. Блокировка data root включена сразу: MCP stdio до моста R2 работает со своей папкой данных. Cloud — Node 24 с прогоном тестов на нём; desktop и server — Node 22 (Electron 35) |
| Решения R3 (8 октября) | E2EE — **TLS 1.3 с взаимной аутентификацией** (node:tls, OpenSSL/BoringSSL) поверх WebSocket через relay, раздел 6.3. Ключ устройства и pins хранятся по `accountId`: выход из аккаунта закрывает Remote, но не удаляет их, повторный вход в тот же аккаунт не требует pairing. Порядок: R3 — pairing, relay, E2EE и UI Remote в desktop-приложении (Connect, ввод ключа, статус host, Disconnect/Forget, устройства и Revoke); R4 — надёжный удалённый чат; R5 — все экраны на выбранном host |

Один host принадлежит одному продуктовому аккаунту. Аккаунт может иметь несколько
hosts и доверенных устройств; одно окно UI выбирает один host. Принадлежность
аккаунту сама по себе не выдаёт новому устройству доступ к машине.

## 2. Три части системы и владение данными

```text
Desktop UI (macOS / Windows) / будущий Mobile
  ├─ browser login ───────────────► Auth0 (Google / email / позже Apple)
  ├─ HTTPS: профиль, hosts ───────► Cloud API ──► PostgreSQL
  └─ WSS: E2EE-команды/ответы ───► Relay ◄── исходящее WSS ── Host agent
                                                              │
                                                    Local Cognitive Runtime
                                                    чаты / FSM / tools / files
                                                              │
                                                    llama.cpp CUDA / модели
```

| Компонент | Ответственность |
| --- | --- |
| Client shell | Bundled UI, аккаунт устройства, соединение, локальные настройки интерфейса, микрофон, обновление клиента |
| Cloud API | Identity mapping, реестр hosts/devices, билеты соединений, отзыв, usage ingestion, баг-репорты |
| Relay | Пересылка зашифрованных кадров, маршрутизация, ограничение очередей и трафика |
| Host agent | Регистрация host, приглашения, локальный список доверенных устройств, E2EE и проверка команд |
| Runtime | Единственный исполнитель и владелец состояния конкретной машины; используется существующее ядро |

Cloud API и relay сначала размещаются одним модульным Node/TypeScript-сервисом
`apps/cloud` за HTTPS/WSS reverse proxy. PostgreSQL — для cloud-данных, SQLite —
для новых долговечных host runs/messages/commands/usage. Существующие предметные
stores мигрируются постепенно. Redis и отдельные микросервисы на старте не нужны.
Проверено 7 октября: встроенный `node:sqlite` работает внутри Electron 35 из
проекта (с `ExperimentalWarning`), нативный модуль с пересборкой под Electron не
нужен. В R0 остаётся проверить WAL и запись при работающем MCP bridge.

Чаты, файлы и веса моделей постоянно хранятся на host. Cloud видит account/host/
device IDs, адреса соединений, время и объём трафика; E2EE не скрывает эти
метаданные. Usage и диагностика передаются в Cloud отдельно по описанным ниже
правилам. Выключенный host не исполняет новые команды и не выдаёт свежую историю.

## 3. Что уже есть и что действительно менять

| Подтверждено кодом | Следствие |
| --- | --- |
| [src/index.ts](../src/index.ts) экспортирует `startBackend`, `npm start` запускает Node без Electron | Переиспользуем backend; добавляем server packaging, CLI, vault, host agent и отдельный lifecycle |
| [electron/main.cjs](../electron/main.cjs) всегда запускает backend внутри main и раздаёт UI с localhost | Выделяем client shell и supervisor; Remote может запускаться без локального inference |
| [src/api/routes.ts](../src/api/routes.ts) использует `localApiOriginGuard` | Локальные маршруты не являются публичным Remote API; guard сохраняется |
| [src/api/controller.ts](../src/api/controller.ts) отменяет `/process` при disconnect | Добавляем независимый RunService и API принятия команды; одного WSS-прокси недостаточно |
| [ProcessRunRegistry](../src/api/ProcessRunRegistry.ts) хранит Map, прогресс, approval callbacks; дубликат ID возвращает 409 | Это не долговечный run/result store и не механизм идемпотентного повторения |
| [WorkflowEventStore](../src/workflows/WorkflowEventStore.ts) уже хранит ограниченный JSONL-журнал; workflow API умеет SSE/replay | Сохраняем работающую основу, дополняем восстановление; не объявляем все события отсутствующими |
| Чат читается из memory через `createGetSessionMessagesController` | Долговечные messages отделяем от semantic memory с сохранением старой истории |
| Bootstrap/settings возвращают AppSettings | До remote-доступа вводим DTO с write-only secrets, включая ответы обновления и ошибки |
| [model-manager.js](../public/assets/model-manager.js) и [workflow-live.js](../public/assets/workflow-live.js) сами создают EventSource; есть прямые Electron IPC | Переводим все запросы, подписки и native actions на общий выбор host |
| [EncryptedCredentialVault](../src/plugins/EncryptedCredentialVault.ts) использует внедряемый cipher; Electron передаёт safeStorage | Переиспользуем интерфейс, добавляем headless cipher без plaintext fallback |
| [runtime-manifest.json](../resources/llama/runtime-manifest.json) содержит Linux CPU со статусом not tested | Linux CUDA требуется добавить и проверить на реальной GPU; CPU-тест не закрывает Remote |
| Account/Usage пока заглушки, [Logger](../src/utils/Logger.ts) пишет в console; updater в dependencies отсутствует | Это реальные новые модули, а не подключение готового backend |

Не требуется переписывать приложение на другой UI-framework, заменять FSM,
выбрасывать PluginManager или делать новый движок inference. Основные изменения:
identity, lifetime исполнения, transport, DTO и платформенные адаптеры.

## 4. Вход и возврат в приложение

1. Settings → Account открывает Auth0 Universal Login в системном браузере.
2. Desktop — public OAuth client: Authorization Code + PKCE S256, state и OIDC
   nonce; client secret в дистрибутив не помещается. Listener открывается до
   браузера, только на loopback; redirect URI заранее зарегистрирован. Занятый
   порт даёт понятную ошибку, без перехода на произвольный callback.
3. Email/password signup требует подтверждения email. Для OTP настраиваются
   Universal Login, Flexible Identifiers и Identifier-First. Неверифицированный
   email не получает remote grant даже при наличии валидного login token.
4. Cloud проверяет issuer, audience, подпись/JWKS, expiry и требуемые claims;
   сопоставляет `(issuer, subject)` с внутренним `accountId`. Email не служит ID.
   Связывание Google/email/Apple требует подтверждения обоих способов входа,
   автоматического merge по совпавшему адресу нет.
5. Refresh credentials и device private key находятся в OS secure storage;
   access token — в main/connection service. Renderer получает безопасный
   профиль и статусы. Refresh сериализуется; logout отзывает сессию, закрывает
   Remote и очищает credentials/кэш этого аккаунта. Ошибка сетевого revoke
   не мешает немедленно очистить локальную сессию.
6. После успешного обмена и сохранения браузер показывает `You’re signed in`
   и кнопку **Open Local Cognitive**. Приложение также может само получить фокус.
   Используем зарегистрированный `localcognitive://auth/complete/<attemptId>`:
   только непрозрачный короткоживущий ID, никаких OAuth codes/tokens. Ссылка
   фокусирует приложение и обновляет статус; сама по себе не авторизует.
7. Реализация R1: loopback `http://127.0.0.1:17850/callback`, сессия в ключе
   `account/session` того же защищённого vault, access token только в памяти main.
   Вход завершается только после `GET /v1/me` (Cloud сопоставил identity с аккаунтом).
   Выход не открывает браузер: каждый интерактивный вход идёт с `prompt=login`, поэтому
   после выхода можно войти другим аккаунтом. Подтверждённый email приходит в access
   token через Auth0 Post-Login Action (namespaced claims `https://local-cognitive.com/`).

Один renderer не может попросить произвольный `shell.openExternal`, URL, путь или
чужой credential. macOS `open-url`, Windows/Linux `second-instance` и cold start
обрабатывают только разрешённые deep links. Есть fallback «Вернитесь в приложение».
Headless host не получает пароль или пользовательский refresh token.

`localProfileId` и локальная история сохраняются. Вход в аккаунт не вызывает
`RuntimeManager.switchIntegrationOwner`: нынешние plugin connections остаются
связаны со своим runtime. Первый claim существующего host явно даёт владельцу
доступ к его данным; перенос host другому аккаунту требует действий администратора.

Основания: [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html),
[Auth0 verification](https://auth0.com/docs/manage-users/user-accounts/verify-emails).

## 5. Установка и работа сервера

Сервер поставляется как backend + host agent + CLI + inference runtime. Установка
из Git остаётся полноценным способом; Docker — дополнительная воспроизводимая
поставка, особенно для арендуемой Linux GPU-машины. Версии Node и native-модулей
закрепляются в CI и образе после проверки совместимости, а не берутся произвольно.

Целевой CLI после реализации (сейчас этих команд нет):

```sh
# В release checkout после npm ci и сборки:
local-cognitive-server init --data-dir /srv/local-cognitive
local-cognitive-server start --data-dir /srv/local-cognitive --inference cuda
# Первый интерактивный старт выводит приглашение; повторное выдаётся явно:
local-cognitive-server connect-key
local-cognitive-server status
local-cognitive-server devices
local-cognitive-server revoke-device <device-id>
local-cognitive-server drain
```

`init` создаёт закрытые каталоги, host identity и конфигурацию. `start` поднимает
один runtime, scheduler и исходящий relay connection. После установки systemd
service стартует после reboot без GUI. CLI обращается к тому же процессу через
защищённый Unix socket; не создаёт второй RuntimeManager на том же data root.

| Область | Требование |
| --- | --- |
| Данные | Явные постоянные каталоги app/memory/sessions/output/models вне release directory, backup и миграции |
| Single writer | Lock всего data root; второй backend/MCP writer отклоняется, bridge использует действующий runtime |
| Secrets | Headless vault с AEAD и master key из secret mount/защищённого файла вне backup с ciphertext; права 0600, без требования Electron |
| Сеть | Runtime и llama-server только loopback/private socket; наружу исходящее HTTPS/WSS. Cloud не получает model API port |
| GPU | Отдельный Linux CUDA artifact и backend selector: platform/arch недостаточно, CPU и CUDA должны сосуществовать. В закреплённом релизе llama.cpp b10809 готовой Linux CUDA-сборки нет (есть CPU, Vulkan, ROCm, SYCL; CUDA только для Windows). Решение R0: в CI собираем только модуль `libggml-cuda.so` (CUDA 12.8.1, тот же коммит, `GGML_BACKEND_DL`) и накладываем его на проверенную по sha256 CPU-сборку upstream вместе с `libcudart`/`libcublas`/`libcublasLt`, как upstream делает для Windows CUDA. Одна сборка для native и Docker (`nvidia/cuda:12.8.1-base`); требуется драйвер NVIDIA ≥ 570.26, glibc ≥ 2.34. Официального образа `server-cuda` для b10809 нет. CPU-сборка остаётся рядом как fallback; переход на CPU виден пользователю. Перед публикацией — проверка условий CUDA EULA (Attachment A) |
| Контейнер | Persistent volumes, non-root где возможно, NVIDIA driver/toolkit на host и GPU passthrough; без Docker socket и privileged по умолчанию |
| Остановка | Drain новых работ, сохранение статусов, остановка scheduler и принадлежащих runtime дочерних процессов |
| Отсутствие сети | Локальное исполнение продолжается; pairing/reconnect ждут Cloud/relay с backoff |

При отсутствии CUDA/совместимого драйвера UI показывает причину. Переход на CPU
должен быть явно видимым, а не считаться успешной проверкой GPU.

**Реализация R2-C (8 октября).**
- Manifest schema 2: `runtimes.linux-x64-cuda12` — базовая сборка `linux-x64` плюс
  overlay с перечнем файлов и их sha256 (`scripts/lib/llama-manifest.mjs`). Запись
  добавляется после первого прогона CI из `manifest-fragment.json`.
- `scripts/build-llama-cuda-overlay.mjs`: `module` собирает `libggml-cuda.so` в
  `nvidia/cuda:12.8.1-devel`, `package` берёт cudart/cuBLAS из официальных
  redist-архивов NVIDIA (sha256), проверяет RUNPATH/NEEDED/GLIBC через `readelf`,
  пакует детерминированный ustar и прогоняет настоящие `prepare` и `verify`.
- `prepare-llama-runtime.mjs --variant/--overlay/--manifest/--destination`: overlay
  не может содержать ссылки, `..`, лишние файлы или заменить файл базовой сборки;
  сборка идёт во временной папке рядом и подменяется целиком.
- `.github/workflows/llama-cuda-runtime.yml` — только ручной запуск; публикация
  выключена по умолчанию и проходит через environment `cuda-release` (подпись EULA
  владельцем). Ни разу не запускался.
- Сервер выбирает CUDA, только если `runtime.json` этого каталога — `cuda` той же
  сборки, что manifest; `status` показывает выбранный и фактический backend и причину
  CPU fallback, UI моделей — плашку «CPU fallback».
- `llama-server` и проба устройств запускаются с cwd = каталог runtime и без
  унаследованных `GGML_*`/`LLAMA_ARG_*` (ggml загружает backends и из cwd, а cwd
  сервера — папка, куда пишут агенты); `LD_LIBRARY_PATH` начинается с каталога
  runtime; `CUDA_CACHE_PATH` — в данных сервера.
- Проверено на Fedora: overlay для `61-real` собран скриптом, prepare/verify с
  `--check-libraries` прошли (GLIBC 2.34, GLIBCXX 3.4.30), служба работает на нём:
  `cuda → CUDA`, ~191 tok/s. На реальной
NVIDIA-машине проверяем скачивание, load/unload, VRAM, inference и restart.
Веса скачивает сам host с источника модели: многогигабайтный download не идёт
через клиент/relay. Аренда машины и установка драйверов пока выполняются владельцем;
маркетплейс аренды и управление аккаунтами GPU-провайдеров не нужны.

Другие host-платформы сохраняют адаптеры: macOS/Metal, Windows, AMD/ROCm проверяются
отдельно и не объявляются готовыми на основании Linux-теста. Сборку CUDA сверяем
с [llama.cpp build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md),
контейнеризацию — с [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

### 5.1 GPU: минимальная реализация

Сервер — одна машина с одной или несколькими GPU. Одновременно может быть загружено
несколько моделей, поэтому их нужно распределять по GPU. Приоритет всегда у GPU;
CPU получает только то, что не поместилось, либо модель при отсутствии GPU.

До реализации в коде было:
- `gpuLayers` по умолчанию `0` на Linux/Windows
  ([config.ts](../src/config/config.ts)), то есть только CPU;
- `ensureLoaded` проверяет каждую модель отдельно против общего объёма RAM и не
  учитывает уже загруженные модели ([LocalModelService.ts](../src/local/LocalModelService.ts));
- загрузки разных моделей идут параллельно;
- `llama-server` запускается без `--device`, поэтому CUDA-сборка раскладывает
  каждую модель по всем видимым GPU ([LlamaCppRuntime.ts](../src/local/LlamaCppRuntime.ts)).

Минимальная реализация:
1. **Устройства.** Перед каждой загрузкой читается фактически свободная память
   устройств: `llama-server --list-devices` (stdout, строки вида
   `  CUDA0: <name> (<total> MiB, <free> MiB free)`), для NVIDIA запасной путь и
   UUID — `nvidia-smi --query-gpu=index,uuid,pci.bus_id,name,memory.total,memory.free`.
   Проба и запуск идут с `CUDA_DEVICE_ORDER=PCI_BUS_ID`, раскладка задаётся через
   `CUDA_VISIBLE_DEVICES` и `--device`. На кластере
   GPU может занимать и чужой процесс, поэтому учитывается свободная, а не полная
   память. Устройства опознаются по стабильному ID (UUID GPU). На macOS одно
   устройство — unified memory.
2. **Очередь загрузок.** Выбор устройства и загрузка выполняются для одной модели
   за раз (общая блокировка в `LocalRuntimePool`). Inference уже загруженных
   моделей идёт параллельно, как сейчас.
3. **Выбор места, по порядку:**
   - одна GPU с достаточной свободной памятью — та, где после загрузки останется
     меньше всего свободного места;
   - разделение по слоям на минимальном наборе GPU (`--device`,
     `--split-mode layer`, `--tensor-split` пропорционально свободной памяти);
   - часть слоёв на GPU, остаток на CPU (`--n-gpu-layers` по расчёту) с видимым
     предупреждением о скорости;
   - только CPU.

   Оценка памяти: веса, KV cache для текущего контекста и запас. Уже загруженные
   модели автоматически не выгружаются. Если места нет совсем, пользователь видит
   понятную ошибку с вариантами: выгрузить модель, уменьшить контекст или выбрать
   меньшую квантизацию.
4. **Ошибка нехватки памяти при загрузке** (видна в логе `llama-server`): один раз
   пробуем следующий вариант плана с запасом ×1.2, затем показываем ошибку. Для
   частичной раскладки повтор — снова частичная, но с меньшим числом слоёв, а не
   сразу CPU.
5. **Значение по умолчанию** `gpuLayers = auto` на всех платформах; явное
   пользовательское значение сохраняется.
6. **UI моделей:** у загруженной модели видно, на каких устройствах она работает
   (GPU N, несколько GPU, частично CPU, CPU); память по каждой GPU выводится в
   метриках host.

Не входит: ручная раскладка модели по GPU, автоматическое перераспределение и
выгрузка, учёт фактического потребления по процессам, несколько машин (RPC).
Планировщик — чистая функция с unit-тестами на имитированных наборах устройств.
Живая проверка — на машине минимум с двумя GPU. Учёт уже загруженных моделей
заодно исправляет проверку памяти на macOS и Windows.

**Проверено на одной GPU (8 окт., Fedora 43, GTX 1070 Ti 8 GB, CUDA 12.8, sm_61,
llama.cpp b10809).** Сервер сам выбрал `linux-x64-cuda12`; `--list-devices` видит
GPU, раскладка закреплена по UUID.

| Сценарий | Раскладка | Скорость (через `/chat`) |
|---|---|---|
| Qwen2.5-0.5B Q4_K_M, CPU | `CPU` | ~48 tok/s |
| Тот же, GPU | `GPU 0`, 574 MiB | ~196 tok/s |
| Qwen2.5-14B Q4_K_M (9 GB > VRAM) рядом с 0.5B, старая калибровка | `GPU 0 · partly CPU (25/49)` | 5.5 tok/s |
| То же, текущая калибровка | `GPU 0 · partly CPU (31/49)`, 6032 MiB, 1.4 GB VRAM свободно | 6.7 tok/s |

Замер для калибровки: ~765 MiB постоянно (CUDA context + compute buffers) и
~171 MiB на слой. Политика: запас 512 MiB + контекст 384 MiB + compute 384 MiB;
на слой — веса/(слои+1) + KV/слои, без коэффициента 1.1. Ручное `gpuLayers` меньше
числа слоёв показывается как `partly CPU` и проверяется по памяти этих слоёв, а не
всей модели. Несколько GPU живьём ещё не проверены.

## 6. Ключ подключения, pairing и повторный доступ

### 6.1 Что вводит пользователь

Термин **SSH256** заменяется на **ключ подключения**. SHA-256 — функция хеширования,
используемая для отпечатка ключа host; она не является логином или шифрованием.
SSH может понадобиться для установки сервера, но не является UI-протоколом Remote.

Формат `LCR1-<base32(payload)>-<base32(первые 4 байта SHA-256("lcr1" ‖ payload))>`,
177 символов; регистр, пробелы и переносы игнорируются, padding-биты base32 обязаны
быть нулевыми. Payload (102 байта): version, environment ID (production/dev),
`hostId` (16), `invitationId` (16), SHA-256 SPKI TLS-ключа host (32),
**32 случайных байта одноразового секрета** и `expiresAt` (u32). Checksum ловит
опечатки; fingerprint связывает приглашение с конкретным host. Ключ с чужим
environment ID отвергается. Это длинная строка для copy/paste,
позже тот же payload можно представить QR-кодом. Срок жизни по умолчанию 10 минут,
одно успешное использование; CLI может выдать новый ключ.

Адрес relay задаётся конфигурацией приложения/проверенным environment ID, а не
произвольным URL из ключа. Секрет не передаётся в Cloud API, URL, telemetry или
обычные логи. Его показывают в интерактивной консоли или явно запрошенном выводе
CLI, а не при каждом daemon restart в journald/Docker logs.

### 6.2 Первое подключение

1. Host генерирует постоянную identity, регистрируется в Cloud с challenge/proof
   of possession и держит исходящий WSS. Непривязанный host имеет ограниченные
   ресурсы и принимает только pairing, не команды runtime. Анонимная регистрация
   ограничена по IP/частоте/TTL, не даёт неограниченный бесплатный relay.
2. Пользователь входит в Local Cognitive, открывает **Remote → Connect** и
   вставляет ключ. Client device создаёт собственную постоянную identity.
3. Cloud выдаёт короткий одноразовый билет на pairing с `accountId`, `deviceId`,
   host, invitation, назначением, expiry и nonce. Знание hostId или этот билет
   сами по себе не дают доступа. Билет передаётся WSS auth-frame, не query string.
4. Client и host устанавливают E2EE. Client проверяет fingerprint из приглашения,
   host проверяет владение pairing secret. Внутри аутентифицированного канала
   связываются ticket, device public key, accountId, hostId и handshake transcript.
   До окончания всех проверок предметные команды запрещены.
5. Host атомарно потребляет приглашение и сохраняет владельца/доверенный device
   grant. Одновременные попытки с одним ключом не создают двух владельцев.
   Подписанное подтверждение host фиксируется в Cloud идемпотентно.
6. При сбое между host commit и cloud ACK повторяется только подтверждение с тем
   же ID; приглашение не используется повторно для другого устройства.
7. Client сохраняет pin host identity; получает capabilities и snapshot. UI
   переключается на данные сервера только после завершённого handshake.

Host private key никогда не покидает сервер. Для Cloud proof/signatures применяется
отдельный signing key; X25519 key agreement нельзя использовать как Ed25519 signing.
Выпуск приглашения на непривязанном host разрешает его первичный claim; это
явно написано рядом с ключом. Новые приглашения на уже привязанном host допускают
устройства только того же владельца.

### 6.3 E2EE и жизненный цикл доступа

Канал — **TLS 1.3 с взаимной аутентификацией** (`node:tls`: OpenSSL в Node,
BoringSSL в Electron) поверх байтового потока в WebSocket через relay; host —
TLS-сервер. Spike (8 октября) проверил это на Node 22, Electron 35 и Node 24,
в том числе между процессами. Собственный Noise и TLS-PSK отклонены: PSK в
BoringSSL доступен только для TLS 1.2 и убирает identity устройства.
- Host и устройство — постоянные ключи ECDSA P-256 в самоподписанных сертификатах;
  доверие держится только на pin SHA-256(SPKI), поля сертификата не проверяются.
  Для Cloud у host отдельный Ed25519 signing key.
- Клиент сверяет SPKI host с ключом подключения (или сохранённым pin) **до первой
  записи**; host требует клиентский сертификат и сверяет его SPKI с устройством из
  билета Cloud.
- Pairing secret доказывается `HMAC(secret, "lc-pair-proof/v1" ‖ exporter)`, где
  exporter — `exportKeyingMaterial(32, "EXPORTER-local-cognitive-remote-v1", context)`
  (RFC 5705, RFC 8446 §7.5) с контекстом из purpose, hostId, invitationId, ticketId,
  accountId, deviceId и обоих SPKI. Так связываются билет, ключ устройства, аккаунт,
  host и handshake.
- Каждое соединение — новый ECDHE (forward secrecy); session resumption запрещён
  (host отвергает `isSessionReused()`). Подмену, повтор и перестановку записей
  отвергает TLS AEAD.
- Кадры внутри TLS: u32 длина + JSON, не больше 1 MiB, до `welcome` запросы
  запрещены. В WebSocket — бинарные сообщения не больше 64 KiB, без
  permessage-deflate.

Собственного криптокода — только DER-контейнер сертификата и HMAC над стандартным
exporter; новых crypto primitives не пишем.
Публичный Remote требует проверки реализации протокола; работающий echo-туннель
не доказывает безопасность. E2EE защищает содержимое от relay, но не от
скомпрометированного host/client и не обеспечивает доступность при атаке Cloud.

При повторном подключении нужны account session, новый короткий билет и proof
доверенного device key; первоначальный ключ заново не вводится. Cloud проверяет
владение, host дополнительно проверяет свой grant/revocation epoch и pin устройства.
Новое устройство того же аккаунта проходит pairing; смена identity сервера требует
повторного подтверждения, автоматического доверия новому ключу нет.
Ключ устройства и pins хранятся в защищённом vault по `accountId`. Выход из
аккаунта закрывает Remote, но не удаляет их; без сессии аккаунта ими нельзя
воспользоваться, а host всё равно проверяет grant. **Forget** на устройстве и
**Revoke** удаляют доступ явно.

Различаем **Disconnect** (закрыть транспорт), **Forget on this device** (удалить
локальный профиль соединения) и **Revoke device** (отозвать grant на host/Cloud,
закрыть активные соединения). Cloud revoke для offline-host хранится до доставки;
после reconnect host синхронизирует revocations до допуска команд. Активные
соединения имеют ограниченный срок authorisation и переавторизуются, поэтому
недоставленный отзыв не действует бесконечно. Уже принятые runs живут по своей
политике; отзыв устройства не равен откату выполненных действий.

`reset-owner` — отдельное локальное административное действие с подтверждением:
отозвать все grants, ротировать identity/приглашения, явно решить судьбу старых
данных. Один cloud logout не отвязывает сервер и не удаляет его чаты.

### 6.4 Реализация R3 (8 октября)

- **Общее** (`src/remote/`): `connectionKey.ts` (формат 6.1, строгий base32,
  environment по origin Cloud), `identity.ts` (P-256 сертификат, SPKI-pin, Ed25519),
  `channel.ts` (TLS 1.3 client/host, exporter, proof, кадры), `wsDuplex.ts`,
  `messages.ts` (схемы кадров и контексты подписей).
- **Host** (`src/remote/host/`): `RemoteHost` — сессия (проверка ключа устройства,
  hello, pairing по proof или grant, welcome, операции; запросы до welcome закрывают
  соединение), `RemoteHostStore` — invitations/grants в `host.db` (миграция v2),
  `HostAgent` — регистрация, управляющий WSS, потоки, повтор claim/revoke после
  reconnect. Сервер: `src/server/remote.ts`, команды `connect-key`, `devices`,
  `revoke-device`, `reset-owner --yes`; ключ печатается только в выводе CLI.
- **Cloud** (`apps/cloud/src/remote/`, миграция `0003_remote_pairing.sql`): регистрация
  host с подписью, устройства, билеты (хранится только SHA-256, одноразовые, 60 с),
  relay (`/v1/relay/host`, `/client`, `/host/stream`), подписанные claim receipts,
  revocations с последовательностью, лимиты. Кадры WS ≤ 64 KiB, backpressure.
- **Desktop**: `electron/remote.cjs` (RemoteClient в main, IPC `remote:*`),
  `desktopRemote` в preload, вкладка `public/assets/remote-ui.js`.
- **Проверено вживую**: Mac через production relay подключился по ключу к Fedora за
  NAT; host привязан к аккаунту, устройство в `devices`, статус host с CUDA виден на
  Mac. Автотесты: канал (pairing, MITM, повтор proof, гонка ключа, отзыв, истечение),
  Cloud на Node 24 с Postgres, E2E Cloud + daemon + клиент.

## 7. Надёжный Runtime API и чувствительный чат

### 7.1 Общий клиент и граница доступа

Выделяем `RuntimeClient` с `request`, `subscribe`, `getSnapshot`, `sendCommand`,
`getCommandStatus`, `upload` и `readArtifact`. Он имеет local adapter и relay
adapter. Экран не строит remote URL самостоятельно и не владеет refresh token.

Local adapter не использует HTTP: renderer обращается через preload к main, а main
вызывает тот же диспетчер операций, который обслуживает E2EE-команды Remote (backend
и так работает в main-процессе Electron). Существующие Express-маршруты остаются
внутренним адаптером на время перехода и для тестов, но UI к ним по TCP больше не
обращается. На server daemon UI-ассеты не раздаются.

Host dispatch вызывает существующие предметные сервисы после schema/access
проверки. Миграционный REST adapter допускает только явно описанные operation IDs,
method/path/schema/limits. Не разрешаем универсальное проксирование произвольных
URL/headers и не отключаем `localApiOriginGuard`. Локальные admin/OS маршруты
получают отдельные явно поддержанные операции или capability unavailable.

Handshake отдаёт `protocolVersion`, совместимый диапазон, `serverVersion`,
capabilities и scopes. Identity берётся из проверенного соединения, не из полей
`userId`/`accountId` запроса. Проверки работают на host, включая чтение по ID,
подписки, файлы, settings и approvals. Secrets — только write-only с явными
`set`/`clear`/`unchanged`; bootstrap, PATCH response и errors используют safe DTO.

### 7.2 Принятие команды и события

```text
command: protocolVersion, commandId, idempotencyKey, hostId,
         operation, target, expectedRevision?, payload
ack:     commandId, runId?, acceptedAt, status
event:   hostId, journalEpoch, streamId, sequence, eventId,
         entityId, revision?, runId?, type, occurredAt, payload
```

Первый поток: `message.accepted`, `run.started`, `run.progress`,
`approval.requested`, `approval.resolved`, `message.completed`, `run.completed`,
`run.failed`, `run.cancelled`, `run.interrupted`. Токеновые `message.delta`
подключаются только там, где provider действительно поддерживает streaming.

Команда записывается до ACK; повтор с тем же ключом и payload возвращает прежний
результат, с другим payload — conflict. Account/device/host входят в область
идемпотентности. Потеря ACK не порождает новый commandId. Для чата один активный
turn на session, второй получает очередь либо явный `session_busy`.

Работа выполняется RunService независимо от подписчиков. Snapshot/replay
восстанавливают клиент после reconnect; истёкший cursor даёт `resync_required`.
Cursor привязан к host, stream, epoch и доступу. Новые messages/runs/approvals
и соответствующие события фиксируются в одной SQLite-транзакции. Старые workflow
JSONL-потоки сохраняют свои cursors; не обещаем атомарный snapshot всех JSON stores
через существующий `Promise.all`. Для них применяем domain snapshot + revision/
повторное чтение, затем постепенно переносим критичные изменения в общий store.

После падения host принятое сообщение остаётся, незавершённый run получает
`interrupted` или `needs-review`. Автоматическое продолжение незавершённой
генерации и exactly-once внешнего side effect не обещаются. Command/tool с
неизвестным исходом не запускается повторно вслепую. Approval связан с operation
digest/revision; повторное или устаревшее подтверждение отклоняется.

### 7.3 Порядок изменения существующего чата

1. Зафиксировать regression-тестами нынешние chat/general/code/debate, tools,
   approval, cancel и сохранение истории.
2. Добавить RunService, ConversationStore, command inbox и API
   `POST /runtime/v1/chat-runs → 202`, GET status/messages/events и явный cancel.
3. Переиспользовать `processRuntimeInput`/engine внутри worker; добавить durable
   результат. Новый run lifetime не зависит от закрытия HTTP/WSS.
4. Старый `/process` сохраняет совместимый response и cancel-on-disconnect для
   legacy local клиента до его миграции. Вынесение общей логики выполняется
   последовательно, с явной policy адаптера; remote не держит его запрос живым.
5. Перевести UI на новый контракт после тестов, импортировать старые сообщения
   повторяемым importer с backup, сохранением IDs/localProfileId. Semantic
   memory остаётся отдельной проекцией, а не единственным хранилищем истории.

Долговечность принятого remote run входит в desktop Remote, а не откладывается
до mobile. Workflow/tasks/schedules используют существующие runners, дополняемые
command dedupe, approval/reconciliation и revisions там, где их не хватает.

### 7.4 Реализация R4 (9 октября)

- **Host** (`src/runtime/`): `RunService` — команда `chat.runs.start` пишется в
  `host.db` до ответа (идемпотентность по `commandId` в рамках account/device,
  другой payload — `idempotency_conflict`), один активный ход на чат
  (`session_busy`), выполнение через тот же `processRuntimeInput` (channel `http`,
  локальный профиль — общая история), частичный ответ сохраняется каждые 300 мс,
  cancel — отдельная команда, approvals привязаны к `approvalId`/digest. После
  рестарта `recover()` переводит незавершённые ходы в `interrupted` (или
  `needs_review`, если ход был в шаге tools) без повторного выполнения.
  `EventJournal` — поток на чат с плотными sequence, epoch и resync.
- **Протокол**: `events.poll` (long-poll до 20 с) поверх канала R3 вместо push-кадров;
  операции `sessions.*`, `models.available`, `chat.runs.*`, `chat.approvals.resolve`
  (`src/runtime/chatOperations.ts`). Ответ больше 1 MiB — ошибка, а не падение host.
- **Клиент**: `RemoteRuntime` — повтор неподтверждённой команды с тем же `commandId`,
  подписки с курсором переживают reconnect; авто-переподключение к последнему
  серверу при запуске; IPC `remote:runtime-*` с allowlist операций.
- **UI**: переключатель «This computer / сервер» на экране чата
  (`public/assets/chat-target.js`). Чаты сервера имеют свои ключи сессий; `api`
  не пропускает их к локальному backend; без связи ничего не отправляется,
  черновик сохраняется; черновики раздельны по машинам. Трасса запросов локального
  чата закреплена тестом и не изменилась.
- **Ограничения R4**: только текст; без проектов, вложений, subagents/debate,
  смены режима доступа, переименования и удаления чатов сервера. Прерванный ход в
  контекст модели следующих ходов не попадает. История между машинами не переносится.
- **Проверено вживую**: Mac → fedora через production relay, ответ с GPU сервера.
  Автотесты: RunService, журнал, E2E (обрыв посреди ответа, повтор команды,
  закрытие приложения, cancel, SIGKILL сервера), UI в JSDOM.

## 8. Переключение UI и функциональное покрытие

В навигации есть **отдельная кнопка Remote**. Она открывает список hosts,
**Connect**, поле ключа, состояние подключения и управление устройствами.
После подключения в постоянном индикаторе видны host name и online/reconnecting/
offline. Модель и пути подписаны именем выбранной машины.

Remote-only startup запускает client shell без локальной модели. UI assets
поставляются с приложением с доверенного app origin; remote HTML не загружается
в окно с Electron preload. Настройки клиента/voice не зависят от RuntimeManager.
Проверяются sender/origin и безопасная работа протокола раздачи bundled assets;
не строим архитектуру на предположении, что Electron перехватит любой fetch/SSE.
Все сетевые вызовы UI переводятся на `RuntimeClient`: 90 мест вызова, 9 вызовов
preload-мостов (без голосового ввода) и 104 маршрута в `src/api`, из которых UI
использует 84. Таблица «экран → операция → маршрут», классификация HOST-API / ADAPT /
CLIENT и порядок миграции — в [runtime-operations-inventory.md](runtime-operations-inventory.md) (R0).
Разработка UI идёт через Electron с перезагрузкой; режим «открыть localhost в
браузере» убирается из `npm run dev`.

Переключение Local → Remote **не останавливает автоматически** локальные runs,
downloads или schedules. Отдельное действие «Освободить локальные ресурсы»
показывает активную работу и предлагает корректно завершить/остановить её.
Remote → Disconnect возвращает локальные данные; работа сервера продолжается.
Недоступный remote host не вызывает молчаливую отправку команды на local.

Подписки старого host снимаются, ответы проверяют connection generation.
Кэш, drafts и cursor разделены по account/host/workspace. Смена аккаунта не
показывает прошлый кэш. Очередь offline-команд автоматически не исполняется;
сохраняется черновик, пользователь повторно отправляет после reconnect.

| Экран/действие | Где исполняется и что передаётся |
| --- | --- |
| Чаты, code/debate, агенты, tools, approvals | Host; клиент видит ту же историю, события и результат |
| Проекты, workflow/FSM editor, synthesis | Host stores/runners, revision conflicts при сохранении; клиент редактирует представление |
| Tasks/schedules | Host scheduler продолжает работу без клиента; missed runs имеют явную policy без двойного запуска |
| Каталог, download, load/unload, test модели | Host; VRAM/RAM и статус относятся к нему |
| Импорт GGUF и выбор каталога | Browse разрешённых host roots; remote path не берётся из native picker клиента |
| Вложения/артефакты | Ограниченные upload/download streams, размер, cancel, content hash, пути/симлинки проверяются на host |
| Reveal/Finder/editor | Remote file preview/download; при локальном открытии создаётся явно обозначенная копия |
| Provider keys и plugins/MCP | На host; клиент может задать новый secret, но не прочитать сохранённый |
| OAuth плагина | Браузер клиента, flow/verifier/token exchange и token storage принадлежат host |
| Голосовой ввод | Микрофон и speech на клиенте; на host уходит подтверждённый текст |
| Тема, shortcuts, Account, updater | Клиент; runtime-настройки показываются отдельно как настройки host |
| GUI-only tool | Доступен только при наличии нужной среды на host; подключение клиента не создаёт серверную GUI-сессию |

Browse roots задаёт администратор host; normalisation, symlink escape и traversal
проверяются сервером. Большие веса клиент→host через relay — отдельное расширение;
первый релиз позволяет скачать модель на host или импортировать уже лежащий там
GGUF. При нескольких доверенных клиентах конфликты решаются revisions/сериализацией
команд; произвольное правило «одно устройство отключает другое» не вводится.

## 9. Plugin OAuth и единая success page

Сохраняем работающий PluginManager, MCP client и encrypted vault. Install,
Connect, Enable, Disable, Disconnect и Uninstall остаются разными действиями.
Login Local Cognitive не означает согласия на доступ к Google Drive/Notion.

`AuthCompletionPage` используется для account login и plugin callback. Она
показывает факт сохранённой авторизации, кнопку **Open Local Cognitive** и
безопасную ошибку при неуспехе; не утверждает «plugin готов к работе» до discovery/
inspection. CSP, escaping, no-store и запрет внешних ресурсов обязательны.
В текущем [OAuthConnections.ts](../src/plugins/OAuthConnections.ts) callback
возвращает plain text в браузер — заменяем именно этот ответ.

В Remote host создаёт flow с `hostId/deviceId/connectionId/attemptId`, state и
PKCE verifier. Клиент сначала резервирует loopback listener с зарегистрированным
redirect URI; host использует ровно этот URI. Браузер проходит provider login,
callback клиента отправляется host по E2EE. Host повторно проверяет state,
привязку, TTL/one-use и выполняет exchange с тем же redirect URI. Refresh token
хранится/обновляется только на host, ни Cloud, ни клиент его не реплицируют.

Это проверяется отдельно для native OAuth и MCP OAuth с их правилами регистрации;
универсальная пересылка code без этих проверок недопустима. Потеря туннеля после
callback показывает ожидающее/неуспешное состояние, не ложный success. GitHub
device-code flow завершается polling на host; страницу GitHub мы не подменяем.
После возврата приложение само обновляет connection/discovery status.

Для будущего browser/mobile будет отдельный platform callback adapter с
зарегистрированными HTTPS/app links; desktop loopback не объявляется универсальным
решением для телефона. Confidential OAuth app secrets нельзя поставлять как
защищённые секреты в open-source desktop/server bundle: для таких providers
до выпуска нужен поддержанный public-client flow либо отдельный проверенный
OAuth broker с явно описанным владельцем credentials и границей приватности.

## 10. Usage и профиль

Сохраняем ранее заказанный объём: lifetime tokens, токены периода, Token Activity
Daily/Weekly/Cumulative. Showcase/Create site не добавляем. Вид как в референсе
не доказывает идентичность закрытой формуле Codex; формулы фиксируем у себя.

Событие записывает **исполняющий runtime**, а не каждый подключённый UI:
`eventId`, `executionHostId`, `accountAtExecution?`, `callId`, `attemptId`,
run/session, provider/model, agent role/purpose, время, outcome, input/output/
total, источник `reported|estimated|unknown`, cache/reasoning details.
`LLMService` — центральная точка; parser добавляет Gemini `usageMetadata` и
Ollama `prompt_eval_count/eval_count`. Дополнительные агенты, переводы, repairs,
retry и доступный usage после ошибки учитываются; unknown не заменяется нулём.
Usage ответа фиксируется до проверки abort/ошибки пользовательского результата.
Если provider делает несколько запросов внутри одного `generateText`, ему нужен
attempt hook: одна запись на границе LLMService не должна скрывать эти вызовы.

| Представление | Определение |
| --- | --- |
| Lifetime | Сумма уникальных доступных total tokens с начала ledger; исторический пропуск показывается явно |
| Daily | Сумма по календарному дню в выбранной timezone |
| Weekly | Сумма по неделе с понедельника в той же timezone |
| Cumulative | Накопленная сумма до даты, без повторного суммирования уже cumulative значений |
| Period bar | Input/output и общий объём периода; процент квоты только при реальном лимите, не от окна контекста |

Cache/reasoning категории, уже входящие в total, повторно не прибавляются.
UTC timestamps хранятся исходно; timezone влияет на группировку, не на исходные
события. Longest task/streak/peak добавляются только с утверждённой формулой;
в этот первый UI входят перечисленные выше показатели.

Синхронизация идёт durable outbox с dedupe по `(executionHostId, eventId)` и
владельцем, проверенным Cloud. ACK обновляет outbox; retries не создают дублей.
Host usage отправляет host credential с соответствующим scope, не account token
клиента. Локальный runtime отправляет через account sync adapter. События после
смены аккаунта не переназначаются; pre-login activity остаётся local до отдельного
разрешения импорта. Один remote вызов не считается ещё раз каждым observer.

В account totals объединяются cloud-confirmed события и только ещё не
подтверждённые события видимых runtime, без overlap; UI маркирует неполную/offline
статистику. Передаются счётчики и opaque IDs, без текста, путей и tool arguments.
Эти данные — статистика self-hosted исполнения, не доказательство для денежного
биллинга. Подписки/платёжный gateway не входят в текущую реализацию.

## 11. Report a bug

Входы: меню профиля, Settings → About и Help. Форма: описание, шаги, ожидаемый/
фактический результат, необязательный контакт. Пользователь просматривает
диагностику перед отправкой; screenshot и server logs — отдельные opt-in.

Диагностика содержит версии client/server/protocol, ОС/arch, capabilities,
Local/Remote и категории ошибок. Ротируемый технический log строится по allowlist
полей с redaction в источнике. Raw stdout tools/LLM, prompt/response, provider
keys, OAuth code/state, pairing secret, paths и содержимое файлов автоматически
не прикладываются. Одна regex-маскировка полного лога не гарантирует приватности.

`POST /v1/bug-reports` принимает report ID для dedupe. Login необязателен:
используются серверные IP/account limits, ограничения размера/частоты и abuse
control; клиентский installId не считается надёжной защитой. Вложения — private
object storage, metadata — PostgreSQL; allowlist MIME, size limit и срок удаления
(начальный продуктовый default: 90 дней). Уведомление владельцу продукта содержит
report ID и внутреннюю ссылку, не сырые логи; доступ только авторизованной поддержке.

При offline доступен export отчёта после preview. Отправка не создаёт публичный
GitHub issue автоматически. Server diagnostics читаются только разрешённым
устройством через E2EE; их отправка в поддержку является отдельным раскрытием.

## 12. Обновления клиента и сервера

### Desktop

`electron-updater` и GitHub Releases с публичными артефактами, stable/beta каналами.
GitHub token в приложение не помещается. Updater принадлежит клиенту и работает
в Local/Remote без account login. UI: текущая/доступная версия, check/download,
release notes, прогресс и **Restart and update** после действия пользователя.

Build configuration сейчас находится в `package.json`, отдельного
`electron-builder.yml` нет. Добавляем нужные targets/metadata; macOS требует ZIP
для update payload помимо DMG, подпись Developer ID и notarization для штатной
публичной поставки. До подписанной сборки — проверка версии и ручное скачивание.
Windows сохраняет NSIS с проверкой подлинности релиза; code signing входит в
production release work. Версию builder/updater выбираем совместимую с Electron,
новые опции latest-документации не считаем доступными в установленном builder 25.
[electron-builder auto-update](https://www.electron.build/docs/features/auto-update/).

Перед restart проверяем локальные активные работы и сохранение drafts. Удалённый
run продолжает жить на host. CI собирает обе macOS arch, Windows и server assets;
запускает проверки artifact signatures/checksums и отсутствие secrets. Не
публикует пользовательские OAuth registrations, signing keys или data directories.

### Server

Поставляем tagged source/releases и CPU/CUDA образы в GHCR. Первый updater сервера
— управляемый администратором процесс: drain → backup → остановка → новый artifact
по версии/digest → migrations → start/health/reconciliation. Автообновление во
время workflow запрещено. Persistent volumes, host keys и grants сохраняются.
Откат приложения совместим только с соответствующей schema/backup; просто запустить
старый binary после несовместимой миграции недостаточно.

Client/server обмениваются protocol/capability versions. Несовместимая пара
показывает, что обновить, и не принимает мутации. Серверные release notifications
видны в Remote; обновление desktop не обновляет host автоматически. Проверяется
реальный upgrade N→N+1 и восстановление после неуспешного обновления.

## 13. Cloud и host storage/API

Это границы сущностей, не готовая SQL-миграция. Пароли хранятся у Auth0.

| Хранилище | Сущности и ключевые ограничения |
| --- | --- |
| Cloud PostgreSQL | `accounts`, `identity_links` UNIQUE(issuer, subject), `devices`, `hosts` с pinned public identity/owner, `device_grants`, одноразовые `connection_tickets`, `claim_receipts`, `revocations`, audit records |
| Cloud статистика | `usage_events` UNIQUE(execution_host_id, event_id) с проверкой владельца, daily aggregates с timezone/гранулярностью; отсутствующие dimensions не помещать как NULL в primary key |
| Cloud репорты | `bug_reports`, attachment metadata и private object keys |
| Host SQLite | Identity binding/grants/invitations, command inbox, messages/runs/approvals/events, usage/outbox, schema version; секретные ключи — в vault |
| Existing host data | Workflow/task/model/project stores, semantic memory и файлы; migrations по доменам с одним writer |
| Client | Secure credentials/device key, client settings и cache по account/host/workspace |

```text
Cloud HTTPS:
  GET    /v1/me
  POST   /v1/devices/register
  POST   /v1/hosts/register                 ограниченный proof-of-possession flow
  POST   /v1/hosts/:hostId/claim-confirm     подписанное idempotent подтверждение host
  GET    /v1/hosts
  POST   /v1/connections                    pairing/reconnect ticket
  DELETE /v1/hosts/:hostId/devices/:deviceId отзыв с доставкой host
  POST   /v1/usage/events:batch
  GET    /v1/usage/summary
  GET    /v1/usage/activity
  POST   /v1/bug-reports
Relay WSS:
  /v1/relay/host
  /v1/relay/client
Runtime operations (local adapter / E2EE dispatch):
  capabilities, snapshots, command/status, chat-runs, events, approvals,
  sessions, projects, workflows, tasks, schedules, models, settings,
  integrations, filesystem browse, artifact upload/download
```

Relay имеет heartbeat/backoff, одноразовое потребление ticket, bounds на frames/
streams/очереди/bytes, backpressure и разрыв отозванных соединений. Он не хранит
историю как замену host journal. При нескольких relay replicas появляется shared
routing registry; это отдельный этап масштабирования. Ошибка Cloud/relay не
останавливает принятый host run или local режим, но может блокировать новые
соединения. Произвольного fallback в публичный незашифрованный API нет.

## 14. Карта реализации в репозитории

Имена новых файлов — предлагаемые; обязанности и границы обязательны. Cloud
добавляется отдельным package/workspace с собственными tsconfig/test scripts;
root test glob не должен случайно собирать его второй раз.

| Существующие файлы | Изменения |
| --- | --- |
| `src/index.ts`, `src/app/RuntimeManager.ts`, `src/app/buildRuntime.ts` | Headless/supervisor lifecycle, внедрение account/usage/command services, сохранение integration owner |
| `src/api/controller.ts`, `ProcessRunRegistry.ts`, `routes.ts`, `integrationControllers.ts` | Additive run API, safe DTO, auth context/dispatcher; compatibility старого `/process` и local guard |
| `src/transports/shared/runtimeActions.ts`, `src/core/CognitiveEngine.ts`, `src/session/*`, `src/mcp.ts` | Common execution entry, durable conversation mapping, single-writer MCP bridge |
| `src/workflows/WorkflowRunner.ts`, `WorkflowRunStore.ts`, `WorkflowEventStore.ts`, task/schedule services | Dedupe start/approval, revisions, replay и recovery; без замены FSM semantics |
| `src/local/LocalModelService.ts`, `LlamaCppRuntime.ts`, `resources/llama/runtime-manifest.json`, `scripts/prepare-llama-runtime.mjs` | Linux CUDA artifacts и runtime backend selection, remote model commands/metrics |
| `src/plugins/OAuthConnections.ts`, `EncryptedCredentialVault.ts`, `DirectIntegrationAdapter.ts` | Host vault, callback transport adapter, сохранение credentials и success page |
| `src/llm/LLMService.ts`, `provider-utils.ts`, `src/types/index.ts` | Usage на каждый фактический call/attempt и корректные форматы providers |
| `electron/main.cjs`, `preload.cjs`, `voice-input.cjs` | Client shell, secure connection bridge, URL protocol, updater, voice независимо от host |
| `public/assets/app.js`, `model-manager.js`, `workflow-live.js`, `settings-data.js`, `settings-shell.js`, `plugins-ui.js` и связанный CSS | Remote entry, общий RuntimeClient, разделение client/host settings, account/usage/bug/update UI |
| `src/utils/Logger.ts`, `package.json`, build/test configs, README | Redacted diagnostics, package/CI/release configuration и актуальная документация |

Новые области:

```text
apps/cloud/src/{auth,accounts,remote,usage,reports,db}/   remote = hosts, devices, tickets, relay
packages/protocol/                  versioned contracts, validation, capabilities
packages/runtime-client/            local/relay adapters, reconnect, state cursors
src/account/                       auth orchestration, profile, account sync
src/security/                      vault adapters, OAuth completion page
src/server/                        CLI, RuntimeSupervisor, DataRootLock, host config
src/local/DeviceInventory.ts       список устройств и свободной памяти (раздел 5.1)
src/local/PlacementPlanner.ts      выбор GPU/CPU для загрузки модели
src/remote/                        ключ, TLS-канал, host (RemoteHost, HostAgent, RemoteHostStore), client (RemoteClient)
src/runtime/                       CommandService, RunService, event journal
src/conversations/                 durable messages, history importer
src/usage/                         ledger, outbox, projection
src/diagnostics/                   allowlisted collection, redaction, report export
electron/remote.cjs                RemoteClient в main и IPC remote:*
electron/updater.cjs
public/assets/remote-ui.js
public/assets/runtime-client.js      entry/bundle к общему SDK, не второй протокол
public/assets/report-bug.js
deploy/server/                     Dockerfile, compose example, systemd unit
deploy/cloud/                      deployment/env examples, backup procedure
.github/workflows/                 checks, desktop release, CPU/CUDA server release
```

Не создаём заранее пустые модули для payments, StoreKit, marketplace и mobile.
Код UI и серверные operation schemas должны иметь общий контракт, а не две
несовместимые реализации для Mac и будущего телефона.

## 15. Порядок работ и критерии завершения

| Этап | Что делаем | Что подтверждает завершение |
| --- | --- | --- |
| R0. Зафиксировать фундамент | Contract/crypto/storage spikes, таблица операций UI, regression chat tests, Cloud skeleton, env/secret separation, способ получения Linux CUDA-сборки | Выбрана проверенная библиотека канала; SQLite-хранилище подтверждено; текущий чат не регрессирует |
| R1. Account | Auth0 Google/email, verification, `/me`, secure desktop session, success/deep link | Реальный signup/login/restart/logout; чужой account не получает данные |
| R2. Headless GPU | CLI, data lock, vault, persistent dirs, Linux CUDA, native service/Docker, минимальное размещение моделей по GPU (раздел 5.1) | На GPU-машине без GUI скачана и запущена модель, inference подтверждён как GPU; две модели на машине с 2+ GPU занимают разные GPU, модель, не влезающая в одну GPU, делится между ними |
| R3. Pairing + relay | Host registration, ключ, E2EE, claim, grants, reconnect/revoke | Mac через другую сеть подключается по ключу к host за NAT; секрет/повтор/чужое устройство проверены |
| R4. Надёжный remote chat | RunService, messages/events, idempotency, history migration, RuntimeClient | После закрытия UI ответ готов на host; reconnect/ACK retry не создаёт второй run |
| R5. Полный Remote UI | Отдельная кнопка, local/remote routing, все строки раздела 8, remote plugin OAuth | Models/workflow/tasks/files/settings работают на выбранном host; данные не смешиваются |
| R6. Usage | Provider parsing, durable ledger/outbox, heatmap/profile | Основные и дополнительные calls учтены один раз; нет двойного счёта observers |
| R7. Report a bug | Redacted logging, preview/export/upload, private attachments, уведомление | Отчёт сохранён и доступен поддержке; тестовый secret/content не попал автоматически |
| R8. Updates + release | Signed desktop releases, server artifacts, migrations/rollback, protocol compatibility | N→N+1 и восстановление подтверждены; client update не останавливает remote run |

R2 можно выполнять вместе с R1 после контрактов R0. R7 и подготовка R8 не зависят
от полного Remote, R6 начинается с записи ledger до готовности Profile UI.
Первый полезный вертикальный результат — **R1–R4** на двух реальных машинах.
Он ещё не называется полнофункциональным remote release до R5 и проверок ниже.
Объём существенно больше account-only плана; сроки оцениваются после R0 и GPU/
crypto проверки, прежняя оценка login/usage сюда не переносится.

### Обязательные end-to-end проверки

- Чистый Linux NVIDIA host, Mac client в другой сети: login → CLI key → Remote →
  download/load model → chat → workflow → файл результата. На клиенте модель
  не скачивалась и inference не выполнялся.
- Потеря сети до/после ACK, закрытие UI и рестарт relay: один command создаёт
  один run; результат читается после reconnect. Cancel всегда отдельный.
- Рестарт host во время inference/tool: сообщение не теряется, статус честный,
  потенциальный внешний side effect не повторяется автоматически.
- Подмена fingerprint/frame, просроченные или повторные invitation/ticket,
  другой account, непривязанный и отозванный device — отказ без исполнения.
- Новый device требует pairing; два доверенных клиента получают согласованные
  статусы/конфликты. Disconnect одного не отменяет работу другого.
- Local↔Remote, смена host/account: правильные чаты, drafts, paths, usage,
  settings и subscriptions; автоматического stop или отправки другому host нет.
- Remote plugins: callback/state/TTL/denial/restart/refresh, реальная авторизация
  и read для выбранных providers; успешные mocks не выдаются за live acceptance.
- Запрет чтения secrets из bootstrap/settings/errors/logs/reports; файловые
  операции не выходят за разрешённые roots через traversal или symlink.
- Usage retry/account switch/offline: события не дублируются и не переходят
  другому пользователю; unknown и timezone отображаются корректно.
- Signed update, несовместимые protocol versions, backup/restore, неуспешная
  миграция; существующие local chat/models/workflow проходят regression suite.

## 16. Что подготовить владельцу продукта

| Когда | Доступ/ресурс |
| --- | --- |
| До R1 | Домен с DNS, Auth0 dev/prod tenants, Google OAuth project, SMTP с SPF/DKIM/DMARC; privacy/support страницы |
| До R3 | CPU hosting под Cloud API/relay с долгими WSS и достаточным egress; staging стартует с порядка 2 vCPU/2–4 GB как гипотеза для нагрузочного теста; managed PostgreSQL/backups |
| До R2/R4 live checks | Отдельная Linux NVIDIA машина с достаточными VRAM/RAM для выбранной тестовой модели, driver/toolkit и disk; это GPU пользователя/тестового стенда, не Cloud accounts VPS |
| До R7 | Private object storage и email поддержки для bug reports |
| До R8 | Публичное хранилище releases, CI/GHCR, signing/notarization credentials. Apple Developer нужен для штатной macOS поставки независимо от срока добавления Apple login |

Биллинг/подписки, мобильная оболочка и push, автоматическая аренда GPU, перенос
данных между hosts, команды управления рабочим столом ОС и публичный marketplace
остаются отдельными будущими функциями. Протокол и platform adapters допускают
их добавление, но эти функции не расширяют текущие этапы незаметно.

## 17. Консолидация и остающиеся документы

Объединены и удалены из рабочей документации:

- `account-login-usage-implementation-plan.md` — account/usage/callback требования
  сохранены здесь; прежнее исключение Remote отменено новым запросом.
- `accounts-billing-mobile-investigation.md` — headless, runtime contract,
  ownership/recovery перенесены сюда; сравнения продуктов, payment/mobile
  исследования и уже устаревший план первой установки плагинов убраны.
- `login-remote-access-v1-scope.md` — login/relay/report/update требования
  перенесены; исключение CUDA, usage/callback, durable chat и автоматическая
  остановка локальных работ не входят в новый план.

Исходники до удаления сохранены в recovery archive вне репозитория. Этот документ
— единственная текущая спецификация перечисленных механизмов. Дополнительные
решения spike и результаты этапов вносятся сюда, а не создают новый конфликтующий
scope. Проверяемые результаты реализации отмечаются отдельно от предложений.

Специализированная документация остаётся для собственных подсистем:
[plugin implementation](plugins-local-oauth-implementation.md),
[outbound MCP](outbound-mcp-client.md),
[workflow scope](projects-agents-workflows-implementation-scope.md),
[platform build guide](platform-build-guide.md),
[llama.cpp integration](llama-cpp-integration-plan.md),
[historical Settings scope](settings-profile-plugins-implementation-scope.md).
Она не заменяет этот план аккаунтов/Remote и сохраняет полезные сведения
о существующей реализации, тестах и сборке.
