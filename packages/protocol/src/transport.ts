import {
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileException,
} from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";

const DIED_SENDING_DESCRIPTORS_TO_THE_MASTER = /mux_client_request_session: send fds failed\s*$/;

const WITHOUT_THE_MASTER = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

const SSH_UNREACHABLE = 255;

const TIMED_OUT = "ETIMEDOUT";

export type Detach = (
  file: string,
  args: readonly string[],
) => ChildProcessByStdio<null, Readable, Readable>;

export interface Limits {
  readonly timeout: number;
  readonly maxBuffer?: number;
  readonly grace?: number;
  readonly detach?: Detach;
  readonly sharedRetryBudget?: boolean;
}

export type Finished = (error: ExecFileException | null, stdout: string, stderr: string) => void;

const diedBeforeTheCommandStarted = (
  file: string,
  error: ExecFileException,
  stderr: string,
): boolean =>
  basename(file) === "ssh" &&
  error.code === SSH_UNREACHABLE &&
  DIED_SENDING_DESCRIPTORS_TO_THE_MASTER.test(stderr);

const DEFAULT_MAX_BUFFER = 1024 * 1024;

const TOO_MUCH_OUTPUT = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

function signalGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function stopGroup(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  signalGroup(child, "SIGKILL");
}

function collect(
  child: ChildProcessByStdio<null, Readable, Readable>,
  { timeout, grace, maxBuffer = DEFAULT_MAX_BUFFER }: Omit<Limits, "detach">,
  done: Finished,
): void {
  let out = "";
  let err = "";
  let stoppedFor: string | undefined;
  let finished = false;
  let killer: NodeJS.Timeout | undefined;
  const stop = (reason: string): void => {
    stoppedFor ??= reason;
    if (reason === TIMED_OUT && grace !== undefined && killer === undefined) {
      signalGroup(child, "SIGTERM");
      killer = setTimeout(() => {
        stopGroup(child);
      }, grace);
    } else stopGroup(child);
  };
  const timer = setTimeout(() => {
    stop(TIMED_OUT);
  }, timeout);
  const finish = (error: ExecFileException | null): void => {
    clearTimeout(timer);
    clearTimeout(killer);
    if (finished) return;
    finished = true;
    done(error, out, err);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    if (out.length > maxBuffer) stop(TOO_MUCH_OUTPUT);
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
    if (err.length > maxBuffer) stop(TOO_MUCH_OUTPUT);
  });
  child.once("error", finish);
  child.once("close", (code, signal) => {
    const failed = stoppedFor !== undefined || code !== 0;
    finish(
      failed
        ? Object.assign(new Error(`Command failed: ${child.spawnfile}`), {
            code: stoppedFor ?? code,
            ...(signal === null ? {} : { signal }),
            killed: stoppedFor === TIMED_OUT,
          })
        : null,
    );
  });
}

function launch(
  file: string,
  args: readonly string[],
  { detach, ...limits }: Limits,
  done: Finished,
): void {
  if (detach === undefined) execFile(file, args, { encoding: "utf8", ...limits }, done);
  else collect(detach(file, args), limits, done);
}

export function runOnTransport(
  file: string,
  args: readonly string[],
  { sharedRetryBudget, ...limits }: Limits,
  done: Finished,
): void {
  const deadline = sharedRetryBudget === true ? performance.now() + limits.timeout : undefined;
  launch(file, args, limits, (error, stdout, stderr) => {
    if (error === null || !diedBeforeTheCommandStarted(file, error, stderr)) {
      done(error, stdout, stderr);
      return;
    }
    const direct = [...WITHOUT_THE_MASTER, ...args];
    if (deadline === undefined) {
      launch(file, direct, limits, done);
      return;
    }
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) done(error, stdout, stderr);
    else launch(file, direct, { ...limits, timeout }, done);
  });
}
