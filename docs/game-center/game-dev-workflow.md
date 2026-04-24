# Concord Game Dev Workflow

**Status:** Proposed 2026-04-15 · completes "Game dev workflow design"
**Scope:** `concord-game-maker` + `concord-game-center`
**Depends on existing decision:** Blockly primary / Rete.js fallback from `docs/visual_code_editor_recommendation.md`

---

## 1. Goal

Define one end-to-end author workflow:

1. scaffold a game project
2. author logic visually
3. preview it live against a local Game Center runtime
4. package it
5. publish it into a Concord place's media store
6. launch/play it from Concord Game Center on any node
7. allow LLM assist without making the LLM the source of truth

---

## 2. Product split

### `concord-game-maker`
Authoring app. Standalone dev environment.

Owns:

- project creation
- asset import
- visual logic editing
- metadata editing
- packaging
- publish/export
- LLM assist tools

### `concord-game-center`
Runtime/player app.

Owns:

- game package install/load
- viewport + input runtime
- local preview host
- multiplayer session hosting/joining
- loading published packages from Concord places

### Why split

Authoring UI and runtime/player UI have different jobs. Keeping them separate avoids shipping editor chrome in the player and keeps the runtime lean.

---

## 3. Source-of-truth rule

**The canonical editable source is the project manifest + visual workspace files.**

Not generated code.

Because Blockly was accepted as primary, the workflow must stop pretending arbitrary TS/JS source will round-trip back into nodes cleanly. Generated JS/Python/etc. are build artifacts.

### Canonical project files

```text
my-game/
  concord.game.json           # manifest
  scenes/
    intro.scene.json
    tavern.scene.json
  logic/
    gameplay.workspace.json   # Blockly workspace
    dialogue.workspace.json
  assets/
    sprites/
    audio/
    fonts/
  generated/
    game.js                   # derived artifact
    game.py                   # optional derived artifact
  preview/
    seed-state.json
```

---

## 4. Package format

Use a simple zipped package with deterministic metadata.

### Extension

`.cgpkg` (`Concord Game Package`)

### Internal layout

```text
package/
  manifest.json
  logic/*.workspace.json
  scenes/*.scene.json
  assets/**
  generated/game.js
  checksums.json
```

### Manifest minimum shape

```json
{
  "schema_version": 1,
  "id": "com.concord.games.my-first-game",
  "title": "My First Game",
  "author": "@alice:concord",
  "entry_scene": "intro",
  "runtime": {
    "engine": "concord-game-center",
    "min_version": "0.1.0"
  },
  "capabilities": ["viewport_3d", "chat_input", "pointer", "hotkeys"],
  "assets": {
    "preload": ["sprites/player.png", "audio/theme.ogg"]
  }
}
```

---

## 5. Workflow

## 5.1 Scaffold

User opens Game Maker and chooses:

- Blank game
- Template: point-and-click
- Template: text adventure
- Template: board/card game
- Template: social/party game

Scaffold creates:

- manifest
- starter scenes
- starter Blockly workspace
- preview seed state

### Decision

Templates are first-class. Concord should bias toward shippable small games, not empty-canvas paralysis.

---

## 5.2 Author visually

Primary editor = Blockly DSL.

Author works in three linked panes:

1. **Scene/asset navigator**
2. **Visual logic editor**
3. **Inspector/properties panel**

### DSL shape

The editor should expose Concord/game-domain blocks, not generic coding blocks first.

Examples:

- `On player enters scene`
- `Show dialogue`
- `Move actor to marker`
- `Wait for chat command`
- `Broadcast state to all players`
- `Assign secret role`
- `Start voting round`

Purpose-built nodes later split into two families already called out in PLAN:

- point-and-click game nodes
- text-controlled game nodes

### Generated targets

Wave 1 generation target is **JavaScript runtime code**.

Optional later exporters:

- Python
- Lua
- Rust glue stubs

But runtime compatibility matters more than polyglot vanity. JS is the first target because Game Center runtime will already need it.

---

## 5.3 Live preview

Game Maker launches a **local Game Center preview instance** in dev mode.

### Preview contract

- hot-reload generated game artifact on save
- preserve editor -> preview session identity
- inspector shows runtime errors mapped back to workspace block IDs where possible
- optional second window/device join for multiplayer preview later

### Preview loop

1. author edits workspace
2. workspace serializes
3. generator emits runtime artifact
4. local preview instance reloads package
5. viewport updates
6. errors bounce back into editor diagnostics

This is the most important productivity loop in the whole system.

---

## 5.4 Package

When preview is acceptable, Game Maker runs **Build Package**.

