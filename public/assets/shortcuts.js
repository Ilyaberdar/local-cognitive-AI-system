// Keyboard shortcuts: the actions people can give keys to, the keys the app and the system keep for
// themselves, and the message box's send key. A shortcut is kept as physical keys ("Mod+KeyN" is ⌘N
// on a Mac and Ctrl+N elsewhere), so it works the same with any keyboard layout: with a Russian
// layout ⌘, is still ⌘, though that key types "б".

/** The actions, in the order Settings lists them. `keys` is the default; null starts with none. */
export const SHORTCUT_ACTIONS = [
  { id: 'newChat', group: 'Chat', label: 'New chat', keys: 'Mod+KeyN' },
  { id: 'stopGeneration', group: 'Chat', label: 'Stop generating', keys: 'Escape', description: 'While a chat is answering.' },
  { id: 'dictate', group: 'Chat', label: 'Start or finish dictation', keys: null, voice: true },
  { id: 'openSettings', group: 'Navigation', label: 'Open Settings', keys: 'Mod+Comma' },
  { id: 'toggleSidebar', group: 'Navigation', label: 'Show or hide the sidebar', keys: 'Mod+Backslash' },
  { id: 'goChat', group: 'Navigation', label: 'Go to Chat', keys: 'Mod+Digit1', route: 'chat' },
  { id: 'goWorkflow', group: 'Navigation', label: 'Go to Workflow', keys: 'Mod+Digit2', route: 'orchestration' },
  { id: 'goSynthesis', group: 'Navigation', label: 'Go to Synthesis', keys: 'Mod+Digit3', route: 'synthesis' },
  { id: 'goModels', group: 'Navigation', label: 'Go to Models', keys: 'Mod+Digit4', route: 'models' },
  { id: 'goRemote', group: 'Navigation', label: 'Go to Remote', keys: 'Mod+Digit5', route: 'remote' }
];
export const SEND_KEYS = ['enter', 'mod-enter'];

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Mod'];
// Keys that type text: a shortcut with one needs ⌘ or ⌃ (Ctrl), or typing would trigger it.
const TYPING_KEY = /^(?:Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Minus|Equal|Space)$/;
const OTHER_KEY = /^(?:Escape|F(?:[1-9]|1[0-9]|2[0-4]))$/;
const PUNCTUATION = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=' };
const SPOKEN = { Comma: 'Comma', Period: 'Period', Slash: 'Slash', Backslash: 'Backslash', BracketLeft: 'Left bracket', BracketRight: 'Right bracket', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equals', Space: 'Space', Escape: 'Escape' };
// What the app's menus, text fields and the system already do with keys (Electron's menu roles, see
// electron/app-menu.cjs, plus the system's own): such keys are never offered to an action.
const RESERVED_MAC = {
  'Mod+KeyZ': 'Undo', 'Shift+Mod+KeyZ': 'Redo', 'Mod+KeyX': 'Cut', 'Mod+KeyC': 'Copy', 'Mod+KeyV': 'Paste', 'Alt+Shift+Mod+KeyV': 'Paste and Match Style',
  'Mod+KeyA': 'Select All', 'Mod+KeyW': 'Close Window', 'Mod+KeyM': 'Minimize', 'Mod+KeyH': 'Hide', 'Alt+Mod+KeyH': 'Hide Others', 'Mod+KeyQ': 'Quit',
  'Mod+Digit0': 'Actual Size', 'Mod+Equal': 'Zoom In', 'Shift+Mod+Equal': 'Zoom In', 'Mod+Minus': 'Zoom Out', 'Ctrl+Mod+KeyF': 'Full Screen',
  'Mod+Space': 'Spotlight', 'Alt+Mod+Space': 'Spotlight', 'Ctrl+Space': 'switching input sources', 'Ctrl+Mod+Space': 'Emoji & Symbols',
  'Mod+Backquote': 'switching windows', 'Ctrl+Mod+KeyQ': 'Lock Screen', 'Alt+Mod+Escape': 'Force Quit',
  'Shift+Mod+Digit3': 'screenshots', 'Shift+Mod+Digit4': 'screenshots', 'Shift+Mod+Digit5': 'screenshots',
  ...Object.fromEntries(['A', 'B', 'D', 'E', 'F', 'H', 'K', 'N', 'O', 'P', 'T', 'V', 'Y'].map(letter => [`Ctrl+Key${letter}`, 'text editing']))
};
const RESERVED_OTHER = {
  'Mod+KeyZ': 'Undo', 'Mod+KeyY': 'Redo', 'Shift+Mod+KeyZ': 'Redo', 'Mod+KeyX': 'Cut', 'Mod+KeyC': 'Copy', 'Mod+KeyV': 'Paste', 'Shift+Mod+KeyV': 'pasting plain text',
  'Mod+KeyA': 'Select All', 'Mod+KeyW': 'Close Window', 'Mod+KeyM': 'Minimize', 'Mod+KeyQ': 'Quit',
  'Mod+Digit0': 'Actual Size', 'Mod+Equal': 'Zoom In', 'Shift+Mod+Equal': 'Zoom In', 'Mod+Minus': 'Zoom Out', F11: 'Full Screen',
  'Alt+F4': 'Close Window', 'Mod+Escape': 'the Start menu', 'Shift+Mod+Escape': 'Task Manager', 'Alt+Escape': 'switching windows', 'Alt+Space': 'the window menu'
};

export const isMacPlatform = () => {
  const platform = globalThis.desktopAppearance?.platform;
  return platform ? platform === 'darwin' : /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
};

/** "Ctrl+Alt+Shift+Mod+KeyN" (modifiers in that order) as its parts; null for anything else. */
export function parseShortcut(keys) {
  if (typeof keys !== 'string' || keys.length > 64) return null;
  const parts = keys.split('+'), key = parts.pop();
  if (!TYPING_KEY.test(key) && !OTHER_KEY.test(key)) return null;
  let next = 0;
  for (const part of parts) {
    const at = MODIFIERS.indexOf(part);
    if (at < next) return null;
    next = at + 1;
  }
  return { key, ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), mod: parts.includes('Mod') };
}

