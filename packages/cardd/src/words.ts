export const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

export const containsWords = (text: string, words: string): boolean => {
  const wanted = squash(words);
  return wanted !== "" && squash(text).includes(wanted);
};
