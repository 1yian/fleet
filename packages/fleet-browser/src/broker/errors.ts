import type { BrokerErrorCode } from "../shared/broker-protocol.js";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