Build step does:

- validate manifest
- verify referenced assets exist
- generate runtime artifact(s)
- freeze workspace + scenes + assets + manifest
- write checksums
- emit `.cgpkg`

### Build output classes

- **dev preview build** — fast, reload-friendly, unsigned
- **publish build** — immutable package intended for Concord place/media-store upload

---

## 5.5 Publish to Concord place

Publishing writes package into a Concord place's media store.

### Publish flow

1. user chooses target place/server
2. package uploads as a media artifact
3. manifest metadata indexed server-side
4. place receives a launchable game entry
5. Game Center instances in that place can install/open it

### Stored metadata

- package ID
- title
- version
- author
- icon/cover art
- capabilities
- checksum
- uploaded media URI

Publishing should feel like uploading a media item, not deploying a server.

---

## 5.6 Consume in Game Center

Game Center sees published packages and offers:

- install / cache locally
- launch in room
- host session
- invite participants

Runtime loads package manifest, assets, generated logic, then mounts engine elements from the roadmap:

- 3D-capable viewport
- chat text input
- viewport click input
- hotkey keyboard input

---

## 6. LLM assist model

LLMs are **assistive tools**, not canonical authors.

### Allowed LLM roles

- scaffold starter workspace from prompt
- generate block graphs from natural language scene descriptions
- suggest state-machine or dialogue structures
- explain runtime errors in plain language
- propose archetypes / role definitions / quest structures
- translate between friendly language and DSL blocks

### Disallowed LLM role

- becoming the only editable source of gameplay logic

Generated LLM output must land as:

- Blockly workspace proposal
- manifest diff
- scene JSON diff
- asset list suggestion

User reviews and accepts/rejects. The saved project files remain canonical.

### Provider model

Game Maker should support:

- Claude API
- Gemini API
- local Ollama

Provider selection belongs to project settings, not global magic.

---

## 7. Error model

Need two kinds of diagnostics:

### Author-time

- invalid block connection
- missing required scene/asset/variable
- unsupported export target

### Runtime preview

- generated runtime exception
- missing asset at load
- desync in multiplayer preview
- unsupported capability on current node

Errors should map back to editor context whenever possible:

- workspace block ID
- scene ID
- asset path
- manifest field

---

## 8. Networking / multiplayer stance

Do **not** make the first workflow depend on full decentralized mesh features.

First workflow assumes:

- local preview works offline on one machine
- published game can run inside stable Concord place context
- multiplayer session state can initially piggyback on Concord room/session plumbing

If richer sync is later needed, CRDT/state replication can extend the runtime. It is not a blocker for workflow design.

---

## 9. Versioning model

Every package has:

- stable package ID
- semantic version
- content checksum

### Rule

A published package version is immutable.

Editing the project after publish creates a new build/version. No silent in-place mutation of live game packages.

---

## 10. Minimal MVP slice

The first end-to-end shippable slice should be:

- one template-based project scaffold
- Blockly editor with a tiny DSL
- JS generation only
- local preview loop
- `.cgpkg` build
- upload into one Concord place
- launch in Game Center

Good candidate prototype: **a simple party/social game** or **basic point-and-click scene**.

Not chess first. Not full RPG first.

---

## 11. How this unblocks downstream plan items

### Unblocks: visual code editor base

Now defined as:

- Blockly DSL authoring
- generated code is derived
- no promise of arbitrary text<->visual round-trip in MVP

### Unblocks: purpose-built node families

Now split cleanly into:

- point-and-click node pack
- text/social/role-play node pack

### Unblocks: LLM integration layer

Now clearly an editor-side assist system with explicit outputs.

### Unblocks: Game Center runtime work

Now tied to concrete package/runtime requirements instead of abstract "some future game engine."

---

## 12. Explicit non-goals

Not part of the first workflow design:

- arbitrary TypeScript source import with perfect visual round-trip
- full Unreal/Unity competitor toolchain
- live collaborative editing in v1
- in-game economy/market system in v1
- cloud build farm
- full mod marketplace

---

## 13. Acceptance checklist

Game dev workflow design is complete when:

- [x] project scaffold path defined
- [x] canonical editable source defined
- [x] visual authoring workflow defined
- [x] preview loop defined
- [x] package format defined
- [x] publish path into Concord place/media store defined
- [x] Game Center consumption path defined
- [x] LLM assist role defined
- [x] MVP slice chosen

---

## 14. Next implementation order

1. scaffold manifest + workspace file format
2. Blockly editor shell
3. JS generator
4. local Game Center preview host
5. package builder
6. place/media-store publish flow
7. first prototype game
