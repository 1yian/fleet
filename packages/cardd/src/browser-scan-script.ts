export const SCAN = `function (count, ...nodes) {
  const closed = new Map();
  for (let i = 0; i < count; i += 2) closed.set(nodes[i], nodes[i + 1]);
  const undrawn = new Set(nodes.slice(count));
  const rootOf = (el) => el.shadowRoot ?? closed.get(el) ?? null;
  const doc = this.ownerDocument ?? this;
  const view = doc.defaultView;
  const unescaped = (text) => text.replace(/\\\\([0-9a-fA-F]{1,6})\\s?|\\\\([\\s\\S])/g, (all, hex, char) => {
    if (hex === undefined) return char;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff ? "\\ufffd" : String.fromCodePoint(code);
  });
  const generated = (el, which) => {
    const style = view.getComputedStyle(el, which);
    if (style.display === "none") return "";
    return [...style.content.matchAll(/"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'/g)]
      .map((found) => unescaped(found[1] ?? found[2] ?? ""))
      .join("");
  };
  const styleOf = (el) => {
    try {
      return view.getComputedStyle(el);
    } catch (error) {
      return null;
    }
  };
  const boxed = (node) => {
    try {
      const range = doc.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
    } catch (error) {
      return true;
    }
  };
  const innerOf = (node) => (node.nodeType === 3 ? node.nodeValue : node.innerText) ?? "";
  const fields = ["INPUT", "TEXTAREA", "SELECT"];
  const views = [];
  const queue = [this];
  for (const parent of queue) {
    for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      for (const attribute of node.attributes) views.push(attribute.value);
      if (fields.includes(node.tagName)) views.push(node.value);
      if (node.tagName === "OPTION") views.push(node.text);
      queue.push(node);
      const root = rootOf(node);
      if (root === null) continue;
      queue.push(root);
      views.push([...root.childNodes].map(innerOf).join(""));
    }
  }
  const flat = (el) => {
    const root = rootOf(el);
    if (root !== null) return [...root.childNodes];
    return el.tagName === "SLOT" ? el.assignedNodes({ flatten: true }) : [...el.childNodes];
  };
  const text = [];
  const stack = [{ nodes: [...this.childNodes], at: 0, shown: true, visible: true, tail: "" }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.at >= top.nodes.length) {
      stack.pop();
      text.push(top.tail);
      continue;
    }
    const node = top.nodes[top.at];
    top.at += 1;
    if (node.nodeType === 3) {
      if (top.shown && top.visible && !undrawn.has(node) && boxed(node)) text.push(node.nodeValue ?? "");
    } else if (node.nodeType === 1) {
      const style = styleOf(node);
      const shown = top.shown && (style === null || style.display !== "none");
      const contents = shown && (style === null || style.contentVisibility !== "hidden");
      const visible = style === null || style.visibility === "visible";
      const drawn = contents && visible;
      text.push(drawn ? generated(node, "::before") : "");
      stack.push({ nodes: flat(node), at: 0, shown: contents, visible, tail: drawn ? generated(node, "::after") : "" });
    }
  }
  views.push(text.join(""));
  if (this.nodeType === 9) views.push(this.body?.innerText ?? "");
  return views;
}`;
