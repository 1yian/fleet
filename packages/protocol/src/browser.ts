import Type, { type Static } from "typebox";

export const BrowserLaneName = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" });
export const BrowserLaneKey = Type.Object({ lane: BrowserLaneName });
export const BrowserLaneSchema = Type.Object({
  lane: BrowserLaneName,
  status: Type.Enum(["stopped", "starting", "ready", "failed"]),
  control: Type.Object({ kind: Type.Enum(["agent", "human"]) }),
  tabs: Type.Array(Type.Object({ id: Type.String(), title: Type.String() })),
  credentialStep: Type.Boolean(),
  captchaStep: Type.Boolean(),
  handoff: Type.Union([
    Type.Null(),
    Type.Object({
      reason: Type.String(),
      status: Type.Enum(["open", "done", "cancelled", "expired"]),
    }),
  ]),
});
export type BrowserLane = Static<typeof BrowserLaneSchema>;

export const BrowserStateSchema = Type.Object({
  snapshot: BrowserLaneSchema,
  activeTab: Type.Union([Type.String(), Type.Null()]),
  viewer: Type.Object({ controlling: Type.Boolean() }),
});
export type BrowserState = Static<typeof BrowserStateSchema>;

const Positive = Type.Number({ exclusiveMinimum: 0 });
export const BrowserFrameSchema = Type.Object({
  jpeg: Type.String(),
  meta: Type.Object({ targetId: Type.String(), deviceWidth: Positive, deviceHeight: Positive }),
});
export type BrowserFrame = Static<typeof BrowserFrameSchema>;

export const BrowserCommandSchema = Type.Union([
  Type.Object({ t: Type.Literal("control"), on: Type.Boolean() }),
  Type.Object({ t: Type.Literal("done") }),
  Type.Object({
    t: Type.Literal("tab"),
    action: Type.Literal("activate"),
    id: Type.String({ minLength: 1, maxLength: 64 }),
  }),
]);
export type BrowserCommand = Static<typeof BrowserCommandSchema>;
