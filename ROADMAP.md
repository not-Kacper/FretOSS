# FretOSS roadmap

## v2 Ideas (not yet planned for implementation)

These are **NOT** being built now. They are written down so future work has
context without scope-creeping into the current trainer.

- **Chord trainer:** recognize/prompt full chord shapes, not just single notes.
- **Scale trainer:** prompt scale degrees across the fretboard.
- **Improv builder:** live backing/drum machine with chord-change prompts
  during improvisation practice.
- **Adaptive hint ladder:** if the user can't find a target note after N
  attempts, progressively reveal intervals relative to a known reference note
  (e.g. "it's a third above the root") before revealing the note name outright.
- **Support for fretless/non-fretted instruments** (future instrument type).

### Keep generic, don't build yet

`src/audio/note-helpers.ts` stays instrument-agnostic (MIDI, pitch class,
`semitoneInterval`). That is the only current concession to the hint-ladder
idea. Do not add chord dictionaries, scale generators, backing tracks, or
hint UI until a later version actually schedules that work.