/** The keys of a keydown, written like a shortcut; undefined while only modifiers are down. On a
 * Mac ⌘ is Mod and ⌃ is Ctrl; elsewhere Ctrl is Mod, and the Windows key marks it the system's. */
export function shortcutFromEvent(event, mac) {
  const code = event.code;
  if (!code || /^(?:Shift|Control|Alt|Meta|OS|CapsLock|Fn)/.test(code)) return undefined;
  const parts = [];
  if (mac && event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (!mac && event.metaKey) parts.push('Meta');
  return [...parts, code].join('+');
}

function keyName(key) {
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit[0-9]$/.test(key)) return key.slice(5);
  if (key === 'Escape') return 'Esc';
  return PUNCTUATION[key] ?? key;
}

/** Key caps to draw: ⌃⌥⇧⌘ and the key on a Mac, Ctrl, Alt, Shift and the key elsewhere. */
export function shortcutCaps(keys, mac) {
  const parsed = parseShortcut(keys);
  if (!parsed) return [];
  const modifiers = mac ? [parsed.ctrl && '⌃', parsed.alt && '⌥', parsed.shift && '⇧', parsed.mod && '⌘'] : [parsed.mod && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Shift'];
  return [...modifiers.filter(Boolean), keyName(parsed.key)];
}

/** One line of text: "⇧⌘D" on a Mac, "Ctrl+Shift+D" elsewhere. */
export const shortcutText = (keys, mac) => shortcutCaps(keys, mac).join(mac ? '' : '+');

/** What a screen reader says: "Command N", "Control Shift D". */
export function shortcutSpoken(keys, mac) {
  const parsed = parseShortcut(keys);
  if (!parsed) return '';
  const modifiers = mac ? [parsed.ctrl && 'Control', parsed.alt && 'Option', parsed.shift && 'Shift', parsed.mod && 'Command'] : [parsed.mod && 'Control', parsed.alt && 'Alt', parsed.shift && 'Shift'];
  return [...modifiers.filter(Boolean), SPOKEN[parsed.key] ?? keyName(parsed.key)].join(' ');
}

/** The aria-keyshortcuts value: "Meta+N", "Control+Shift+D". */
export function shortcutAria(keys, mac) {
  const parsed = parseShortcut(keys);
  if (!parsed) return '';
  const modifiers = [(mac ? parsed.ctrl : parsed.mod) && 'Control', parsed.alt && 'Alt', parsed.shift && 'Shift', mac && parsed.mod && 'Meta'];
  const key = parsed.key === 'Escape' ? 'Escape' : parsed.key === 'Space' ? 'Space' : keyName(parsed.key);
  return [...modifiers.filter(Boolean), key].join('+');
}

/** Each action's keys: the person's own choice, else its default unless the person gave that to
 * another action. Unreadable choices fall back to the default. */
export function effectiveShortcuts(own = {}) {
  const chosen = {}, taken = new Set();
  for (const action of SHORTCUT_ACTIONS) {
    if (!own || typeof own !== 'object' || !Object.hasOwn(own, action.id)) continue;
    const keys = own[action.id];
    if (keys === null) chosen[action.id] = null;
    else if (parseShortcut(keys) && !taken.has(keys)) { chosen[action.id] = keys; taken.add(keys); }
  }
  return Object.fromEntries(SHORTCUT_ACTIONS.map(action => {
    if (Object.hasOwn(chosen, action.id)) return [action.id, chosen[action.id]];
    const keys = action.keys && !taken.has(action.keys) ? action.keys : null;
    if (keys) taken.add(keys);
    return [action.id, keys];
  }));
}

/** What is stored: only the actions whose keys differ from the default (null: none). */
export const ownShortcuts = shortcuts => Object.fromEntries(SHORTCUT_ACTIONS
  .filter(action => (shortcuts[action.id] ?? null) !== action.keys).map(action => [action.id, shortcuts[action.id] ?? null]));

/** Whether keys can be given to an action: { ok: true }, { error } with the reason, or
 * { conflict } naming the action that has them now. */
export function checkShortcut(keys, { mac, actionId, shortcuts }) {
  const parts = String(keys).split('+'), key = parts.at(-1);
  if (parts.includes('Meta')) return { error: 'Keys with the Windows key belong to the system.' };
  if (key === 'Tab') return { error: 'Tab moves between controls.' };
  if (key === 'Enter' || key === 'NumpadEnter') return { error: 'Enter sends messages and adds lines: choose how above.' };
  if (/^(?:Arrow|Page)|^(?:Home|End)$/.test(key)) return { error: 'Arrows, Home, End and the Page keys move the cursor.' };
  if (key === 'Backspace' || key === 'Delete') return { error: 'Backspace and Delete edit text.' };
  const parsed = parseShortcut(keys);
  if (!parsed) return { error: 'This key can’t be part of a shortcut.' };
  if (TYPING_KEY.test(parsed.key) && !parsed.mod && !parsed.ctrl) return { error: mac ? 'Add ⌘ or ⌃: without them this key types text.' : 'Add Ctrl: without it this key types text.' };
  const owner = (mac ? RESERVED_MAC : RESERVED_OTHER)[keys];
  if (owner) return { error: `${shortcutText(keys, mac)} is used for ${owner}.` };
  const other = SHORTCUT_ACTIONS.find(action => action.id !== actionId && shortcuts[action.id] === keys);
  return other ? { conflict: other.id } : { ok: true };
}

/** What Enter does in the message box: 'send', or undefined to leave it to the box (a new line).
 * "enter": Enter sends (so does ⌘/Ctrl+Enter), Shift+Enter adds a line. "mod-enter": only
 * ⌘/Ctrl+Enter sends. Nothing happens while an input method is composing a word. */
export function composerEnter(event, mode, mac) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return undefined;
  if (event.shiftKey || event.altKey || (mac ? event.ctrlKey : event.metaKey)) return undefined;
  const mod = mac ? event.metaKey : event.ctrlKey;
  return mode === 'mod-enter' && !mod ? undefined : 'send';
}

/** The send and new-line keys of a mode, as key caps. */
export function sendKeyCaps(mode, mac) {
  const enter = mac ? '↩' : 'Enter';
  return mode === 'mod-enter'
    ? { send: [mac ? '⌘' : 'Ctrl', enter], newLine: [enter] }
    : { send: [enter], newLine: [mac ? '⇧' : 'Shift', enter] };
}

/** The message box sends with its send key. A disabled Send button (a reply is being written, the
 * server is offline) keeps the key from sending, as it keeps a click. */
export function bindComposerSend({ form, textarea, mode, mac }) {
  textarea?.addEventListener('keydown', event => {
    if (composerEnter(event, mode(), mac) !== 'send') return;
    event.preventDefault();
    const send = form.querySelector('button[type="submit"]');
    if (send && !send.disabled && textarea.value.trim()) form.requestSubmit(send);
  });
}
