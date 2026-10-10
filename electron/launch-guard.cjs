// A packaged app refuses command-line switches that would let another program drive it or weaken
// its secrets: a debugger attached to its pages, or a stand-in for the Keychain that encrypts with
// a known key. Its fuses already make it ignore --inspect and NODE_OPTIONS ("electronFuses" in
// package.json); Chromium's own switches have no fuse.
const REFUSED_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "use-mock-keychain"];

/** The first refused switch a packaged app was started with; a development run keeps them all. */
const refusedSwitch = ({ isPackaged, hasSwitch }) => isPackaged ? REFUSED_SWITCHES.find(name => hasSwitch(name)) : undefined;

module.exports = { REFUSED_SWITCHES, refusedSwitch };
