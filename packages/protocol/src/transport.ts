import { execFile, type ExecFileException } from "node:child_process";
import { basename } from "node:path";

const REFUSED_BEFORE_THE_COMMAND_STARTED =
  /mm_send_fd:|mux_client_request_session: (send fds failed|session request failed)|mux_client_hello_exchange:|mux_client_request_alive:|muxclient: master hello exchange failed|Control socket connect\(/;

const WITHOUT_THE_MASTER = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

const SSH_UNREACHABLE = 255;

export interface Limits {
  readonly timeout: number;
  readonly maxBuffer?: number;
}

export type Finished = (error: ExecFileException | null, stdout: string, stderr: string) => void;

const refusedByTheMaster = (file: string, error: ExecFileException, stderr: string): boolean =>
  basename(file) === "ssh" &&
  error.code === SSH_UNREACHABLE &&
  REFUSED_BEFORE_THE_COMMAND_STARTED.test(stderr);

export function runOnTransport(
  file: string,
  args: readonly string[],
  limits: Limits,
  done: Finished,
): void {
  const options = { encoding: "utf8", ...limits } as const;
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error === null || !refusedByTheMaster(file, error, stderr)) {
      done(error, stdout, stderr);
      return;
    }
    execFile(file, [...WITHOUT_THE_MASTER, ...args], options, done);
  });
}
