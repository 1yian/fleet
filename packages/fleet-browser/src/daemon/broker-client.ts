import { createConnection } from "node:net";
import type { BrokerErrorCode, BrokerRequest, BrokerResponse } from "../shared/broker-protocol.js";

class BrokerFailure extends Error {
  readonly code: BrokerErrorCode | "BROKER_DOWN";
  constructor(code: BrokerErrorCode | "BROKER_DOWN", message: string) {
    super(message);
    this.code = code;
  }
}

export function brokerCall<T>(socketPath: string, request: BrokerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BrokerFailure("OP_ERROR", "the credential broker did not answer in time"));
    }, 60_000);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer) as BrokerResponse<T>;
        if (response.ok) resolve(response.data);
        else reject(new BrokerFailure(response.code, response.error));
      } catch {
        reject(new BrokerFailure("OP_ERROR", "the credential broker sent an unreadable answer"));
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      reject(
        new BrokerFailure(
          "BROKER_DOWN",
          "the credential broker is not running; run `systemctl status fleet-browser-broker` on the browser host",
        ),
      );
    });
  });
}
