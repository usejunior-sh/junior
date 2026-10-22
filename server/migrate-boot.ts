// Imported first by the server and the CLI, so ~/.triage becomes ~/.junior
// before any module opens a database or writes into the folder.
import { migrateHome } from './migrate-home.js'
import { JUNIOR_DIR } from './state.js'

try {
  migrateHome(JUNIOR_DIR, (m) => console.error(m))
} catch (err) {
  console.error(`junior: ${(err as Error).message}`)
  process.exit(1)
}
