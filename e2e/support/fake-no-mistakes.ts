import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
dir="__DIR__"
echo "$*" >> "$dir/calls.log"
case "$1" in
  daemon)
    touch "$dir/daemon-touched"
    echo "daemon administered: $*"
    exit 0
    ;;
  rerun)
    n=$(grep -c '^rerun' "$dir/calls.log")
    echo "  Rerun started for c-branch RERUN$n"
    exit 0
    ;;
  axi)
    if [ -z "$2" ]; then
      if [ -f "$dir/daemon-down" ]; then echo "daemon: stopped"; else echo "daemon: running"; fi
      exit 0
    fi
    n=$(grep -c -E '^axi (run|respond|answer)' "$dir/calls.log")
    while [ ! -f "$dir/queue/$n" ]; do sleep 0.05; done
    cat "$dir/queue/$n"
    if [ -f "$dir/queue/$n.code" ]; then exit "$(cat "$dir/queue/$n.code")"; fi
    exit 0
    ;;
esac
exit 0
`;

export class FakeNoMistakes {
  readonly dir: string;
  readonly bin: string;
  private next = 1;

  constructor(root: string) {
    this.dir = join(root, "fake-nm");
    this.bin = join(this.dir, "bin");
    mkdirSync(join(this.dir, "queue"), { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    writeFileSync(join(this.dir, "calls.log"), "");
    const file = join(this.bin, "no-mistakes");
    writeFileSync(file, SCRIPT.replace("__DIR__", this.dir));
    chmodSync(file, 0o755);
  }

  env(path: string): Record<string, string> {
    return { PATH: `${this.bin}:${path}` };
  }

  answer(output: string, code = 0): void {
    const slot = this.next;
    this.next += 1;
    if (code !== 0) writeFileSync(join(this.dir, "queue", `${String(slot)}.code`), String(code));
    writeFileSync(join(this.dir, "queue", String(slot)), `${output}\n`);
  }

  daemonDown(): void {
    writeFileSync(join(this.dir, "daemon-down"), "");
  }

  calls(): string[] {
    return readFileSync(join(this.dir, "calls.log"), "utf8").split("\n").filter(Boolean);
  }

  get daemonTouched(): boolean {
    return existsSync(join(this.dir, "daemon-touched"));
  }
}
