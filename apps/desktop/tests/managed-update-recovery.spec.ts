import { expect, it } from 'vitest'
import { managedUpdateRecoveryCommand } from '../src/managed-update-recovery.ts'

it('targets the installed Electron executable and quotes PowerShell metacharacters literally', () => {
  expect(managedUpdateRecoveryCommand("C:\\Program Files\\User's $Desktop`\\Desktop.exe"))
    .toBe("& 'C:\\Program Files\\User''s $Desktop`\\Desktop.exe' --recover-managed-update")
})
