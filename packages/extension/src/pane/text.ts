const PASTE_START = "\u001b[200~";

export const oneLine = (data: string): string =>
  data.includes(PASTE_START) ? data.replace(/\s*[\r\n]+\s*/g, " ") : data;
