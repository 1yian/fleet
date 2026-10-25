function stampStream(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream);
  let atLineStart = true;
  stream.write = (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text === "") return write(chunk, ...rest);
    const prefix = `${new Date().toISOString()} `;
    const body = text.replace(/\n(?!$)/g, `\n${prefix}`);
    const out = (atLineStart ? prefix : "") + body;
    atLineStart = text.endsWith("\n");
    return write(out, ...rest);
  };
}

export function stampLogLines(): void {
  stampStream(process.stdout);
  stampStream(process.stderr);
}
