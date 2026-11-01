import { qrcodegen } from "./qrcodegen";

/** Whether the phone app that scans these codes is out: the window and `pair` show the code beside
 * the key. Off until the iPhone app is in TestFlight or the App Store (a development build turns it on
 * for the app's testing; a release ships with it off until then). */
export const PHONE_APP_SHIPPED = false;

/** A connection key as a QR code, for a phone to scan: the key itself (A–Z, 2–7 and "-" fit QR's
 * alphanumeric mode), error correction M or better. 177 characters make version 7, 45×45 modules. */
export const connectionKeyQr = (key: string): qrcodegen.QrCode =>
  qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeAlphanumeric(key)], qrcodegen.QrCode.Ecc.MEDIUM);

const QUIET_ZONE = 4;

/** An SVG of the code with its quiet zone: one path of the dark modules on a white square, so it
 * reads in a dark theme too. Made from the key only; no text of anyone else's goes in. */
export const qrSvg = (code: qrcodegen.QrCode, title = "Connection key as a QR code"): string => {
  const side = code.size + QUIET_ZONE * 2;
  let path = "";
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.getModule(x, y)) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
  const label = title.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
};

/** The code for a terminal: two module rows per line in upper half blocks, black on white in ANSI
 * colors, so it reads on a dark or a light terminal. */
export const qrTerminal = (code: qrcodegen.QrCode): string => {
  const side = code.size + QUIET_ZONE * 2;
  const dark = (x: number, y: number) => code.getModule(x - QUIET_ZONE, y - QUIET_ZONE);
  const lines: string[] = [];
  for (let y = 0; y < side; y += 2) {
    let line = "";
    for (let x = 0; x < side; x++) line += `\x1b[${dark(x, y) ? 30 : 97}m\x1b[${y + 1 < side && dark(x, y + 1) ? 40 : 107}m▀`;
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
};
