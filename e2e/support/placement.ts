const placed = new Map<string, string>();

export const placeMate = (token: string, host: string): void => {
  placed.set(token, host);
};

export const placementOf = (token: string): { host?: string } => {
  const host = placed.get(token);
  return host === undefined ? {} : { host };
};
