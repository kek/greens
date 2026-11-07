//// The EYG structural editor, embedded in the Greens web UI.
////
//// Editing is done by upstream's `morph` package, the same one behind the
//// editor on eyg.run. This module wires it into a small Lustre app: keyboard
//// commands, rendering, and type checking against the effects Greens offers,
//// so type errors in a bot show up while it is being written.

import eyg/analysis/type_/binding/debug
import eyg/ir/dag_json
import eyg/ir/tree as ir
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import greens_typecheck
import lustre
import lustre/attribute as a
import lustre/effect
import lustre/element
import lustre/element/html as h
import lustre/event
import morph/buffer
import morph/command
import morph/editable as e
import morph/input
import morph/lustre as morph_view
import morph/lustre/render
import morph/manipulation as m
import morph/navigation
import morph/picker

// ---- App -------------------------------------------------------------------

pub type Mode {
  Navigating(failure: Option(String))
  Manipulating(input: m.UserInput)
}

pub type State {
  State(selector: String, buffer: buffer.Buffer, mode: Mode, help: Bool)
}

pub type Message {
  UserPressedKey(key: String)
  UserClickedCode(path: List(Int))
  InputMessage(input.Message)
  PickerMessage(picker.Message)
}

/// Mount the editor on the element matching `selector`, editing the program
/// given as JSON IR. The element receives an `eyg-change` event, with the
/// new JSON IR as its detail, after every edit.
pub fn mount(selector: String, source: String) -> Bool {
  let app = lustre.application(init, update, view)
  case lustre.start(app, selector, #(selector, source)) {
    Ok(runtime) ->
      listen(selector, fn(key) {
        lustre.send(runtime, lustre.dispatch(UserPressedKey(key)))
      })
    Error(_) -> False
  }
}

fn init(flags: #(String, String)) {
  let #(selector, source) = flags
  let program =
    json.parse(source, dag_json.decoder(Nil))
    |> result.unwrap(ir.vacant())
  let projection =
    program
    |> e.from_annotated
    |> e.open_all
    |> navigation.first
  let buffer = buffer.from_projection(projection) |> greens_typecheck.check
  #(
    State(selector:, buffer:, mode: Navigating(None), help: False),
    effect.none(),
  )
}

fn update(state: State, message: Message) {
  case message, state.mode {
    UserClickedCode(path), _ ->
      case buffer.focus_at(state.buffer, path) {
        Ok(buffer) -> #(
          State(..state, buffer:, mode: Navigating(None)),
          refocus(state),
        )
        Error(_) -> #(state, refocus(state))
      }
    UserPressedKey(key), Navigating(_) -> key_pressed(state, key)
    UserPressedKey(_), Manipulating(_) -> #(state, effect.none())
    InputMessage(message), Manipulating(m.EnterInteger(value, rebuild)) ->
      case input.update_number(value, message) {
        input.Continue(new) -> #(
          State(..state, mode: Manipulating(m.EnterInteger(new, rebuild))),
          effect.none(),
        )
        input.Confirmed(value) -> changed(state, rebuild(value))
        input.Cancelled -> cancel(state)
      }
    InputMessage(message), Manipulating(m.EnterText(value, rebuild)) ->
      case input.update_text(value, message) {
        input.Continue(new) -> #(
          State(..state, mode: Manipulating(m.EnterText(new, rebuild))),
          effect.none(),
        )
        input.Confirmed(value) -> changed(state, rebuild(value))
        input.Cancelled -> cancel(state)
      }
    PickerMessage(message), Manipulating(m.PickSingle(_, rebuild)) ->
      case message {
        picker.Updated(picker:) -> #(
          State(..state, mode: Manipulating(m.PickSingle(picker, rebuild))),
          effect.none(),
        )
        picker.Decided(label) -> changed(state, rebuild(label))
        picker.Dismissed -> cancel(state)
      }
    _, _ -> #(state, effect.none())
  }
}

