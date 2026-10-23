import { INCIDENT_OPS } from "./incidents.ts";
import { VALIDATION_OPS } from "./validations.ts";

export const RUNTIME_OPS = { ...INCIDENT_OPS, ...VALIDATION_OPS } as const;
