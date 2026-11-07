// Bundle entry: exposes the editor to the viewer page as window.GreensEditor.
import { mount } from "./build/dev/javascript/greens_editor/greens_editor.mjs";

globalThis.GreensEditor = { mount };