fn cancel(state: State) {
  #(State(..state, mode: Navigating(None)), refocus(state))
}

fn changed(state: State, buffer) {
  let buffer = greens_typecheck.check(buffer)
  let source = dag_json.to_string(buffer.source(buffer))
  let state = State(..state, buffer:, mode: Navigating(None))
  #(
    state,
    effect.batch([
      effect.from(fn(_) { emit(state.selector, source) }),
      refocus(state),
    ]),
  )
}

fn refocus(state: State) {
  effect.from(fn(_) { focus(state.selector) })
}

type Command {
  Navigate(fn(buffer.Buffer) -> Result(buffer.Buffer, Nil))
  Edit(m.Operation)
  ToggleHelp
}

/// Key bindings follow eyg.run. References, packages and the clipboard are
/// left out because Greens programs cannot use them.
fn bindings() -> List(#(String, String, Command)) {
  let effects = greens_typecheck.effects()
  [
    #("ArrowRight", "next", Navigate(buffer.next)),
    #("ArrowLeft", "previous", Navigate(buffer.previous)),
    #("ArrowUp", "up", Navigate(buffer.up)),
    #("ArrowDown", "down", Navigate(buffer.down)),
    #(" ", "next vacant", Navigate(buffer.next_vacant)),
    #("a", "grow selection", Navigate(buffer.increase)),
    #("k", "fold or unfold", Navigate(buffer.toggle_open)),
    #("e", "assign (let)", Edit(m.assign())),
    #("E", "assign before", Edit(m.assign_before())),
    #("v", "variable", Edit(m.insert_variable())),
    #("f", "function", Edit(m.insert_function())),
    #("c", "call", Edit(m.call_function())),
    #("C", "call with no arguments", Edit(m.call_once())),
    #("w", "call with", Edit(m.call_with())),
    #("n", "integer", Edit(m.insert_integer())),
    #("s", "string", Edit(m.insert_string())),
    #("b", "binary", Edit(m.insert_binary())),
    #("l", "list", Edit(m.create_list())),
    #("L", "empty list", Edit(m.create_empty_list())),
    #("x", "spread list", Edit(m.spread())),
    #("r", "record", Edit(m.create_record())),
    #("R", "empty record", Edit(m.create_empty_record())),
    #("g", "select field", Edit(m.select_field())),
    #("o", "overwrite field", Edit(m.overwrite())),
    #("t", "tag", Edit(m.insert_tag())),
    #("m", "match", Edit(m.insert_case())),
    #("p", "perform effect", Edit(m.perform(effects))),
    #("h", "handle effect", Edit(m.insert_handle(effects))),
    #("j", "builtin", Edit(m.insert_builtin())),
    #("i", "edit text or number", Edit(m.insert())),
    #("<", "insert before", Edit(m.insert_before())),
    #(">", "insert after", Edit(m.insert_after())),
    #("d", "delete", Edit(m.delete())),
    #("z", "undo", Edit(m.undo())),
    #("Z", "redo", Edit(m.redo())),
    #("?", "show or hide keys", ToggleHelp),
  ]
}

fn key_pressed(state: State, key) {
  let binding = list.find(bindings(), fn(b) { b.0 == key })
  case binding {
    Ok(#(_, name, Navigate(move))) ->
      case move(state.buffer) {
        Ok(buffer) -> #(
          State(..state, buffer:, mode: Navigating(None)),
          effect.none(),
        )
        Error(_) -> failed(state, name)
      }
    Ok(#(_, name, Edit(m.Operation(apply:, ..)))) ->
      case apply(state.buffer) {
        Ok(m.Resolved(buffer)) -> changed(state, buffer)
        Ok(m.UserInput(input)) -> #(
          State(..state, mode: Manipulating(input)),
          effect.from(fn(_) { focus_input(state.selector) }),
        )
        Error(Nil) -> failed(state, name)
      }
    Ok(#(_, _, ToggleHelp)) -> #(
      State(..state, help: !state.help, mode: Navigating(None)),
      effect.none(),
    )
    Error(Nil) -> #(
      State(
        ..state,
        mode: Navigating(Some(command.fail_message(command.NoKeyBinding(key)))),
      ),
      effect.none(),
    )
  }
}

