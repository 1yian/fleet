const typeLibraryReference = (comment) =>
  comment.type === "Line" && /^\/ <reference lib="[a-z.]+" \/>$/.test(comment.value);

const noComments = {
  meta: { type: "suggestion", messages: { comment: "Comments are not allowed in code." } },
  create: (context) => ({
    Program: () => {
      for (const comment of context.sourceCode.getAllComments()) {
        if (!typeLibraryReference(comment))
          context.report({ loc: comment.loc, messageId: "comment" });
      }
    },
  }),
};

const killByName = /\b(pkill|killall)\b/;

const noKillByName = {
  meta: {
    type: "problem",
    messages: {
      kill:
        "Never kill a process by name in e2e code: one host runs the live herdr server, the lanes, and other workers' tests, and a name match kills them all. " +
        "Stop only the lab session this test started, by its own --session name, or your own process by pid.",
    },
  },
  create: (context) => ({
    Literal: (node) => {
      if (typeof node.value === "string" && killByName.test(node.value))
        context.report({ node, messageId: "kill" });
    },
    TemplateElement: (node) => {
      if (killByName.test(node.value.raw)) context.report({ node, messageId: "kill" });
    },
  }),
};

export default {
  meta: { name: "fleet" },
  rules: { "no-comments": noComments, "no-kill-by-name": noKillByName },
};
