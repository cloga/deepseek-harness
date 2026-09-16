import { expect, it } from 'vitest'
import { assertStandaloneDesktopHelper } from '../scripts/helper-standalone.ts'

it.each([
  'import "semver";',
  'import value from "semver";',
  'export { value } from "./chunk.mjs";',
  'import("./chunk.mjs");',
  'import(name);',
  'require("semver");',
  'require(name);',
  'require.resolve("semver");',
  'import "file:///outside.mjs";',
])('rejects a non-standalone helper reference: %s', (source) => {
  expect(() => { assertStandaloneDesktopHelper(source) }).toThrow(/nonbuiltin external/u)
})

it('allows only builtin module references and ignores text inside comments and strings', () => {
  expect(() => {
    assertStandaloneDesktopHelper(`
      import { createHash } from 'node:crypto';
      import fs from 'fs';
      export { join } from 'node:path';
      const value = "import 'semver'";
      // import './not-code.mjs'
      const events = require('events');
      await import('node:fs');
    `)
  }).not.toThrow()
})
