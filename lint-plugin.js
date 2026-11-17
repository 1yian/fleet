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

export default { meta: { name: "fleet" }, rules: { "no-comments": noComments } };
