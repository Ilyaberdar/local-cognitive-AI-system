/** How what a paired device is told names its host: "the server", or the name of the computer a
 * person uses that hosts it (set once by the desktop app when it starts hosting). Messages read it
 * when they are made, so one kept in a constant is a function. */
let computer: string | undefined;

export const setHostPlace = (name: string | undefined): void => { computer = name?.trim() || undefined; };
/** "the server", or the computer's name. */
export const place = (): string => computer ?? "the server";
/** The same at the start of a sentence. */
export const Place = (): string => computer ?? "The server";
/** Whether the host is a server, whose admin runs `local-cognitive-server` commands. */
export const hostIsServer = (): boolean => computer === undefined;
