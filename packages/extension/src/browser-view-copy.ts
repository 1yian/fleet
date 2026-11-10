export const COPY_SCRIPT = `
let forgetting = 0;
function say(text, state) {
  copied.textContent = text;
  copied.title = text;
  copied.className = state;
  clearTimeout(forgetting);
  forgetting = setTimeout(() => { copied.textContent = ""; copied.title = ""; }, 5000);
}

function selection(target) {
  return ordered(async () => {
    const response = await fetch("/api/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? "the viewer could not read the selection");
    if (answer.text === null) throw new Error(answer.note ?? "nothing was copied");
    if (answer.text === "") throw Object.assign(new Error("nothing is selected"), { empty: true });
    return answer.text;
  });
}

async function write(read) {
  if (navigator.clipboard === undefined) throw new Error("this browser does not allow the viewer to write to the clipboard");
  if (typeof ClipboardItem === "undefined") {
    const text = await read;
    await navigator.clipboard.writeText(text);
    return text;
  }
  let text = "";
  const blob = read.then((value) => { text = value; return new Blob([value], { type: "text/plain" }); });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } catch (error) {
    await read;
    throw error;
  }
  return text;
}

async function copy() {
  if (selected === null) return;
  try {
    const text = await write(selection(selected));
    say("copied " + Array.from(text).length + " characters", "");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), error.empty === true ? "empty" : "failed");
  }
}
`;
