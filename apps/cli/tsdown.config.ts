import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships its command and the profile lifecycle used by Desktop.
 * Both named entries are compiled from `lib/types` by the same source-bound
 * build; declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
