import { AgentSession } from "@earendil-works/pi-coding-agent";
import { chainLabel, compactorFor, firstAvailable } from "./compaction-model.ts";
import { isRecord } from "./lane-config.ts";
import { methodOf, once } from "./patch.ts";

function stringField(value: unknown, key: string): string | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === "string" ? found : undefined;
}

function registered(session: object, provider: string, id: string): unknown {
  const runtime: unknown = Reflect.get(session, "_modelRuntime");
  const find: unknown = isRecord(runtime) ? runtime["getModel"] : undefined;
  if (typeof find !== "function") throw new Error("Fleet requires Pi's model runtime getModel()");
  const found: unknown = Reflect.apply(find, runtime, [provider, id]);
  return found;
}

function compactionModel(session: object, selected: unknown): unknown {
  const provider = stringField(selected, "provider");
  const id = stringField(selected, "id");
  if (provider === undefined || id === undefined) return selected;
  const wanted = compactorFor({ provider, id }, process.cwd(), process.env);
  const hit = firstAvailable(wanted, (model) => registered(session, model.provider, model.id));
  if (hit !== undefined) return hit.found;
  if (wanted.vertexOnly)
    throw new Error(
      `Fleet compaction: none of ${chainLabel(wanted)} is available, and this session must compact on Vertex`,
    );
  return selected;
}

export function applyCompactionPolicy(): void {
  once("compaction-model", () => {
    try {
      const summarize = methodOf(AgentSession.prototype, "_runDefaultCompaction");
      Reflect.set(
        AgentSession.prototype,
        "_runDefaultCompaction",
        function (this: object, preparation: unknown, model: unknown, ...rest: unknown[]) {
          return summarize(this, preparation, compactionModel(this, model), ...rest);
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Fleet compaction model: unavailable, Pi keeps the session model. ${reason}`);
    }
  });
}
