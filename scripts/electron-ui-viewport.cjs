// Electron owns the native window size. Browser viewport emulation only shrinks
// its renderer and can leave the rest of a transparent window showing through.
async function clearViewportOverride(page) {
  const session = await page.context().newCDPSession(page);
  try {
    // Explicitly reset values as this cleanup may use a different CDP session
    // from the one that originally installed the emulation.
    await session.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  } finally {
    await session.detach();
  }
}

async function withNativeWindowSize(electronApp, page, size, check) {
  const window = await electronApp.browserWindow(page);
  const original = await window.evaluate((window) => window.getBounds());
  try {
    await clearViewportOverride(page);
    await window.evaluate((window, size) => window.setContentSize(size.width, size.height), size);
    const expected = await window.evaluate((window) => window.getContentSize());
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, expected);
    return await check(page);
  } finally {
    // Cleanup runs even if an assertion fails or a callback used emulation.
    try {
      await clearViewportOverride(page);
    } finally {
      try {
        await window.evaluate((window, bounds) => window.setBounds(bounds), original);
      } finally {
        await window.dispose();
      }
    }
  }
}

module.exports = { clearViewportOverride, withNativeWindowSize };
