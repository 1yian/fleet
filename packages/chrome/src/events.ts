import Type from "typebox";

const TargetInfo = Type.Object({ targetId: Type.String(), type: Type.String() });
export const Created = Type.Object({ targetInfo: TargetInfo });
export const Destroyed = Type.Object({ targetId: Type.String() });
export const Attached = Type.Object({ sessionId: Type.String(), targetInfo: TargetInfo });
export const Detached = Type.Object({ sessionId: Type.String() });
export const ContextCreated = Type.Object({
  context: Type.Object({
    id: Type.Integer(),
    auxData: Type.Optional(Type.Object({ isDefault: Type.Optional(Type.Boolean()) })),
  }),
});
export const ContextDestroyed = Type.Object({ executionContextId: Type.Integer() });
export const Lifecycle = Type.Object({
  name: Type.Optional(Type.String()),
  frameId: Type.String(),
});
export const Bound = Type.Object({
  name: Type.String(),
  payload: Type.String(),
  executionContextId: Type.Integer(),
});
