//// Type checking for Greens bots, shared by the browser editor and by Node
//// (bundled as src/eyg/typecheck.js for the command line and the server).

import eyg/analysis/inference/levels_j/contextual as infer
import eyg/analysis/type_/binding/debug
import eyg/analysis/type_/isomorphic as t
import eyg/ir/dag_json
import gleam/int
import gleam/json
import gleam/list
import gleam/string
import morph/buffer
import morph/editable as e
import morph/navigation

/// The effects a Greens bot can perform, with the types of the value sent
/// (lift) and the value returned. These must match src/game/match.js.
pub fn effects() -> List(#(String, #(t.Type(Int), t.Type(Int)))) {
  let int = t.Integer
  let direction =
    t.union([
      #("North", t.unit),
      #("East", t.unit),
      #("South", t.unit),
      #("West", t.unit),
    ])
  let outcome = t.result(t.unit, t.String)
  let what =
    t.union([
      #("Wall", t.unit),
      #("Patch", t.record([#("amount", int)])),
      #("Ally", t.record([#("id", int), #("hp", int), #("energy", int)])),
      #("Enemy", t.record([#("hp", int)])),
    ])
  let me =
    t.record([
      #("id", int),
      #("x", int),
      #("y", int),
      #("hp", int),
      #("energy", int),
    ])
  let cell = t.record([#("x", int), #("y", int), #("what", what)])
  let view =
    t.record([
      #("tick", int),
      #("width", int),
      #("height", int),
      #("me", me),
      #("cells", t.List(cell)),
    ])
  [
    #("Look", #(t.unit, view)),
    #("Random", #(int, int)),
    #("Log", #(t.String, t.unit)),
    #("Move", #(direction, outcome)),
    #("Harvest", #(direction, outcome)),
    #("Attack", #(direction, outcome)),
    #("Split", #(direction, outcome)),
    #("Wait", #(t.unit, outcome)),
  ]
}

pub fn check(buffer) {
  buffer.check(buffer, infer.pure() |> infer.with_effects(effects()))
  |> resolve
}

// Greens programs cannot use references, so every lookup fails.
fn resolve(step) {
  case step {
    infer.Done(value) -> value
    infer.Lookup(resume:, ..) -> resolve(resume(Error(Nil)))
  }
}

/// Type errors in a program given as JSON IR, as "path: reason" strings,
/// where path lists child indices from the root. An empty list means the
/// program type checks.
pub fn type_errors(source: String) -> Result(List(String), String) {
  case json.parse(source, dag_json.decoder(Nil)) {
    Error(_) -> Error("not valid JSON IR")
    Ok(program) -> {
      let buffer =
        program
        |> e.from_annotated
        |> navigation.first
        |> buffer.from_projection
        |> check
      Ok(
        list.map(buffer.errors(buffer), fn(error) {
          let #(path, reason) = error
          string.join(list.map(path, int.to_string), ".")
          <> ": "
          <> debug.pretty_reason(reason)
        }),
      )
    }
  }
}
