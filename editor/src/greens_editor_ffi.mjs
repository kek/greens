// Browser glue for the editor: keyboard capture, focus and change events.

const IGNORED = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Dead"]);
const ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Send keys pressed while the editor (not one of its text inputs) has focus.
export function listen(selector, handler) {
  const root = document.querySelector(selector);
  if (!root) return false;
  root.tabIndex = 0;
  root.addEventListener("keydown", (event) => {
    if (ENTRY.has(event.target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || IGNORED.has(event.key)) return;
    event.preventDefault();
    handler(event.key);
  });
  return true;
}

export function focus(selector) {
  // Wait for the render that removes any text input.
  requestAnimationFrame(() => document.querySelector(selector)?.focus({ preventScroll: true }));
}

// Focus the text box or picker the editor just opened.
export function focusInput(selector) {
  requestAnimationFrame(() => document.querySelector(selector)?.querySelector("input")?.focus());
}

// Tell the host page the program changed. `detail` is the program's JSON IR.
export function emit(selector, json) {
  document.querySelector(selector)?.dispatchEvent(new CustomEvent("eyg-change", { detail: json, bubbles: true }));
}
