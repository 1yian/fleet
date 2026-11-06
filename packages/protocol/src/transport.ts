import { execFile, type ExecFileException } from "node:child_process";
import { basename } from "node:path";

const DIED_SENDING_DESCRIPTORS_TO_THE_MASTER = /mux_client_request_session: send fds failed\s*$/;

const WITHOUT_THE_MASTER = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

const SSH_UNREACHABLE = 255;

export interface Limits {
  readonly timeout: number;
  readonly maxBuffer?: number;
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

export function runOnTransport(
  file: string,
  args: readonly string[],
  limits: Limits,
  done: Finished,
): void {
  const options = { encoding: "utf8", ...limits } as const;
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error === null || !diedBeforeTheCommandStarted(file, error, stderr)) {
      done(error, stdout, stderr);
      return;
    }
    execFile(file, [...WITHOUT_THE_MASTER, ...args], options, done);
  });
}