fn failed(state: State, name) {
  let reason = command.fail_message(command.ActionFailed(name))
  #(State(..state, mode: Navigating(Some(reason))), effect.none())
}

// ---- View ------------------------------------------------------------------

fn view(state: State) {
  let State(buffer:, mode:, help:, ..) = state
  let errors = buffer.errors(buffer)
  h.div([a.class("eyg-editor")], [
    h.pre(
      [a.class("eyg-code language-eyg"), event.on("click", click_decoder())],
      [morph_view.projection(buffer.projection, render.Statements, errors)],
    ),
    h.div([a.class("eyg-status")], [status(mode, errors)]),
    case help {
      True -> help_view()
      False ->
        h.div([a.class("eyg-hint")], [
          h.text("Click the code to focus it, then press ? for the keys."),
        ])
    },
  ])
}

fn status(mode, errors: List(#(List(Int), _))) {
  case mode {
    Manipulating(m.EnterInteger(value, _)) ->
      input.render_number(value) |> element.map(InputMessage)
    Manipulating(m.EnterText(value, _)) ->
      input.render_text(value) |> element.map(InputMessage)
    Manipulating(m.PickSingle(picker, _)) ->
      picker.render(picker) |> element.map(PickerMessage)
    Manipulating(m.PickCid(picker, _)) ->
      picker.render(picker) |> element.map(PickerMessage)
    Manipulating(m.PickRelease(picker, _)) ->
      picker.render(picker) |> element.map(PickerMessage)
    Navigating(Some(failure)) ->
      h.div([a.class("eyg-failure")], [h.text(failure)])
    Navigating(None) ->
      case errors {
        [] -> h.div([a.class("eyg-ok")], [h.text("No type errors.")])
        _ ->
          h.ul(
            [a.class("eyg-errors")],
            list.map(errors, fn(error) {
              let #(path, reason) = error
              h.li([event.on_click(UserClickedCode(path))], [
                h.text(debug.pretty_reason(reason)),
              ])
            }),
          )
      }
  }
}

fn help_view() {
  h.dl(
    [a.class("eyg-keys")],
    list.flat_map(bindings(), fn(binding) {
      let #(key, name, _) = binding
      let key = case key {
        " " -> "Space"
        "ArrowRight" -> "→"
        "ArrowLeft" -> "←"
        "ArrowUp" -> "↑"
        "ArrowDown" -> "↓"
        _ -> key
      }
      [h.dt([], [h.kbd([], [h.text(key)])]), h.dd([], [h.text(name)])]
    }),
  )
}

// Rendered spans carry their reversed path in data-rev.
fn click_decoder() {
  let path = {
    use rev <- decode.subfield(["target", "dataset", "rev"], decode.string)
    let parsed = case rev {
      "" -> Ok([])
      _ -> string.split(rev, ",") |> list.try_map(int.parse)
    }
    case parsed {
      Ok(rev) -> decode.success(UserClickedCode(list.reverse(rev)))
      Error(_) -> decode.failure(UserClickedCode([]), "path")
    }
  }
  decode.one_of(path, [decode.success(UserClickedCode([]))])
}

// ---- FFI -------------------------------------------------------------------

@external(javascript, "./greens_editor_ffi.mjs", "listen")
fn listen(selector: String, handler: fn(String) -> Nil) -> Bool

@external(javascript, "./greens_editor_ffi.mjs", "focus")
fn focus(selector: String) -> Nil

@external(javascript, "./greens_editor_ffi.mjs", "focusInput")
fn focus_input(selector: String) -> Nil

@external(javascript, "./greens_editor_ffi.mjs", "emit")
fn emit(selector: String, json: String) -> Nil
