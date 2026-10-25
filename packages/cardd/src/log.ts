type Write = (...args: unknown[]) => void;

function stamped(write: Write): Write {
  return (...args) => {
    write(new Date().toISOString(), ...args);
  };
}

export function stampLogLines(): void {
  console.log = stamped(console.log.bind(console));
  console.warn = stamped(console.warn.bind(console));
  console.error = stamped(console.error.bind(console));
}
