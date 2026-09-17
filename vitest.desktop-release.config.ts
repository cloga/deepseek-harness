/** Ordinary Desktop release tests retain root settings but exclude transactions in every inline project. */
import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

const transactionFile = 'apps/desktop/tests/project-manager.spec.ts'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: base.test?.projects?.map((project) => {
      if (typeof project !== 'object' || project === null || !('test' in project)) {
        throw new Error('Desktop release collection requires reviewed inline Vitest projects')
      }
      return {
        ...project,
        test: { ...project.test, exclude: [...(project.test?.exclude ?? []), transactionFile] },
      }
    }),
  },
})
